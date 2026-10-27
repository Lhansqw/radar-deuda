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
  /** Explicar exactamente estos hallazgos (en este orden) en lugar de seleccionarlos. */
  findingIds?: string[];
  contextLimits?: Partial<ContextLimits>;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Ejecuta la capa de IA sobre un informe: explica los hallazgos
 * seleccionados y propone un plan. Devuelve una sección aparte; los
 * hallazgos y su evidencia no se modifican.
 */
export async function runAi(report: AnalysisReport, o: AiRunOptions): Promise<AiSection> {
  assertProviderAllowed(o.provider, o.privacy);
  const run = new AiRun(report, o);
  await run.loadPrices();
  const summary = await projectSummary(report, o.readText);
  const selected = selectFindings(report, o);
  const failed = await run.preflight(selected.length);
  if (failed) return failed;
  const explanations = await run.explainAll(selected, summary);
  const plan = await run.plan(explanations, summary);
  return run.result(selected, explanations, plan);
}

/** Hallazgos concretos (p. ej. «explicar este» desde la aplicación) o la selección habitual. */
function selectFindings(report: AnalysisReport, o: AiRunOptions): Finding[] {
  if (!o.findingIds) return selectForAi(report, o.limit !== undefined ? { limit: o.limit } : {});
  const byId = new Map(report.findings.map((f) => [f.id, f]));
  return o.findingIds.map((id) => byId.get(id)).filter((f): f is Finding => f !== undefined);
}

/** Para todo al primer error fatal (o si el usuario cancela): las consultas pendientes no se envían. */
class FatalStop {
  error: ProviderError | null = null;
  readonly signal: AbortSignal;
  private readonly stop = new AbortController();

  constructor(outer: AbortSignal | undefined) {
    this.signal = outer ? AbortSignal.any([outer, this.stop.signal]) : this.stop.signal;
  }

  /**
   * Se detecta en el propio proveedor (no al final de la consulta) para que la
   * siguiente tarea en cola vea la parada antes de enviar nada.
   */
  guard(provider: LlmProvider): LlmProvider {
    return {
      id: provider.id,
      label: provider.label,
      locality: provider.locality,
      complete: async (req) => {
        try {
          return await provider.complete(req);
        } catch (err) {
          this.observe(err);
          throw err;
        }
      },
    };
  }

  private observe(err: unknown): void {
    if (this.error || !(err instanceof ProviderError) || !FATAL.has(err.kind)) return;
    this.error = err;
    this.stop.abort();
  }
}

/** Estado de una ejecución: errores, presupuesto, parada y progreso. */
class AiRun {
  private readonly report: AnalysisReport;
  private readonly o: AiRunOptions;
  private readonly tracker: UsageTracker;
  private readonly fatal: FatalStop;
  private readonly deps: RunnerDeps;
  private readonly errors: AiSection['errors'] = [];
  private notes: string[] = [];
  private budgetHit = false;
  /** Consultas que no se enviaron por un error fatal. */
  private skipped = 0;
  private done = 0;
  private total = 0;

  constructor(report: AnalysisReport, o: AiRunOptions) {
    this.report = report;
    this.o = o;
    this.tracker = new UsageTracker(o.budget ?? {});
    this.fatal = new FatalStop(o.signal);
    this.deps = {
      provider: this.fatal.guard(o.provider),
      tracker: this.tracker,
      cache: new AiResponseCache(o.cacheDir ?? null),
      limit: createLimiter(o.concurrency ?? (o.provider.locality === 'local' ? 1 : 4)),
      signal: this.fatal.signal,
    };
  }

  private get wantsPlan(): boolean {
    return this.o.plan !== false;
  }

  private get models(): string[] {
    return [...new Set([this.o.model, this.o.planModel ?? this.o.model])];
  }

  /** Precio publicado por el propio proveedor (si lo ofrece), para que el presupuesto se aplique antes de enviar. */
  async loadPrices(): Promise<void> {
    const { provider, signal } = this.o;
    if (!provider.price) return;
    for (const model of this.models) {
      const price = await provider.price(model, signal).catch(() => null);
      if (price) this.tracker.setPrice({ providerId: provider.id, locality: provider.locality, model }, price);
    }
  }

  /**
   * Clave, saldo y cuota antes de empezar: un problema general da un solo
   * error, no uno por hallazgo. Si falla, devuelve ya la sección con ese error
   * (el análisis del motor sigue siendo válido).
   */
  async preflight(explanations: number): Promise<AiSection | null> {
    this.total = explanations + (this.wantsPlan ? 1 : 0);
    if (!this.o.provider.preflight) return null;
    try {
      this.notes = await this.o.provider.preflight({ models: this.models, requests: this.total }, this.o.signal);
      return null;
    } catch (err) {
      if (this.o.signal?.aborted) throw err;
      return { privacy: this.o.privacy, explanations: [], usage: this.tracker.summary(), errors: [{ message: message(err) }] };
    }
  }

  async explainAll(selected: readonly Finding[], summary: string): Promise<AiExplanation[]> {
    const results = await Promise.all(selected.map((f) => this.explainSafely(f, summary)));
    return results.filter((e): e is AiExplanation => e !== null);
  }

  private async explainSafely(f: Finding, summary: string): Promise<AiExplanation | null> {
    if (this.budgetHit) {
      this.errors.push({ findingId: f.id, message: 'No se explicó: presupuesto de IA agotado.' });
      return null;
    }
    if (this.fatal.error) {
      this.skipped++;
      return null;
    }
    try {
      return await this.explain(f, summary);
    } catch (err) {
      this.explainFailed(err, f.id);
      return null;
    } finally {
      this.progress();
    }
  }

  private async explain(f: Finding, summary: string): Promise<AiExplanation> {
    const { o } = this;
    const ctx = await buildFindingContext(f, { readText: o.readText, mode: o.privacy, projectSummary: summary, ...(o.contextLimits ? { limits: o.contextLimits } : {}) });
    const r = await askJson(this.deps, {
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
  }

  private explainFailed(err: unknown, findingId: string): void {
    if (this.o.signal?.aborted) throw err;
    if (this.fatal.error) {
      // El error fatal (o la parada que provocó) se informa una sola vez al final.
      if (err !== this.fatal.error) this.skipped++;
      return;
    }
    if (err instanceof BudgetExceededError) this.budgetHit = true;
    this.errors.push({ findingId, message: message(err) });
  }

  private progress(): void {
    this.o.onProgress?.(++this.done, this.total);
  }

  async plan(explanations: readonly AiExplanation[], summary: string): Promise<AiPlan | undefined> {
    if (!this.wantsPlan || this.budgetHit || this.fatal.error) return undefined;
    try {
      return await buildPlan(this.report, explanations, this.deps, this.o.planModel ?? this.o.model, this.o.privacy, summary);
    } catch (err) {
      if (this.o.signal?.aborted) throw err;
      if (!this.fatal.error) this.errors.push({ message: `No se pudo generar el plan: ${message(err)}` });
      return undefined;
    } finally {
      this.progress();
    }
  }

  /** Errores fatales primero y explicaciones en el orden de la selección. */
  result(selected: readonly Finding[], explanations: AiExplanation[], plan: AiPlan | undefined): AiSection {
    if (this.fatal.error) this.errors.unshift(...this.stoppedErrors(this.fatal.error, plan === undefined));
    const order = new Map(selected.map((f, i) => [f.id, i]));
    explanations.sort((a, b) => (order.get(a.findingId) ?? 0) - (order.get(b.findingId) ?? 0));
    return {
      privacy: this.o.privacy,
      explanations,
      ...(plan ? { plan } : {}),
      usage: this.tracker.summary(),
      errors: this.errors,
      ...(this.notes.length > 0 ? { notes: this.notes } : {}),
    };
  }

  private stoppedErrors(stopped: ProviderError, noPlan: boolean): AiSection['errors'] {
    const planPending = this.wantsPlan && noPlan;
    const pending = this.skipped + (planPending ? 1 : 0);
    const out: AiSection['errors'] = [{ message: `${stopped.message} Se detuvo la IA para no repetir el error.` }];
    if (pending > 0) {
      const cached = this.o.cacheDir ? ' Las ya completadas se guardan en caché y no se repiten.' : '';
      out.push({ message: `Quedaron sin hacer ${pending} consulta(s) (explicaciones${planPending ? ' y plan' : ''}).${cached}` });
    }
    return out;
  }
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
