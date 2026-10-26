import path from 'node:path';
import { SEVERITY_ORDER, type AiExplanation, type AiPlan, type AiSection, type AnalysisReport, type Finding, type Severity } from '@radar/engine';
import { AiResponseCache } from './cache.js';
import { assertProviderAllowed, buildFindingContext, type ContextLimits, type PrivacyMode } from './context.js';
import { EXPLAIN_FORMAT_HINT, EXPLAIN_PROMPT_VERSION, EXPLAIN_SYSTEM, PLAN_FORMAT_HINT, PLAN_PROMPT_VERSION, PLAN_SYSTEM } from './prompts.js';
import type { LlmProvider } from './provider.js';
import { askJson, type RunnerDeps } from './runner.js';
import { EXPLANATION_SCHEMA, PLAN_SCHEMA } from './schemas.js';
import { BudgetExceededError, createLimiter, UsageTracker, type Budget } from './usage.js';
import { validateExplanation, validatePlan } from './validate.js';

export interface TriageOptions {
  limit?: number;
  minSeverity?: Severity;
}

/**
 * Solo lo que merece razonamiento adicional: severidad media o superior, o
 * confianza baja (necesita una segunda opinión). Primero los de archivos que
 * son puntos críticos, luego por severidad y esfuerzo. Nunca "uno por archivo".
 */
export function selectForAi(report: AnalysisReport, options: TriageOptions = {}): Finding[] {
  const { limit = 8, minSeverity = 'medium' } = options;
  const hotspotScore = new Map<string, number>();
  for (const h of report.hotspots ?? []) for (const id of h.findingIds) hotspotScore.set(id, Math.max(hotspotScore.get(id) ?? 0, h.score));
  return report.findings
    .filter((f) => f.severity !== 'info' && (SEVERITY_ORDER[f.severity] >= SEVERITY_ORDER[minSeverity] || f.confidence === 'low'))
    .sort(
      (a, b) =>
        (hotspotScore.get(b.id) ?? 0) - (hotspotScore.get(a.id) ?? 0) ||
        SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] ||
        b.effort.minutes - a.effort.minutes ||
        a.id.localeCompare(b.id),
    )
    .slice(0, limit);
}

/** Datos generales del proyecto para adaptar las recomendaciones (nunca código). */
export async function projectSummary(report: AnalysisReport, readText: (rel: string) => Promise<string | null>): Promise<string> {
  const lines = [`Tamaño: ${report.score.codeLines} líneas de código en ${report.stats.filesDiscovered} archivos.`];
  const pkg = await readText('package.json');
  if (pkg) {
    try {
      const m = JSON.parse(pkg) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps = Object.keys(m.dependencies ?? {}).slice(0, 25);
      const dev = Object.keys(m.devDependencies ?? {}).slice(0, 15);
      if (deps.length > 0) lines.push(`Dependencias: ${deps.join(', ')}.`);
      if (dev.length > 0) lines.push(`Herramientas de desarrollo: ${dev.join(', ')}.`);
    } catch {
      /* manifiesto inválido: ya lo informa el motor */
    }
  }
  const exts = new Map<string, number>();
  for (const f of report.findings) for (const l of f.locations) {
    const e = path.posix.extname(l.file);
    if (e) exts.set(e, (exts.get(e) ?? 0) + 1);
  }
  if (exts.size > 0) lines.push(`Extensiones con hallazgos: ${[...exts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([e]) => e).join(', ')}.`);
  return lines.join('\n');
}

export interface AiRunOptions {
  provider: LlmProvider;
  /** Modelo para explicar hallazgos y, si no se indica otro, para el plan. */
  model: string;
  planModel?: string;
  privacy: PrivacyMode;
  readText: (rel: string) => Promise<string | null>;
  cacheDir?: string | null;
  budget?: Budget;
  limit?: number;
  concurrency?: number;
  /** Generar el plan de reducción (por defecto sí). */
  plan?: boolean;
  contextLimits?: Partial<ContextLimits>;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Ejecuta la capa de IA sobre un informe: explica los hallazgos
 * seleccionados y propone un plan. Devuelve una sección aparte; los
 * hallazgos y su evidencia no se modifican.
 */
export async function runAi(report: AnalysisReport, o: AiRunOptions): Promise<AiSection> {
  assertProviderAllowed(o.provider, o.privacy);
  const tracker = new UsageTracker(o.budget ?? {});
  const deps: RunnerDeps = {
    provider: o.provider,
    tracker,
    cache: new AiResponseCache(o.cacheDir ?? null),
    limit: createLimiter(o.concurrency ?? (o.provider.locality === 'local' ? 1 : 4)),
    ...(o.signal ? { signal: o.signal } : {}),
  };
  const errors: AiSection['errors'] = [];
  // Precio publicado por el propio proveedor (si lo ofrece), para que el presupuesto se aplique antes de enviar.
  if (o.provider.price) {
    for (const model of new Set([o.model, o.planModel ?? o.model])) {
      const price = await o.provider.price(model, o.signal).catch(() => null);
      if (price) tracker.setPrice({ providerId: o.provider.id, locality: o.provider.locality, model }, price);
    }
  }
  const summary = await projectSummary(report, o.readText);
  const selected = selectForAi(report, o.limit !== undefined ? { limit: o.limit } : {});

  let budgetHit = false;
  let done = 0;
  const explanations = (
    await Promise.all(
      selected.map(async (f): Promise<AiExplanation | null> => {
        if (budgetHit) {
          errors.push({ findingId: f.id, message: 'No se explicó: presupuesto de IA agotado.' });
          return null;
        }
        try {
          const ctx = await buildFindingContext(f, { readText: o.readText, mode: o.privacy, projectSummary: summary, ...(o.contextLimits ? { limits: o.contextLimits } : {}) });
          const r = await askJson(deps, {
            model: o.model,
            system: EXPLAIN_SYSTEM,
            user: `${ctx.text}\n\n${EXPLAIN_FORMAT_HINT}\nEl id del hallazgo es "${f.id}".`,
            schema: EXPLANATION_SCHEMA,
            maxOutputTokens: 1200,
            cacheKey: [EXPLAIN_PROMPT_VERSION, o.privacy],
            validate: (d) => validateExplanation(d, f.id, ctx),
          });
          const v = r.value;
          return {
            findingId: f.id,
            summary: v.summary,
            rootCause: v.rootCause,
            recommendation: v.recommendation,
            claims: v.claims,
            confidence: v.confidence,
            insufficientInformation: v.insufficientInformation,
            validationNotes: v.notes,
            provider: o.provider.id,
            model: r.model,
            fromCache: r.fromCache,
          };
        } catch (err) {
          if (o.signal?.aborted) throw err;
          if (err instanceof BudgetExceededError) budgetHit = true;
          errors.push({ findingId: f.id, message: err instanceof Error ? err.message : String(err) });
          return null;
        } finally {
          o.onProgress?.(++done, selected.length + (o.plan === false ? 0 : 1));
        }
      }),
    )
  ).filter((e): e is AiExplanation => e !== null);

  let plan: AiPlan | undefined;
  if (o.plan !== false && !budgetHit) {
    try {
      plan = await buildPlan(report, explanations, deps, o.planModel ?? o.model, o.privacy, summary);
    } catch (err) {
      if (o.signal?.aborted) throw err;
      errors.push({ message: `No se pudo generar el plan: ${err instanceof Error ? err.message : String(err)}` });
    }
    o.onProgress?.(++done, selected.length + 1);
  }

  const order = new Map(selected.map((f, i) => [f.id, i]));
  explanations.sort((a, b) => (order.get(a.findingId) ?? 0) - (order.get(b.findingId) ?? 0));
  return { privacy: o.privacy, explanations, ...(plan ? { plan } : {}), usage: tracker.summary(), errors };
}

/** El plan solo usa metadatos (nunca código), así que es válido con cualquier privacidad. */
async function buildPlan(report: AnalysisReport, explanations: readonly AiExplanation[], deps: RunnerDeps, model: string, privacy: PrivacyMode, summary: string): Promise<AiPlan> {
  const candidates = report.findings.filter((f) => f.severity !== 'info').slice(0, 40);
  if (candidates.length === 0) throw new Error('No hay hallazgos que planificar.');
  const hot = new Map<string, number>();
  for (const h of report.hotspots ?? []) for (const id of h.findingIds) hot.set(id, Math.max(hot.get(id) ?? 0, h.score));
  const byId = new Map(explanations.map((e) => [e.findingId, e]));
  const list = candidates
    .map((f) => {
      const loc = f.locations[0];
      const parts = [`- id=${f.id} · ${f.severity} · confianza ${f.confidence} · ${f.category} · ~${f.effort.minutes} min · ${f.title}${loc ? ` (${loc.file})` : ''}`];
      if (hot.has(f.id)) parts.push(`  punto crítico: puntuación ${hot.get(f.id)}`);
      const e = byId.get(f.id);
      if (e) parts.push(`  análisis previo: ${e.summary.slice(0, 300)}`);
      return parts.join('\n');
    })
    .join('\n');
  const ids = new Set(candidates.map((f) => f.id));
  const r = await askJson(deps, {
    model,
    system: PLAN_SYSTEM,
    user: `## Proyecto\n${summary}\nPuntuación de mantenibilidad: ${report.score.score}/100 (${report.score.rating}).\n\n## Hallazgos\n${list}\n\n${PLAN_FORMAT_HINT}`,
    schema: PLAN_SCHEMA,
    maxOutputTokens: 2000,
    cacheKey: [PLAN_PROMPT_VERSION, privacy],
    validate: (d) => validatePlan(d, ids),
  });
  return { steps: r.value.steps, notes: r.value.notes, provider: deps.provider.id, model: r.model };
}
