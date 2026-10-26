import path from 'node:path';
import { SEVERITY_ORDER, type AiExplanation, type AiPlan, type AiSection, type AnalysisReport, type Finding, type Severity } from '@radar/engine';
import { AiResponseCache } from './cache.js';
import { assertProviderAllowed, buildFindingContext, type ContextLimits, type PrivacyMode } from './context.js';
import { EXPLAIN_FORMAT_HINT, EXPLAIN_PROMPT_VERSION, EXPLAIN_SYSTEM, PLAN_FORMAT_HINT, PLAN_PROMPT_VERSION, PLAN_SYSTEM } from './prompts.js';
import { ProviderError, type LlmProvider, type ProviderErrorKind } from './provider.js';
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

/**
 * Errores que afectan a todas las consultas por igual (clave, saldo, cuota):
 * repetirlos por cada hallazgo solo gasta tiempo y cuota, así que detienen la IA.
 */
const FATAL: ReadonlySet<ProviderErrorKind> = new Set(['auth', 'quota', 'rate-limit']);

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
  // Se aborta al primer error fatal (o si el usuario cancela): las consultas pendientes no se envían.
  const stop = new AbortController();
  const signal = o.signal ? AbortSignal.any([o.signal, stop.signal]) : stop.signal;
  let fatal: ProviderError | null = null;
  let skipped = 0;
  // Se detecta en el propio proveedor (no al final de la consulta) para que la
  // siguiente tarea en cola vea la parada antes de enviar nada.
  const guarded: LlmProvider = {
    id: o.provider.id,
    label: o.provider.label,
    locality: o.provider.locality,
    complete: async (req) => {
      try {
        return await o.provider.complete(req);
      } catch (err) {
        if (!fatal && err instanceof ProviderError && FATAL.has(err.kind)) {
          fatal = err;
          stop.abort();
        }
        throw err;
      }
    },
  };
  const deps: RunnerDeps = {
    provider: guarded,
    tracker,
    cache: new AiResponseCache(o.cacheDir ?? null),
    limit: createLimiter(o.concurrency ?? (o.provider.locality === 'local' ? 1 : 4)),
    signal,
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
  // Clave, saldo y cuota antes de empezar: un problema general da un solo error, no uno por hallazgo.
  let notes: string[] = [];
  if (o.provider.preflight) {
    try {
      notes = await o.provider.preflight({ models: [...new Set([o.model, o.planModel ?? o.model])], requests: selected.length + (o.plan === false ? 0 : 1) }, o.signal);
    } catch (err) {
      if (o.signal?.aborted) throw err;
      // El análisis del motor sigue siendo válido: se informa del problema una sola vez.
      return { privacy: o.privacy, explanations: [], usage: tracker.summary(), errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  }

  let budgetHit = false;
  let done = 0;
  const explanations = (
    await Promise.all(
      selected.map(async (f): Promise<AiExplanation | null> => {
        if (budgetHit) {
          errors.push({ findingId: f.id, message: 'No se explicó: presupuesto de IA agotado.' });
          return null;
        }
        if (fatal) {
          skipped++;
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
          if (fatal) {
            // El error fatal (o la parada que provocó) se informa una sola vez al final.
            if (err !== fatal) skipped++;
            return null;
          }
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
  if (o.plan !== false && !budgetHit && !fatal) {
    try {
      plan = await buildPlan(report, explanations, deps, o.planModel ?? o.model, o.privacy, summary);
    } catch (err) {
      if (o.signal?.aborted) throw err;
      if (!fatal) errors.push({ message: `No se pudo generar el plan: ${err instanceof Error ? err.message : String(err)}` });
    }
    o.onProgress?.(++done, selected.length + 1);
  }
  if (fatal) {
    const stopped: ProviderError = fatal;
    const pending = skipped + (o.plan !== false && !plan ? 1 : 0);
    errors.unshift(
      { message: `${stopped.message} Se detuvo la IA para no repetir el error.` },
      ...(pending > 0 ? [{ message: `Quedaron sin hacer ${pending} consulta(s) (explicaciones${o.plan !== false && !plan ? ' y plan' : ''}).${o.cacheDir ? ' Las ya completadas se guardan en caché y no se repiten.' : ''}` }] : []),
    );
  }

  const order = new Map(selected.map((f, i) => [f.id, i]));
  explanations.sort((a, b) => (order.get(a.findingId) ?? 0) - (order.get(b.findingId) ?? 0));
  return { privacy: o.privacy, explanations, ...(plan ? { plan } : {}), usage: tracker.summary(), errors, ...(notes.length > 0 ? { notes } : {}) };
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
