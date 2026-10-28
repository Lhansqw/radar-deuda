import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { AiOptions } from '@radar/pipeline';
import type { JobLogEntry, JobPhase, JobState } from '../shared/jobs.js';
import type { Project } from '../shared/model.js';
import { LOCAL_PROVIDERS, type AppSettings, type AiSettings } from '../shared/settings.js';
import type { FromWorker, StartMessage, ToWorker } from '../worker/protocol.js';
import type { CredentialStore } from './credentials.js';
import type { Store } from './store.js';

/** Lo que el gestor necesita de un proceso de análisis (en Electron, un utilityProcess). */
export interface WorkerHandle {
  postMessage(msg: ToWorker): void;
  onMessage(cb: (msg: FromWorker) => void): void;
  onExit(cb: (code: number) => void): void;
  kill(): void;
}

export interface JobDeps {
  store: Store;
  credentials: CredentialStore;
  settings: () => AppSettings;
  /** Lanza el proceso de análisis con este límite de memoria (MB). */
  spawn: (o: { memoryLimitMb: number }) => WorkerHandle;
  /** Avisa a la interfaz de cada cambio de estado. */
  emit: (state: JobState) => void;
  now?: () => Date;
  /** Tiempo que se espera a que el proceso se detenga al cancelar antes de terminarlo. */
  cancelGraceMs?: number;
  /** Para las pruebas; por defecto, si la carpeta existe en el disco. */
  folderExists?: (path: string) => boolean;
}

/** Ajustes de la aplicación → opciones de la capa de IA. */
export function aiOptionsFrom(s: AiSettings): AiOptions {
  const openrouter = s.provider === 'openrouter';
  return {
    provider: s.provider,
    limit: s.limit,
    budgetUsd: s.budgetUsd,
    plan: s.plan,
    ...(s.model !== '' ? { model: s.model } : {}),
    ...(s.privacy !== 'auto' ? { privacy: s.privacy } : {}),
    ...(LOCAL_PROVIDERS.has(s.provider) && s.localUrl !== '' ? { url: s.localUrl } : {}),
    ...(openrouter && s.fallbackModels.length > 0 ? { fallbackModels: s.fallbackModels } : {}),
    ...(openrouter && s.allowDataCollection ? { allowDataCollection: true } : {}),
    ...(openrouter && s.zeroDataRetention ? { zeroDataRetention: true } : {}),
    ...(openrouter && s.reasoning !== 'auto' ? { reasoning: s.reasoning } : {}),
  };
}

/** Fecha de inicio del historial a partir de los meses configurados (AAAA-MM-DD). */
export function sinceFromMonths(months: number, now: Date): string {
  const total = now.getUTCFullYear() * 12 + now.getUTCMonth() - months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  // Sin desbordar: un mes antes del 31 de marzo es el 28 (o 29) de febrero, no el 3 de marzo.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(now.getUTCDate(), lastDay))).toISOString().slice(0, 10);
}

export class JobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobError';
  }
}

const LOG_LIMIT = 60;
const CANCELLED = 'Análisis cancelado.';
/** Como mucho un aviso de progreso de archivos cada 100 ms, para no saturar la interfaz. */
const PROGRESS_INTERVAL_MS = 100;

interface Running {
  state: JobState;
  worker: WorkerHandle;
  started: number;
  lastEmit: number;
  killTimer: ReturnType<typeof setTimeout> | null;
  cancelRequested: boolean;
  aiRequested: boolean;
}

/**
 * Gestiona los análisis: uno a la vez (el motor ya usa varios hilos de E/S y
 * así la memoria queda acotada), cada uno en su propio proceso.
 */
export class JobManager {
  private running: Running | null = null;
  private readonly recent = new Map<string, JobState>();

  constructor(private readonly d: JobDeps) {}

  list(): JobState[] {
    return [...(this.running ? [this.running.state] : []), ...[...this.recent.values()].reverse()];
  }

  start(projectId: number): JobState {
    const project = this.d.store.getProject(projectId);
    if (!project) throw new JobError('Ese proyecto ya no existe.');
    // Un proyecto local añadido en otro equipo (llegó con la copia en la nube): aquí solo hay su historial.
    if (project.kind === 'local' && !(this.d.folderExists ?? existsSync)(project.location)) {
      throw new JobError(`La carpeta ${project.location} no está en este equipo. Si el proyecto se añadió en otro equipo, aquí puedes ver su historial, pero para analizarlo hay que añadir su carpeta desde este.`);
    }
    if (this.running) {
      const busy = this.d.store.getProject(this.running.state.projectId);
      throw new JobError(`Ya hay un análisis en curso${busy ? ` (${busy.name})` : ''}. Espera a que termine o cancélalo.`);
    }
    const now = this.now();
    const settings = this.d.settings();
    const state: JobState = {
      jobId: randomUUID(),
      projectId,
      status: 'running',
      phase: 'starting',
      progress: null,
      startedAt: now.toISOString(),
      finishedAt: null,
      analysisId: null,
      log: [],
      error: null,
      aiError: null,
    };
    const message = this.startMessage(project, settings, now);
    const worker = this.d.spawn({ memoryLimitMb: settings.analysis.memoryLimitMb });
    this.running = { state, worker, started: now.getTime(), lastEmit: 0, killTimer: null, cancelRequested: false, aiRequested: message.ai !== undefined };
    worker.onMessage((m) => this.onMessage(state.jobId, m));
    worker.onExit((code) => this.onExit(state.jobId, code));
    worker.postMessage(message);
    this.emit(true);
    return structuredClone(state);
  }

  cancel(jobId: string): void {
    const r = this.running;
    if (!r || r.state.jobId !== jobId) return;
    r.cancelRequested = true;
    r.worker.postMessage({ type: 'cancel' });
    // Si el motor no responde (p. ej. un archivo enorme), se termina el proceso.
    r.killTimer = setTimeout(() => {
      if (this.running === r) {
        r.worker.kill();
        this.finish('cancelled', CANCELLED);
      }
    }, this.d.cancelGraceMs ?? 5000);
  }

  /** Al cerrar la aplicación. */
  dispose(): void {
    this.running?.worker.kill();
    this.running = null;
  }

  private startMessage(project: Project, settings: AppSettings, now: Date): StartMessage {
    const github = project.kind === 'github';
    const token = github ? this.d.credentials.get('github') : undefined;
    const a = settings.analysis;
    return {
      type: 'start',
      request: {
        target: project.location,
        history: a.history,
        since: sinceFromMonths(a.historyMonths, now),
        online: a.online,
        noCache: false,
        ...(github && project.branch ? { branch: project.branch } : {}),
        ...(token ? { githubToken: token } : {}),
      },
      ...(settings.ai.auto ? { ai: { options: aiOptionsFrom(settings.ai), keys: this.d.credentials.apiKeys() } } : {}),
    };
  }

  private onMessage(jobId: string, m: FromWorker): void {
    const r = this.running;
    if (!r || r.state.jobId !== jobId) return;
    const s = r.state;
    switch (m.type) {
      case 'event': {
        const e = m.event;
        if (e.phase === 'done') return;
        const changed = s.phase !== e.phase;
        s.phase = e.phase as JobPhase;
        s.progress = 'done' in e ? { done: e.done, total: e.total } : null;
        this.emit(changed);
        return;
      }
      case 'log':
        this.log(m.level, m.message);
        return;
      case 'report': {
        s.phase = 'saving';
        try {
          const summary = this.d.store.saveAnalysis(s.projectId, m.report, { startedAt: s.startedAt, durationMs: m.durationMs });
          s.analysisId = summary.id;
        } catch (err) {
          r.worker.kill();
          this.finish('failed', `No se pudo guardar el análisis: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        // Con IA, el análisis ya está guardado y visible mientras la IA trabaja.
        if (r.aiRequested) s.phase = 'ai';
        s.progress = null;
        this.emit(true);
        return;
      }
      case 'ai': {
        if (s.analysisId === null) return;
        const report = this.d.store.getReport(s.analysisId);
        if (report) {
          report.ai = m.section;
          this.d.store.updateReport(s.analysisId, report);
        }
        this.log('info', `IA: ${m.label}.`);
        return;
      }
      case 'ai-error':
        s.aiError = m.message;
        this.log('warn', `La IA no se pudo ejecutar: ${m.message}`);
        return;
      case 'error': {
        r.worker.kill();
        const cancelled = m.cancelled || r.cancelRequested;
        this.finish(cancelled ? 'cancelled' : 'failed', cancelled ? CANCELLED : m.message);
        return;
      }
      case 'finished':
        r.worker.kill();
        this.finish('done', null);
        return;
    }
  }

  private onExit(jobId: string, code: number): void {
    const r = this.running;
    if (!r || r.state.jobId !== jobId) return;
    if (r.cancelRequested) this.finish('cancelled', CANCELLED);
    else
      this.finish(
        'failed',
        r.state.analysisId !== null
          ? `El proceso de análisis terminó inesperadamente (código ${code}). El análisis del motor sí se guardó.`
          : `El proceso de análisis terminó inesperadamente (código ${code}). Si el repositorio es muy grande, puede haberse quedado sin memoria: sube el límite en Configuración → Análisis o excluye carpetas con un archivo .radarignore.`,
      );
  }

  private finish(status: JobState['status'], error: string | null): void {
    const r = this.running;
    if (!r) return;
    if (r.killTimer) clearTimeout(r.killTimer);
    const s = r.state;
    s.status = status;
    s.phase = 'finished';
    s.progress = null;
    s.finishedAt = this.now().toISOString();
    s.error = status === 'done' ? null : error;
    this.running = null;
    this.recent.set(s.jobId, s);
    while (this.recent.size > 10) this.recent.delete(this.recent.keys().next().value as string);
    this.d.emit(structuredClone(s));
  }

  private log(level: JobLogEntry['level'], message: string): void {
    const s = this.running?.state;
    if (!s) return;
    s.log.push({ level, message, at: this.now().toISOString() });
    if (s.log.length > LOG_LIMIT) s.log.splice(0, s.log.length - LOG_LIMIT);
    this.emit(true);
  }

  private emit(force: boolean): void {
    const r = this.running;
    if (!r) return;
    const t = this.now().getTime();
    if (!force && t - r.lastEmit < PROGRESS_INTERVAL_MS) return;
    r.lastEmit = t;
    this.d.emit(structuredClone(r.state));
  }

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }
}
