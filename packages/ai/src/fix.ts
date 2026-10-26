import { sha1, type AiFixProposal, type AnalysisReport, type DiffHunk, type Finding } from '@radar/engine';
import { AiResponseCache } from './cache.js';
import { assertProviderAllowed, buildFindingContext, OMITTED_LINE, PrivacyError, sanitizeLine, type FindingContext, type PrivacyMode, type SnippetRange } from './context.js';
import { applyEdits, buildHunks, EditError, formatPatch, splitLines, type FilePatch, type LineEdit } from './diff.js';
import { FIX_FORMAT_HINT, FIX_PROMPT_VERSION, FIX_SYSTEM } from './prompts.js';
import type { LlmProvider } from './provider.js';
import { askJson } from './runner.js';
import { FIX_SCHEMA, type RawFix } from './schemas.js';
import { projectSummary } from './tasks.js';
import { createLimiter, UsageTracker, type Budget } from './usage.js';
import { ValidationError } from './validate.js';

/**
 * Propuestas de corrección. El modelo indica qué rangos de líneas de los
 * fragmentos enviados sustituir y por qué texto; aquí se valida que esos
 * rangos existen en lo enviado, se restauran las líneas que el modelo no pudo
 * ver (secretos ocultos) y se calcula la diferencia contra el archivo real.
 * Nunca se escribe en el repositorio.
 */

/** Más código que para explicar: el modelo tiene que ver lo que va a cambiar. */
export const FIX_CONTEXT_LIMITS = { contextLines: 15, maxLinesPerLocation: 160, maxLocations: 3, maxChars: 24_000 };

const MAX_EDITS = 8;
const MAX_REPLACEMENT_LINES = 400;
const MAX_ITEMS = 8;

/** El hallazgo no admite una propuesta (sin código, o es un secreto). */
export class FixUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixUnavailableError';
  }
}

/** Por qué no se puede proponer una corrección para este hallazgo, o null si se puede. */
export function fixUnavailableReason(f: Finding): string | null {
  if (f.category === 'security') {
    return 'Para un posible secreto no se envía código a la IA. La corrección es siempre la misma: retirarlo del código, revocarlo (rotarlo) y leerlo de una variable de entorno o de un gestor de secretos.';
  }
  if (!f.locations.some((l) => l.file !== '.' && l.startLine > 0)) return 'El hallazgo es del proyecto en conjunto, no de unas líneas concretas: no hay código que corregir.';
  return null;
}

export interface FixOptions {
  provider: LlmProvider;
  model: string;
  /** Tiene que permitir enviar código: `local` o `fragmentos`. */
  privacy: PrivacyMode;
  readText: (relPath: string) => Promise<string | null>;
  cacheDir?: string | null;
  budget?: Budget;
  signal?: AbortSignal;
  now?: () => Date;
}

/** Contexto exacto que se enviaría para proponer la corrección (para mostrarlo antes de enviarlo). */
export async function fixContext(report: AnalysisReport, findingId: string, readText: FixOptions['readText'], privacy: 'local' | 'fragmentos' = 'fragmentos'): Promise<FindingContext> {
  const f = report.findings.find((x) => x.id === findingId);
  if (!f) throw new FixUnavailableError('Ese hallazgo no está en el análisis.');
  const reason = fixUnavailableReason(f);
  if (reason) throw new FixUnavailableError(reason);
  const summary = await projectSummary(report, readText);
  const ctx = await buildFindingContext(f, { readText, mode: privacy, projectSummary: summary, limits: FIX_CONTEXT_LIMITS });
  if (!ctx.includesCode) throw new FixUnavailableError('No se pudo leer el código del hallazgo (¿se movió o se borró el archivo?).');
  return ctx;
}

export async function proposeFix(report: AnalysisReport, findingId: string, o: FixOptions): Promise<AiFixProposal> {
  if (o.privacy === 'metadatos') {
    throw new PrivacyError('Proponer una corrección exige enviar el fragmento de código del hallazgo, y la privacidad elegida es «solo metadatos».');
  }
  assertProviderAllowed(o.provider, o.privacy);
  // Lo que se lee para el contexto es exactamente lo que se usa para calcular la diferencia.
  const texts = new Map<string, Promise<string | null>>();
  const readText = (rel: string): Promise<string | null> => {
    let p = texts.get(rel);
    if (!p) texts.set(rel, (p = o.readText(rel)));
    return p;
  };
  const ctx = await fixContext(report, findingId, readText, o.privacy);
  const sources = new Map<string, string>();
  for (const s of ctx.snippets) {
    const text = await readText(s.file);
    if (text !== null) sources.set(s.file, text);
  }

  const tracker = new UsageTracker(o.budget ?? {});
  if (o.provider.price) {
    const price = await o.provider.price(o.model, o.signal).catch(() => null);
    if (price) tracker.setPrice({ providerId: o.provider.id, locality: o.provider.locality, model: o.model }, price);
  }
  // Clave, saldo y cuota: un problema general da un mensaje claro antes de enviar nada.
  await o.provider.preflight?.({ models: [o.model], requests: 1 }, o.signal);

  const r = await askJson(
    { provider: o.provider, tracker, cache: new AiResponseCache(o.cacheDir ?? null), limit: createLimiter(1), ...(o.signal ? { signal: o.signal } : {}) },
    {
      model: o.model,
      system: FIX_SYSTEM,
      user: `${ctx.text}\n\n${FIX_FORMAT_HINT}\nEl id del hallazgo es "${findingId}".`,
      schema: FIX_SCHEMA,
      maxOutputTokens: 3000,
      cacheKey: [FIX_PROMPT_VERSION, o.privacy],
      validate: (d) => validateFix(d, findingId, ctx.snippets, sources),
    },
  );
  const v = r.value;
  return {
    findingId,
    applicable: v.applicable,
    summary: v.summary,
    hunks: v.files.flatMap((f) => f.hunks),
    patch: formatPatch(v.files),
    risks: v.risks,
    verification: v.verification,
    validationNotes: v.notes,
    baseHashes: Object.fromEntries([...sources].map(([file, text]) => [file, sha1(text)])),
    privacy: o.privacy,
    provider: o.provider.id,
    model: r.model,
    fromCache: r.fromCache,
    usage: tracker.summary(),
    createdAt: (o.now?.() ?? new Date()).toISOString(),
  };
}

export interface ValidatedFix {
  applicable: boolean;
  summary: string;
  files: FilePatch[];
  risks: string[];
  verification: string[];
  notes: string[];
}

const normalizePath = (p: string): string => p.trim().replace(/\\/g, '/').replace(/^\.\//, '');

function strings(v: unknown): string[] {
  return (Array.isArray(v) ? v : [])
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .map((x) => x.trim().slice(0, 500))
    .slice(0, MAX_ITEMS);
}

/**
 * Valida la respuesta contra lo que se envió y calcula la diferencia. Lanza
 * ValidationError si algo no cuadra (el modelo recibe el motivo y puede
 * corregirlo una vez).
 */
export function validateFix(data: unknown, findingId: string, snippets: readonly SnippetRange[], sources: ReadonlyMap<string, string>): ValidatedFix {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new ValidationError('La respuesta debe ser un objeto JSON.');
  const raw = data as Partial<RawFix>;
  if (typeof raw.id_hallazgo === 'string' && raw.id_hallazgo.trim() !== '' && raw.id_hallazgo.trim() !== findingId) {
    throw new ValidationError(`La respuesta es de otro hallazgo (${raw.id_hallazgo}).`);
  }
  if (typeof raw.aplicable !== 'boolean') throw new ValidationError('Falta "aplicable" (true o false).');
  const summary = typeof raw.resumen === 'string' ? raw.resumen.trim().slice(0, 2000) : '';
  if (summary === '') throw new ValidationError('El campo "resumen" está vacío.');
  const risks = strings(raw.riesgos);
  const verification = strings(raw.verificacion);
  const notes: string[] = [];
  if (!raw.aplicable) return { applicable: false, summary, files: [], risks, verification, notes };

  const changes = Array.isArray(raw.cambios) ? raw.cambios : [];
  if (changes.length === 0) throw new ValidationError('"aplicable" es true pero no hay ningún cambio en "cambios".');
  if (changes.length > MAX_EDITS) throw new ValidationError(`Demasiados cambios (${changes.length}); como mucho ${MAX_EDITS}.`);

  const byFile = new Map<string, LineEdit[]>();
  changes.forEach((c, i) => {
    const n = i + 1;
    if (typeof c !== 'object' || c === null) throw new ValidationError(`El cambio ${n} no es un objeto.`);
    const file = normalizePath(typeof c.archivo === 'string' ? c.archivo : '');
    const start = c.linea_inicio;
    const end = c.linea_fin;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) throw new ValidationError(`El cambio ${n} tiene un rango de líneas no válido (${String(start)}-${String(end)}).`);
    const ranges = snippets.filter((s) => s.file === file);
    if (ranges.length === 0) throw new ValidationError(`El cambio ${n} es de "${file}", que no es ninguno de los fragmentos enviados (${[...new Set(snippets.map((s) => s.file))].join(', ')}).`);
    if (!ranges.some((s) => start >= s.startLine && end <= s.endLine)) {
      throw new ValidationError(`El cambio ${n} (${file}:${start}-${end}) se sale del fragmento enviado (${ranges.map((s) => `${s.startLine}-${s.endLine}`).join(', ')}).`);
    }
    if (typeof c.reemplazo !== 'string') throw new ValidationError(`El cambio ${n} no tiene "reemplazo" de texto.`);
    const source = sources.get(file);
    if (source === undefined) throw new ValidationError(`No se pudo leer ${file}.`);
    const original = splitLines(source).lines.slice(start - 1, end);
    const lines = restoreHidden(stripLineNumbers(c.reemplazo, notes), original, file);
    if (lines.length > MAX_REPLACEMENT_LINES) throw new ValidationError(`El reemplazo del cambio ${n} es demasiado largo (${lines.length} líneas).`);
    if (lines.some((l) => l.trim() === OMITTED_LINE)) {
      throw new ValidationError(`El cambio ${n} copia una línea oculta ("${OMITTED_LINE}") fuera de su sitio: escribe la línea nueva completa, sin secretos.`);
    }
    if (original.some((l) => sanitizeLine(l, file) === OMITTED_LINE && !lines.includes(l))) {
      notes.push(`El cambio en ${file}:${start}-${end} afecta a una línea que no se envió a la IA (posible secreto): revísala con atención.`);
    }
    const list = byFile.get(file) ?? [];
    list.push({ startLine: start, endLine: end, replacement: lines.join('\n') });
    byFile.set(file, list);
  });

  const files: FilePatch[] = [];
  for (const [file, edits] of byFile) {
    const before = splitLines(sources.get(file) ?? '');
    let after;
    try {
      after = applyEdits(before, edits);
    } catch (err) {
      if (err instanceof EditError) throw new ValidationError(`${file}: ${err.message}`);
      throw err;
    }
    const hunks: DiffHunk[] = buildHunks(file, before, after);
    if (hunks.length > 0) files.push({ file, before, after, hunks });
  }
  if (files.length === 0) throw new ValidationError('"aplicable" es true, pero los cambios dejan el código exactamente igual.');
  return { applicable: true, summary, files, risks, verification, notes };
}

/** Si el modelo copió la numeración del fragmento ("  12 | código"), se quita. */
function stripLineNumbers(replacement: string, notes: string[]): string[] {
  const lines = replacement === '' ? [] : splitLines(replacement).lines;
  const numbered = /^ *\d+ \| ?/;
  const nonEmpty = lines.filter((l) => l.trim() !== '');
  if (nonEmpty.length > 0 && nonEmpty.every((l) => numbered.test(l))) {
    notes.push('Se quitaron los números de línea que el modelo copió en el reemplazo.');
    return lines.map((l) => l.replace(numbered, ''));
  }
  return lines;
}

/**
 * El modelo vio algunas líneas cambiadas (secretos ocultos, delimitadores
 * neutralizados). Si las copia sin tocarlas, se recupera la línea real para
 * que el parche no las cambie.
 */
function restoreHidden(lines: string[], original: readonly string[], file: string): string[] {
  const pool = original
    .map((line) => ({ line, seen: sanitizeLine(line, file), used: false }))
    .filter((p) => p.seen !== p.line);
  if (pool.length === 0) return lines;
  return lines.map((l) => {
    const hit = pool.find((p) => !p.used && p.seen.trim() === l.trim());
    if (!hit) return l;
    hit.used = true;
    return hit.line;
  });
}
