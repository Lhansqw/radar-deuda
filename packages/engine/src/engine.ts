import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_FILE_ANALYZERS, DEFAULT_PROJECT_ANALYZERS } from './analyzers/index.js';
import { largeFileFinding, type SizeArtifact } from './analyzers/size.js';
import { AnalysisCache, defaultCacheDir } from './cache.js';
import { configHash, ENGINE_VERSION, resolveConfig, type ConfigOverrides } from './config.js';
import { discoverFiles, looksBinary, looksMinified } from './discovery.js';
import { computeScore } from './score.js';
import type {
  AnalysisConfig,
  AnalysisReport,
  AnalyzerError,
  Category,
  CoverageNote,
  FileAnalysisResult,
  FileAnalyzer,
  FileMeta,
  Finding,
  ProgressEvent,
  ProjectAnalyzer,
  Severity,
  SkippedFile,
} from './types.js';
import { mapWithConcurrency, sha1, sortFindings, splitLines } from './util.js';

export interface AnalyzeOptions {
  config?: ConfigOverrides;
  /** Directorio de caché; `null` la desactiva. Por defecto, el directorio de datos del usuario. */
  cacheDir?: string | null;
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
  fileAnalyzers?: readonly FileAnalyzer[];
  projectAnalyzers?: readonly ProjectAnalyzer[];
}

const keyOf = (a: FileAnalyzer): string => `${a.id}@${a.version}`;

/**
 * Punto de entrada del motor. No ejecuta código del repositorio, no lo
 * modifica y no hace peticiones de red: solo lee archivos.
 */
export async function analyzeRepository(rootInput: string, options: AnalyzeOptions = {}): Promise<AnalysisReport> {
  const started = performance.now();
  const cpuStart = process.cpuUsage();
  const { signal, onProgress } = options;
  const config = resolveConfig(options.config);
  const fileAnalyzers = options.fileAnalyzers ?? DEFAULT_FILE_ANALYZERS;
  const projectAnalyzers = options.projectAnalyzers ?? DEFAULT_PROJECT_ANALYZERS;

  onProgress?.({ phase: 'discovery', done: 0, total: 0 });
  const { root, files, skipped: discoverySkipped } = await discoverFiles(rootInput, config, signal);
  const skipped: SkippedFile[] = [...discoverySkipped];
  const errors: AnalyzerError[] = [];

  const cHash = configHash(config);
  const cacheDir = options.cacheDir === undefined ? defaultCacheDir() : options.cacheDir;
  const cache = cacheDir === null ? AnalysisCache.disabled(cHash) : await AnalysisCache.open(cacheDir, root, cHash);

  const findings: Finding[] = [];
  const artifacts = new Map<string, Map<string, unknown>>(fileAnalyzers.map((a) => [a.id, new Map()]));
  let cacheHits = 0;
  let analyzed = 0;
  let done = 0;
  const analyzedFiles: FileMeta[] = [];

  const collect = (analyzer: FileAnalyzer, meta: FileMeta, result: FileAnalysisResult): void => {
    findings.push(...result.findings);
    if (result.artifact !== undefined) artifacts.get(analyzer.id)?.set(meta.relPath, result.artifact);
  };

  await mapWithConcurrency(
    files,
    config.concurrency,
    async (meta) => {
      const applicable = fileAnalyzers.filter((a) => a.supports(meta));
      const outcome = await processFile(meta, applicable, config, cache, errors);
      if (outcome.status === 'skipped') {
        skipped.push({ relPath: meta.relPath, reason: outcome.reason });
        if (outcome.extraFinding) findings.push(outcome.extraFinding);
        if (outcome.codeLines !== undefined) artifacts.get('size')?.set(meta.relPath, { codeLines: outcome.codeLines } satisfies SizeArtifact);
      } else {
        for (const [analyzer, result] of outcome.results) collect(analyzer, meta, result);
        analyzedFiles.push(meta);
        if (outcome.fromCache) cacheHits++;
        else analyzed++;
      }
      done++;
      if (onProgress && (done % 25 === 0 || done === files.length)) {
        onProgress({ phase: 'files', done, total: files.length, file: meta.relPath });
      }
    },
    signal,
  );

  signal?.throwIfAborted();
  onProgress?.({ phase: 'cross-file', done: 0, total: 1 });

  const readText = async (rel: string): Promise<string | null> => {
    const abs = safeJoin(root, rel);
    if (!abs) return null;
    try {
      return await readFile(abs, 'utf8');
    } catch {
      return null;
    }
  };
  for (const analyzer of fileAnalyzers) {
    if (!analyzer.finalize) continue;
    try {
      const store = cache.finalizeStore(keyOf(analyzer));
      findings.push(...(await analyzer.finalize(artifacts.get(analyzer.id) ?? new Map(), config, { readText, store })));
    } catch (err) {
      errors.push({ analyzer: keyOf(analyzer), message: errorMessage(err) });
    }
  }

  signal?.throwIfAborted();
  onProgress?.({ phase: 'project', done: 0, total: projectAnalyzers.length });
  const ctx = {
    root,
    files: analyzedFiles.sort((a, b) => a.relPath.localeCompare(b.relPath)),
    config,
    readText,
    exists: async (rel: string): Promise<boolean> => {
      const abs = safeJoin(root, rel);
      if (!abs) return false;
      try {
        await access(abs);
        return true;
      } catch {
        return false;
      }
    },
  };
  for (const analyzer of projectAnalyzers) {
    try {
      findings.push(...(await analyzer.analyzeProject(ctx)));
    } catch (err) {
      errors.push({ analyzer: `${analyzer.id}@${analyzer.version}`, message: errorMessage(err) });
    }
  }

  cache.prune(new Set(files.map((f) => f.relPath)));
  try {
    await cache.save();
  } catch (err) {
    errors.push({ analyzer: 'cache', message: `No se pudo guardar la caché: ${errorMessage(err)}` });
  }

  let codeLines = 0;
  for (const art of artifacts.get('size')?.values() ?? []) codeLines += (art as SizeArtifact).codeLines;

  const testFiles = new Set(files.filter((f) => f.isTest).map((f) => f.relPath));
  const deduped = dedupeById(findings).map((f) => adjustForTestCode(f, testFiles));
  sortFindings(deduped);
  const cpu = process.cpuUsage(cpuStart);
  onProgress?.({ phase: 'done', done: files.length, total: files.length });

  return {
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    root,
    generatedAt: new Date().toISOString(),
    config,
    score: computeScore(deduped, codeLines),
    findings: deduped,
    summary: summarize(deduped),
    coverage: buildCoverage(files, skipped),
    errors,
    stats: {
      durationMs: Math.round(performance.now() - started),
      filesDiscovered: files.length,
      filesAnalyzed: analyzed,
      cacheHits,
      skipped: skipped.sort((a, b) => a.relPath.localeCompare(b.relPath)),
      cpuUserMs: Math.round(cpu.user / 1000),
      cpuSystemMs: Math.round(cpu.system / 1000),
      peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
    },
  };
}

type FileOutcome =
  | { status: 'ok'; results: Array<[FileAnalyzer, FileAnalysisResult]>; fromCache: boolean }
  | { status: 'skipped'; reason: SkippedFile['reason']; extraFinding?: Finding; codeLines?: number };

async function processFile(
  meta: FileMeta,
  analyzers: readonly FileAnalyzer[],
  config: AnalysisConfig,
  cache: AnalysisCache,
  errors: AnalyzerError[],
): Promise<FileOutcome> {
  // 1) Camino rápido: metadatos sin cambios → no se lee el archivo.
  const byMeta = analyzers.map((a) => cache.lookupByMeta(meta, keyOf(a)));
  if (byMeta.every((r) => r !== undefined)) {
    return { status: 'ok', results: analyzers.map((a, i) => [a, byMeta[i] as FileAnalysisResult]), fromCache: true };
  }

  let buf: Buffer;
  try {
    buf = await readFile(meta.absPath);
  } catch {
    return { status: 'skipped', reason: 'unreadable' };
  }
  if (looksBinary(buf)) return { status: 'skipped', reason: 'binary' };

  // 2) Demasiado grande para un análisis profundo: solo se mide.
  if (meta.size > config.maxFileSizeBytes) {
    // Conteo directo sobre los bytes: no se crea la cadena ni el array de líneas.
    let lines = 0;
    let totalLines = 1;
    let nonBlank = false;
    for (const byte of buf) {
      if (byte === 10) {
        totalLines++;
        if (nonBlank) lines++;
        nonBlank = false;
      } else if (byte !== 13 && byte !== 32 && byte !== 9) nonBlank = true;
    }
    if (nonBlank) lines++;
    const extra = meta.isCode
      ? largeFileFinding(meta.relPath, lines, totalLines, config.thresholds, `No se analizó en profundidad: supera el límite de ${Math.round(config.maxFileSizeBytes / 1024)} KB.`)
      : null;
    return { status: 'skipped', reason: 'too-large', ...(extra ? { extraFinding: extra } : {}), ...(meta.isCode ? { codeLines: lines } : {}) };
  }

  // 3) Mismo contenido que en la caché (p. ej. tras un checkout).
  const contentHash = sha1(buf);
  const results: Array<[FileAnalyzer, FileAnalysisResult]> = [];
  const pending: FileAnalyzer[] = [];
  for (const a of analyzers) {
    const hit = cache.lookupByHash(meta, contentHash, keyOf(a));
    if (hit) results.push([a, hit]);
    else pending.push(a);
  }
  if (pending.length === 0) return { status: 'ok', results, fromCache: true };

  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = splitLines(text);
  if (meta.isCode && looksMinified(lines, meta.size)) return { status: 'skipped', reason: 'minified' };

  const memoStore = new Map<string, unknown>();
  const input = {
    meta,
    contentHash,
    text,
    lines,
    memo<T>(key: string, create: () => T): T {
      if (!memoStore.has(key)) memoStore.set(key, create());
      return memoStore.get(key) as T;
    },
  };
  for (const analyzer of pending) {
    let result: FileAnalysisResult;
    try {
      result = analyzer.analyze(input, config);
    } catch (err) {
      errors.push({ analyzer: keyOf(analyzer), file: meta.relPath, message: errorMessage(err) });
      continue;
    }
    cache.store(meta, contentHash, keyOf(analyzer), result);
    results.push([analyzer, result]);
  }
  return { status: 'ok', results, fromCache: false };
}

/** Une una ruta relativa a la raíz y garantiza que el resultado no escapa de ella. */
export function safeJoin(root: string, rel: string): string | null {
  if (rel.includes('\0') || path.isAbsolute(rel)) return null;
  const abs = path.resolve(root, rel);
  const relBack = path.relative(root, abs);
  if (relBack.startsWith('..') || path.isAbsolute(relBack)) return null;
  return abs;
}

const TEST_ADJUSTED: ReadonlySet<Category> = new Set(['complexity', 'size', 'duplication']);
const DOWNGRADE: Record<Severity, Severity> = { critical: 'high', high: 'medium', medium: 'low', low: 'low', info: 'info' };

/**
 * El código de pruebas tolera más longitud y repetición (bloques describe/it,
 * datos de ejemplo). Se reduce un nivel la severidad, sin ocultar el hallazgo.
 * Devuelve una copia: los objetos de la caché no se modifican.
 */
function adjustForTestCode(f: Finding, testFiles: ReadonlySet<string>): Finding {
  if (!TEST_ADJUSTED.has(f.category) || f.locations.length === 0 || !f.locations.every((l) => testFiles.has(l.file))) return f;
  return { ...f, severity: DOWNGRADE[f.severity], message: `${f.message} (Código de pruebas: severidad reducida un nivel.)` };
}

function dedupeById(findings: Finding[]): Finding[] {
  const seen = new Map<string, Finding>();
  for (const f of findings) if (!seen.has(f.id)) seen.set(f.id, f);
  return [...seen.values()];
}

function summarize(findings: readonly Finding[]): AnalysisReport['summary'] {
  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const byCategory: Partial<Record<Category, number>> = {};
  for (const f of findings) {
    bySeverity[f.severity]++;
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
  }
  return { bySeverity, byCategory };
}

function buildCoverage(files: readonly FileMeta[], skipped: readonly SkippedFile[]): CoverageNote[] {
  const jsts = files.filter((f) => f.language === 'typescript' || f.language === 'javascript').length;
  const otherCode = files.filter((f) => f.isCode && f.language === 'other').length;
  const notes: CoverageNote[] = [
    { area: 'Complejidad y duplicación', status: jsts > 0 ? 'analyzed' : 'not-analyzed', detail: `${jsts} archivo(s) JS/TS analizados con la API del compilador de TypeScript.` },
    { area: 'Arquitectura', status: jsts > 0 ? 'partial' : 'not-analyzed', detail: 'Ciclos y acoplamiento según importaciones relativas. No se resuelven alias de tsconfig (paths) ni paquetes del monorepo.' },
    { area: 'Secretos', status: 'analyzed', detail: 'Patrones de formatos conocidos y asignaciones de alta entropía en todos los archivos de texto.' },
    { area: 'Dependencias', status: 'partial', detail: 'Higiene de manifiestos npm. Versiones desactualizadas y vulnerabilidades conocidas: pendiente (fase 6, requiere red).' },
    { area: 'Pruebas', status: 'partial', detail: 'Heurística por convención de nombres; no mide cobertura real.' },
    { area: 'Reglas de estilo y errores (ESLint/Semgrep)', status: 'not-analyzed', detail: 'Integración prevista en una fase posterior.' },
  ];
  if (otherCode > 0) {
    notes.push({ area: 'Otros lenguajes', status: 'partial', detail: `${otherCode} archivo(s) de otros lenguajes: solo tamaño, marcadores y secretos.` });
  }
  if (skipped.length > 0) {
    notes.push({ area: 'Archivos omitidos', status: 'partial', detail: `${skipped.length} archivo(s) omitidos (binarios, minificados, demasiado grandes o ilegibles). Ver stats.skipped.` });
  }
  return notes;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
