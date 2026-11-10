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
  FileInput,
  FileMeta,
  Finding,
  ProgressEvent,
  ProjectAnalyzer,
  ProjectContext,
  Severity,
  SkippedFile,
} from './types.js';
import { errorMessage, mapWithConcurrency, sha1, sortFindings, splitLines } from './util.js';
import { translator, type Translate } from './i18n.js';

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
  const { root, files, skipped: discoverySkipped, radarignore } = await discoverFiles(rootInput, config, signal);

  const cHash = configHash(config);
  const cacheDir = options.cacheDir === undefined ? defaultCacheDir() : options.cacheDir;
  const cache = cacheDir === null ? AnalysisCache.disabled(cHash) : await AnalysisCache.open(cacheDir, root, cHash);
  const run: Run = {
    config,
    cache,
    ...(signal ? { signal } : {}),
    ...(onProgress ? { onProgress } : {}),
    findings: [],
    errors: [],
    skipped: [...discoverySkipped],
    artifacts: new Map(fileAnalyzers.map((a) => [a.id, new Map()])),
  };

  const counts = await analyzeFiles(run, files, fileAnalyzers);

  signal?.throwIfAborted();
  onProgress?.({ phase: 'cross-file', done: 0, total: 1 });
  const readText = repoReader(root);
  await runFinalizers(run, fileAnalyzers, readText);

  signal?.throwIfAborted();
  onProgress?.({ phase: 'project', done: 0, total: projectAnalyzers.length });
  const projectFiles = counts.analyzedFiles.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const extraCoverage = await runProjectAnalyzers(run, projectAnalyzers, { root, files: projectFiles, config, readText, exists: repoExists(root) }, radarignore);

  await saveCache(run, files);

  const testFiles = new Set(files.filter((f) => f.isTest).map((f) => f.relPath));
  const tr = translator(config.locale);
  const deduped = dedupeById(run.findings).map((f) => adjustForTestCode(f, testFiles, tr));
  sortFindings(deduped);
  const cpu = process.cpuUsage(cpuStart);
  onProgress?.({ phase: 'done', done: files.length, total: files.length });

  return {
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    root,
    generatedAt: new Date().toISOString(),
    config,
    score: computeScore(deduped, totalCodeLines(run.artifacts)),
    findings: deduped,
    summary: summarize(deduped),
    coverage: mergeCoverage(buildCoverage(files, run.skipped, tr), extraCoverage),
    errors: run.errors,
    stats: {
      durationMs: Math.round(performance.now() - started),
      filesDiscovered: files.length,
      filesAnalyzed: counts.analyzed,
      cacheHits: counts.cacheHits,
      skipped: run.skipped.sort((a, b) => a.relPath.localeCompare(b.relPath)),
      cpuUserMs: Math.round(cpu.user / 1000),
      cpuSystemMs: Math.round(cpu.system / 1000),
      peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
    },
  };
}

/** Lo que van acumulando las fases de un análisis. */
interface Run {
  config: AnalysisConfig;
  cache: AnalysisCache;
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
  findings: Finding[];
  errors: AnalyzerError[];
  skipped: SkippedFile[];
  /** Artefactos por analizador y archivo, para sus finalizadores. */
  artifacts: Map<string, Map<string, unknown>>;
}

/** Fase 1: cada archivo con los analizadores que lo admiten (o desde la caché). */
async function analyzeFiles(run: Run, files: readonly FileMeta[], fileAnalyzers: readonly FileAnalyzer[]): Promise<{ analyzedFiles: FileMeta[]; analyzed: number; cacheHits: number }> {
  const analyzedFiles: FileMeta[] = [];
  let analyzed = 0;
  let cacheHits = 0;
  let done = 0;
  await mapWithConcurrency(
    files,
    run.config.concurrency,
    async (meta) => {
      const applicable = fileAnalyzers.filter((a) => a.supports(meta));
      const outcome = await processFile(meta, applicable, run.config, run.cache, run.errors);
      if (outcome.status === 'skipped') {
        run.skipped.push({ relPath: meta.relPath, reason: outcome.reason });
        if (outcome.extraFinding) run.findings.push(outcome.extraFinding);
        if (outcome.codeLines !== undefined) run.artifacts.get('size')?.set(meta.relPath, { codeLines: outcome.codeLines } satisfies SizeArtifact);
      } else {
        for (const [analyzer, result] of outcome.results) {
          run.findings.push(...result.findings);
          if (result.artifact !== undefined) run.artifacts.get(analyzer.id)?.set(meta.relPath, result.artifact);
        }
        analyzedFiles.push(meta);
        if (outcome.fromCache) cacheHits++;
        else analyzed++;
      }
      done++;
      if (run.onProgress && (done % 25 === 0 || done === files.length)) {
        run.onProgress({ phase: 'files', done, total: files.length, file: meta.relPath });
      }
    },
    run.signal,
  );
  return { analyzedFiles, analyzed, cacheHits };
}

/** Fase 2: los analizadores que comparan archivos entre sí (p. ej. duplicación). */
async function runFinalizers(run: Run, fileAnalyzers: readonly FileAnalyzer[], readText: (rel: string) => Promise<string | null>): Promise<void> {
  for (const analyzer of fileAnalyzers) {
    if (!analyzer.finalize) continue;
    try {
      const store = run.cache.finalizeStore(keyOf(analyzer));
      run.findings.push(...(await analyzer.finalize(run.artifacts.get(analyzer.id) ?? new Map(), run.config, { readText, store })));
    } catch (err) {
      run.errors.push({ analyzer: keyOf(analyzer), message: errorMessage(err) });
    }
  }
}

/** Fase 3: los analizadores del proyecto entero (arquitectura, dependencias…). Devuelve sus notas de cobertura. */
async function runProjectAnalyzers(run: Run, projectAnalyzers: readonly ProjectAnalyzer[], ctx: ProjectContext, radarignore: number | null): Promise<CoverageNote[]> {
  const coverage: CoverageNote[] = [];
  if (radarignore !== null) {
    coverage.push({ area: 'Exclusiones', status: 'partial', detail: `.radarignore excluye ${radarignore} patrón(es): esos archivos no se analizan.` });
  }
  for (const analyzer of projectAnalyzers) {
    run.signal?.throwIfAborted();
    try {
      run.findings.push(...(await analyzer.analyzeProject(ctx)));
      coverage.push(...(analyzer.coverage?.() ?? []));
    } catch (err) {
      if (run.signal?.aborted) throw err;
      run.errors.push({ analyzer: `${analyzer.id}@${analyzer.version}`, message: errorMessage(err) });
    }
  }
  return coverage;
}

/** Guarda la caché sin los archivos que ya no existen; si falla, el análisis sigue siendo válido. */
async function saveCache(run: Run, files: readonly FileMeta[]): Promise<void> {
  run.cache.prune(new Set(files.map((f) => f.relPath)));
  try {
    await run.cache.save();
  } catch (err) {
    run.errors.push({ analyzer: 'cache', message: `No se pudo guardar la caché: ${errorMessage(err)}` });
  }
}

function totalCodeLines(artifacts: Run['artifacts']): number {
  let codeLines = 0;
  for (const art of artifacts.get('size')?.values() ?? []) codeLines += (art as SizeArtifact).codeLines;
  return codeLines;
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
  const byMeta = cachedByMeta(meta, analyzers, cache);
  if (byMeta) return { status: 'ok', results: byMeta, fromCache: true };

  const buf = await readFile(meta.absPath).catch(() => null);
  if (!buf) return { status: 'skipped', reason: 'unreadable' };
  if (looksBinary(buf)) return { status: 'skipped', reason: 'binary' };
  // 2) Demasiado grande para un análisis profundo: solo se mide.
  if (meta.size > config.maxFileSizeBytes) return tooLarge(meta, buf, config);

  // 3) Mismo contenido que en la caché (p. ej. tras un checkout).
  const contentHash = sha1(buf);
  const { results, pending } = cachedByHash(meta, contentHash, analyzers, cache);
  if (pending.length === 0) return { status: 'ok', results, fromCache: true };
  await Promise.all(pending.map((a) => a.prepare?.()));

  // 4) Análisis de lo que falta.
  const text = decodeUtf8(buf);
  const lines = splitLines(text);
  if (meta.isCode && looksMinified(lines, meta.size)) return { status: 'skipped', reason: 'minified' };
  const input = fileInput(meta, contentHash, text, lines);
  for (const analyzer of pending) {
    const result = runAnalyzer(analyzer, input, config, errors);
    if (!result) continue;
    cache.store(meta, contentHash, keyOf(analyzer), result);
    results.push([analyzer, result]);
  }
  return { status: 'ok', results, fromCache: false };
}

type AnalyzerResults = Array<[FileAnalyzer, FileAnalysisResult]>;

/** Los resultados de todos los analizadores si los metadatos del archivo no cambiaron; si falta alguno, null. */
function cachedByMeta(meta: FileMeta, analyzers: readonly FileAnalyzer[], cache: AnalysisCache): AnalyzerResults | null {
  const results: AnalyzerResults = [];
  for (const a of analyzers) {
    const hit = cache.lookupByMeta(meta, keyOf(a));
    if (hit === undefined) return null;
    results.push([a, hit]);
  }
  return results;
}

/** Lo que ya está en la caché para este contenido y los analizadores que faltan. */
function cachedByHash(meta: FileMeta, contentHash: string, analyzers: readonly FileAnalyzer[], cache: AnalysisCache): { results: AnalyzerResults; pending: FileAnalyzer[] } {
  const results: AnalyzerResults = [];
  const pending: FileAnalyzer[] = [];
  for (const a of analyzers) {
    const hit = cache.lookupByHash(meta, contentHash, keyOf(a));
    if (hit) results.push([a, hit]);
    else pending.push(a);
  }
  return { results, pending };
}

/** Un archivo demasiado grande se mide (y, si es código, se señala) sin analizarlo. */
function tooLarge(meta: FileMeta, buf: Buffer, config: AnalysisConfig): FileOutcome {
  if (!meta.isCode) return { status: 'skipped', reason: 'too-large' };
  const { codeLines, totalLines } = countLines(buf);
  const tr = translator(config.locale);
  const kb = Math.round(config.maxFileSizeBytes / 1024);
  const note = tr(`No se analizó en profundidad: supera el límite de ${kb} KB.`, `Not analyzed in depth: it exceeds the ${kb} KB limit.`);
  const extra = largeFileFinding(meta.relPath, codeLines, totalLines, config.thresholds, note, tr);
  return { status: 'skipped', reason: 'too-large', ...(extra ? { extraFinding: extra } : {}), codeLines };
}

/** Líneas con contenido y líneas totales, contando sobre los bytes: sin crear la cadena ni el array de líneas. */
function countLines(buf: Uint8Array): { codeLines: number; totalLines: number } {
  let codeLines = 0;
  let totalLines = 1;
  let nonBlank = false;
  for (const byte of buf) {
    if (byte === 10) {
      totalLines++;
      if (nonBlank) codeLines++;
      nonBlank = false;
    } else if (byte !== 13 && byte !== 32 && byte !== 9) nonBlank = true;
  }
  if (nonBlank) codeLines++;
  return { codeLines, totalLines };
}

/** Texto UTF-8 sin la marca de orden de bytes. */
function decodeUtf8(buf: Buffer): string {
  const text = buf.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Entrada común a los analizadores, con una memoria para compartir el árbol sintáctico y otros cálculos. */
function fileInput(meta: FileMeta, contentHash: string, text: string, lines: string[]): FileInput {
  const memoStore = new Map<string, unknown>();
  return {
    meta,
    contentHash,
    text,
    lines,
    memo<T>(key: string, create: () => T): T {
      if (!memoStore.has(key)) memoStore.set(key, create());
      return memoStore.get(key) as T;
    },
  };
}

/** El fallo de un analizador se registra y no impide los demás. */
function runAnalyzer(analyzer: FileAnalyzer, input: FileInput, config: AnalysisConfig, errors: AnalyzerError[]): FileAnalysisResult | null {
  try {
    return analyzer.analyze(input, config);
  } catch (err) {
    errors.push({ analyzer: keyOf(analyzer), file: input.meta.relPath, message: errorMessage(err) });
    return null;
  }
}

/** Une una ruta relativa a la raíz y garantiza que el resultado no escapa de ella. */
/** Lee archivos de `root` (UTF-8) sin salir de la carpeta; null si la ruta sale de ella o no se puede leer. */
export function repoReader(root: string): (rel: string) => Promise<string | null> {
  return async (rel) => {
    const abs = safeJoin(root, rel);
    return abs ? readFile(abs, 'utf8').catch(() => null) : null;
  };
}

/** Si existe un archivo o carpeta dentro de `root` (false si la ruta sale de ella). */
export function repoExists(root: string): (rel: string) => Promise<boolean> {
  return async (rel) => {
    const abs = safeJoin(root, rel);
    return abs ? access(abs).then(() => true, () => false) : false;
  };
}

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
function adjustForTestCode(f: Finding, testFiles: ReadonlySet<string>, tr: Translate): Finding {
  if (!TEST_ADJUSTED.has(f.category) || f.locations.length === 0 || !f.locations.every((l) => testFiles.has(l.file))) return f;
  return { ...f, severity: DOWNGRADE[f.severity], message: `${f.message} ${tr('(Código de pruebas: severidad reducida un nivel.)', '(Test code: severity lowered one level.)')}` };
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

function buildCoverage(files: readonly FileMeta[], skipped: readonly SkippedFile[], tr: Translate): CoverageNote[] {
  const jsts = files.filter((f) => f.language === 'typescript' || f.language === 'javascript').length;
  const otherCode = files.filter((f) => f.isCode && f.language === 'other').length;
  const notes: CoverageNote[] = [
    {
      area: tr('Complejidad y duplicación', 'Complexity and duplication'),
      status: jsts > 0 ? 'analyzed' : 'not-analyzed',
      detail: tr(`${jsts} archivo(s) JS/TS analizados con la API del compilador de TypeScript.`, `${jsts} JS/TS file(s) analyzed with the TypeScript compiler API.`),
    },
    {
      area: tr('Arquitectura', 'Architecture'),
      status: jsts > 0 ? 'partial' : 'not-analyzed',
      detail: tr(
        'Ciclos y acoplamiento según importaciones relativas. No se resuelven alias de tsconfig (paths) ni paquetes del monorepo.',
        'Cycles and coupling based on relative imports. tsconfig aliases (paths) and monorepo packages are not resolved.',
      ),
    },
    {
      area: tr('Secretos', 'Secrets'),
      status: 'analyzed',
      detail: tr('Patrones de formatos conocidos y asignaciones de alta entropía en todos los archivos de texto.', 'Known format patterns and high-entropy assignments in all text files.'),
    },
    {
      area: tr('Dependencias', 'Dependencies'),
      status: 'partial',
      detail: tr(
        'Higiene de manifiestos npm. Para vulnerabilidades conocidas y versiones desactualizadas ejecuta con --online.',
        'npm manifest hygiene. For known vulnerabilities and outdated versions, run with online lookups.',
      ),
    },
    { area: tr('Pruebas', 'Tests'), status: 'partial', detail: tr('Heurística por convención de nombres; no mide cobertura real.', 'Naming-convention heuristic; it does not measure real coverage.') },
    { area: tr('Reglas de estilo y errores (ESLint/Semgrep)', 'Style and error rules (ESLint/Semgrep)'), status: 'not-analyzed', detail: tr('Integración prevista en una fase posterior.', 'Integration planned for a later phase.') },
  ];
  if (otherCode > 0) {
    notes.push({
      area: tr('Otros lenguajes', 'Other languages'),
      status: 'partial',
      detail: tr(`${otherCode} archivo(s) de otros lenguajes: solo tamaño, marcadores y secretos.`, `${otherCode} file(s) in other languages: only size, markers and secrets.`),
    });
  }
  if (skipped.length > 0) {
    notes.push({
      area: tr('Archivos omitidos', 'Skipped files'),
      status: 'partial',
      detail: tr(
        `${skipped.length} archivo(s) omitidos (binarios, minificados, demasiado grandes o ilegibles). Ver stats.skipped.`,
        `${skipped.length} file(s) skipped (binary, minified, too large or unreadable). See stats.skipped.`,
      ),
    });
  }
  return notes;
}

/** Las notas de los analizadores sustituyen a las del motor con la misma área. */
function mergeCoverage(base: CoverageNote[], extra: readonly CoverageNote[]): CoverageNote[] {
  const out = [...base];
  for (const note of extra) {
    const i = out.findIndex((n) => n.area === note.area);
    if (i >= 0) out[i] = note;
    else out.push(note);
  }
  return out;
}

