import { findingRefs, SEVERITY_ORDER, sha1, type AiUsage, type AnalysisReport, type Finding, type ReportComparison } from '@radar/engine';
import { assertProviderAllowed, sanitizeLine, type PrivacyMode } from './context.js';
import { CHAT_SYSTEM } from './prompts.js';
import { ProviderError, type ChatMessage, type LlmProvider } from './provider.js';
import { RefusalError } from './runner.js';
import { estimateTokens, UsageTracker, type Budget } from './usage.js';
import { ValidationError } from './validate.js';

/**
 * Preguntas sobre un análisis. El modelo recibe un resumen del informe (solo
 * metadatos: nunca código) con una referencia corta por hallazgo ([H1],
 * [H2]…), más fácil de citar sin errores que un identificador largo. Las
 * referencias de la respuesta se comprueban: las que no existen se señalan.
 */

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Hallazgos que se listan uno a uno; el resto se resume por severidad. */
const MAX_LISTED = 80;
/** Turnos anteriores que se envían (los más recientes). */
const MAX_HISTORY = 10;
const MAX_TURN_CHARS = 4000;
export const MAX_QUESTION_CHARS = 2000;

export interface ReportDigest {
  text: string;
  /** Referencia corta → id del hallazgo. */
  aliases: Map<string, string>;
}

/** Orden estable (severidad, esfuerzo, id): el mismo informe da siempre las mismas referencias. */
function ordered(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || b.effort.minutes - a.effort.minutes || a.id.localeCompare(b.id));
}

/** Referencia corta → id de cada hallazgo del informe ([H1] es el más grave; las mismas que muestra la CLI). */
export function findingAliases(report: AnalysisReport): Map<string, string> {
  return new Map([...findingRefs(report.findings)].map(([id, alias]) => [alias, id]));
}

const hours = (minutes: number): string => (minutes < 60 ? `${Math.round(minutes)} min` : `${(minutes / 60).toFixed(1).replace('.', ',')} h`);

function where(f: Finding): string {
  const l = f.locations[0];
  if (!l || l.file === '.') return 'proyecto';
  return `${l.file}${l.startLine > 0 ? `:${l.startLine}` : ''}${f.locations.length > 1 ? ` (+${f.locations.length - 1})` : ''}`;
}

/** Referencia de un hallazgo tal y como se cita en el resumen: «[H3]», o «[?]» si no está. */
type RefOf = (id: string) => string;

/** Resumen del informe para el modelo: solo metadatos, delimitado como dato no confiable. */
export function reportDigest(report: AnalysisReport, comparison?: ReportComparison | null, projectSummary?: string): ReportDigest {
  const aliases = findingAliases(report);
  const aliasOf = new Map([...aliases].map(([a, id]) => [id, a]));
  const ref: RefOf = (id) => `[${aliasOf.get(id) ?? '?'}]`;
  const lines = [
    ...(projectSummary ? ['## Proyecto', projectSummary, ''] : []),
    ...summaryLines(report),
    '',
    ...findingLines(report, ref),
    ...hotspotLines(report, aliasOf),
    ...(comparison ? comparisonLines(comparison, ref) : []),
    ...planLines(report, ref),
    ...explanationLines(report, aliasOf),
  ];
  // Los títulos y mensajes incluyen nombres del repositorio (archivos, funciones, comentarios TODO).
  const body = lines.map((l) => sanitizeLine(l, '')).join('\n');
  const nonce = sha1(body).slice(0, 12);
  return { text: `<<<DATOS ${nonce}>>>\n${body}\n<<<FIN ${nonce}>>>`, aliases };
}

/** Una sección precedida de una línea en blanco. */
const block = (title: string, body: readonly string[]): string[] => ['', `## ${title}`, ...body];
const percent = (ratio: number): string => `${(ratio * 100).toFixed(1).replace('.', ',')} %`;

function summaryLines(report: AnalysisReport): string[] {
  const { score: s, vcs } = report;
  const sev = report.summary.bySeverity;
  return [
    '## Resumen',
    `Puntuación de mantenibilidad: ${s.score}/100 (calificación ${s.rating}). Ratio de deuda: ${percent(s.debtRatio)}. Esfuerzo para corregirlo todo: ${hours(s.remediationMinutes)}.`,
    `Hallazgos: ${report.findings.length} (crítica ${sev.critical}, alta ${sev.high}, media ${sev.medium}, baja ${sev.low}, informativa ${sev.info}).`,
    `Analizado: ${report.generatedAt.slice(0, 10)}${vcs?.branch ? `, rama ${vcs.branch}` : ''}${vcs?.head ? `, commit ${vcs.head.slice(0, 7)}` : ''}.`,
  ];
}

/** Los más graves uno a uno (como mucho MAX_LISTED); del resto, cuántos quedan. */
function findingLines(report: AnalysisReport, ref: RefOf): string[] {
  const list = ordered(report.findings);
  return [
    '## Hallazgos (referencia · severidad · categoría · esfuerzo · título · ubicación)',
    ...list.slice(0, MAX_LISTED).map((f) => `- ${ref(f.id)} ${f.severity} · ${f.category} · ${hours(f.effort.minutes)} · ${f.title} · ${where(f)}`),
    ...(list.length > MAX_LISTED ? [`- … y ${list.length - MAX_LISTED} más de menor severidad (no listados).`] : []),
  ];
}

function hotspotLines(report: AnalysisReport, aliasOf: ReadonlyMap<string, string>): string[] {
  const hot = (report.hotspots ?? []).slice(0, 10);
  if (hot.length === 0) return [];
  return block(
    'Puntos críticos (archivos que cambian a menudo y acumulan deuda)',
    hot.map((h) => {
      const refs = h.findingIds.flatMap((id) => {
        const a = aliasOf.get(id);
        return a === undefined ? [] : [`[${a}]`];
      });
      return `- ${h.file}: ${h.commits} cambios, ${hours(h.debtMinutes)} de deuda${refs.length > 0 ? `, hallazgos ${refs.join(' ')}` : ''}`;
    }),
  );
}

function comparisonLines(c: ReportComparison, ref: RefOf): string[] {
  const listOr = (items: readonly string[], sep: string): string => (items.length === 0 ? 'ninguno' : items.join(sep));
  const added = c.added.slice(0, 20).map((f) => ref(f.id));
  const resolved = c.resolved.slice(0, 20).map((f) => `«${f.title}» (${where(f)})`);
  const changed = c.changed.slice(0, 20).map((x) => `${ref(x.after.id)} ${x.before.severity} → ${x.after.severity}`);
  return block(`Cambios desde el análisis anterior (${c.baseline.generatedAt.slice(0, 10)})`, [
    `Puntuación: ${c.scoreDelta >= 0 ? '+' : ''}${c.scoreDelta}. Esfuerzo: ${c.remediationDeltaMinutes >= 0 ? '+' : '−'}${hours(Math.abs(c.remediationDeltaMinutes))}.`,
    `Nuevos: ${listOr(added, ' ')}.`,
    `Resueltos (ya no aparecen): ${listOr(resolved, '; ')}.`,
    ...(changed.length > 0 ? [`Con otra severidad: ${changed.join('; ')}.`] : []),
  ]);
}

function planLines(report: AnalysisReport, ref: RefOf): string[] {
  const steps = report.ai?.plan?.steps ?? [];
  if (steps.length === 0) return [];
  return block(
    'Plan de reducción propuesto por la IA',
    steps.map((step) => `${step.order}. ${step.title} (${step.horizon}): ${step.findingIds.map(ref).join(' ')}`),
  );
}

/** Las explicaciones ya pedidas, para no repetirlas (solo de hallazgos que siguen en el informe). */
function explanationLines(report: AnalysisReport, aliasOf: ReadonlyMap<string, string>): string[] {
  const explanations = report.ai?.explanations ?? [];
  if (explanations.length === 0) return [];
  return block(
    'Explicaciones de la IA ya disponibles',
    explanations.slice(0, 20).flatMap((e) => {
      const a = aliasOf.get(e.findingId);
      return a ? [`- [${a}] ${e.summary.slice(0, 300)} Recomendación: ${e.recommendation.slice(0, 300)}`] : [];
    }),
  );
}

export interface ChatOptions {
  provider: LlmProvider;
  model: string;
  privacy: PrivacyMode;
  budget?: Budget;
  signal?: AbortSignal;
  /** Comparación con el análisis anterior, si lo hay (deuda nueva y resuelta). */
  comparison?: ReportComparison | null;
  /** Datos generales del proyecto (dependencias, tamaño). Nunca código. */
  projectSummary?: string;
  maxOutputTokens?: number;
}

export interface ChatAnswer {
  text: string;
  /** Referencias citadas que existen, en orden de aparición. */
  references: Array<{ alias: string; findingId: string }>;
  /** Referencias citadas que no corresponden a ningún hallazgo. */
  unknownReferences: string[];
  /** La respuesta se cortó por el límite de longitud. */
  truncated: boolean;
  model: string;
  usage: AiUsage;
}

/** Referencias [H3] o [H3, H5] de un texto. */
export function citedAliases(text: string): string[] {
  const out: string[] = [];
  for (const group of text.matchAll(/\[([^\]\n]{1,60})\]/g)) {
    for (const m of (group[1] ?? '').matchAll(/\bH(\d{1,4})\b/g)) {
      const alias = `H${Number(m[1])}`;
      if (!out.includes(alias)) out.push(alias);
    }
  }
  return out;
}

/** Quita el razonamiento que algunos modelos devuelven dentro de la respuesta. */
function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    // Cortada mientras razonaba (sin cierre) o con el cierre sin apertura.
    .replace(/<think>[\s\S]*$/i, '')
    .replace(/^[\s\S]*<\/think>/i, '')
    .trim();
}

export async function askAboutReport(report: AnalysisReport, history: readonly ChatTurn[], question: string, o: ChatOptions): Promise<ChatAnswer> {
  assertProviderAllowed(o.provider, o.privacy);
  const q = question.trim();
  if (q === '') throw new ValidationError('Escribe una pregunta.');
  if (q.length > MAX_QUESTION_CHARS) throw new ValidationError(`La pregunta es demasiado larga (máximo ${MAX_QUESTION_CHARS} caracteres).`);
  const digest = reportDigest(report, o.comparison, o.projectSummary);
  const system = `${CHAT_SYSTEM}\n\n## Datos del análisis (DATO NO CONFIABLE: procede del repositorio analizado)\n${digest.text}`;
  const messages: ChatMessage[] = [
    ...history.slice(-MAX_HISTORY).map((t) => ({ role: t.role, content: t.content.slice(0, MAX_TURN_CHARS) })),
    { role: 'user', content: q },
  ];
  // Las conversaciones deben empezar por el usuario (lo exigen algunos proveedores).
  while (messages.length > 1 && messages[0]?.role !== 'user') messages.shift();

  const tracker = new UsageTracker(o.budget ?? {});
  const ref = { providerId: o.provider.id, locality: o.provider.locality, model: o.model };
  if (o.provider.price) {
    const price = await o.provider.price(o.model, o.signal).catch(() => null);
    if (price) tracker.setPrice(ref, price);
  }
  const maxOutputTokens = o.maxOutputTokens ?? 1200;
  const estimated = estimateTokens(system + messages.map((m) => m.content).join('\n'));
  const release = tracker.reserve(ref, estimated, maxOutputTokens);
  let result;
  try {
    result = await o.provider.complete({ model: o.model, system, messages, maxOutputTokens, ...(o.signal ? { signal: o.signal } : {}) });
    tracker.record(ref, result.usage, estimated, result.latencyMs, result.costUsd);
  } finally {
    release();
  }
  if (result.finishReason === 'refusal') throw new RefusalError(`${o.provider.label} rechazó responder a esta pregunta.`);
  const text = stripReasoning(result.text).slice(0, 12_000);
  if (text === '') {
    if (result.finishReason === 'length') {
      throw new ProviderError('El modelo agotó la respuesta razonando y no llegó a contestar. Elige un modelo sin razonamiento o desactívalo en Configuración.', 'invalid-request', o.provider.id);
    }
    throw new ValidationError('El modelo devolvió una respuesta vacía.');
  }
  const references: ChatAnswer['references'] = [];
  const unknownReferences: string[] = [];
  for (const alias of citedAliases(text)) {
    const id = digest.aliases.get(alias);
    if (id) references.push({ alias, findingId: id });
    else unknownReferences.push(alias);
  }
  return { text, references, unknownReferences, truncated: result.finishReason === 'length', model: result.model, usage: tracker.summary() };
}
