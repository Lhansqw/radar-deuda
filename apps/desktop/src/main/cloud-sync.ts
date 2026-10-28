import { randomUUID } from 'node:crypto';
import type { SyncState } from '../shared/sync.js';
import type { CloudLedger } from './cloud-ledger.js';
import { decodeCloudReport, encodeCloudReport } from './cloud-report.js';
import { CloudError, type CloudProject, type CloudRepo } from './cloud-repo.js';
import { HISTORY_LIMIT } from './store-rows.js';

export interface CloudSyncDeps {
  ledger: CloudLedger;
  /** La nube con la sesión del usuario, o null sin sesión. */
  repo: () => Promise<CloudRepo | null>;
  /** Ajuste «Guardar proyectos e historial en la nube». */
  enabled: () => boolean;
  /** Avisa a la interfaz de cada cambio de estado. */
  emit: (state: SyncState) => void;
  now?: () => Date;
  /** Esperas, en milisegundos (las pruebas las acortan). */
  timing?: Partial<typeof TIMING>;
}

const TIMING = {
  /** Tras un cambio, se espera un poco por si llegan más. */
  debounceMs: 3000,
  /** Sin conexión, se vuelve a intentar cada… */
  retryMs: 2 * 60_000,
  /** Con conexión, se comprueba si hay novedades de otros equipos cada… */
  periodMs: 10 * 60_000,
};

/** Análisis que se suben por tanda. */
const BATCH = 20;

/**
 * Copia en la nube de los proyectos y del historial (fase 13b). Los datos
 * de trabajo siguen en el equipo (SQLite): la nube es una copia que permite
 * verlos desde otro equipo con la misma cuenta.
 *
 * Cada sincronización primero recibe (proyectos y análisis de otros equipos,
 * proyectos quitados en otros equipos) y después envía (proyectos quitados
 * aquí, proyectos nuevos y análisis pendientes). Si la nube perdió un proyecto
 * que este equipo tenía enlazado, se vuelve a subir. Nada sube con código.
 */
export class CloudSync {
  private readonly t: typeof TIMING;
  private state: SyncState;
  private running: Promise<SyncState> | null = null;
  private again = false;
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(private readonly d: CloudSyncDeps) {
    this.t = { ...TIMING, ...d.timing };
    this.state = { status: d.enabled() ? 'idle' : 'off', lastSyncAt: null, message: null, pending: d.ledger.pendingCount(), received: 0 };
  }

  current(): SyncState {
    return this.state;
  }

  /** Sincroniza dentro de un momento (tras un cambio del usuario). */
  schedule(delayMs = this.t.debounceMs): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.now();
    }, delayMs);
    this.timer.unref?.();
  }

  /** Sincroniza ya. Si ya hay una en curso, al terminar se hace otra. */
  async now(): Promise<SyncState> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run();
    try {
      return await this.running;
    } finally {
      this.running = null;
      if (this.again && !this.disposed) {
        this.again = false;
        this.schedule(0);
      }
    }
  }

  /** Borra todo lo del usuario en la nube y lo deja pendiente aquí (por si se vuelve a activar). */
  async deleteCloudCopy(): Promise<SyncState> {
    const repo = await this.d.repo();
    if (!repo) throw new CloudError('Inicia sesión para borrar la copia en la nube.', false);
    await repo.deleteEverything();
    this.d.ledger.unlinkAll();
    return this.set({ pending: this.d.ledger.pendingCount(), lastSyncAt: null, message: null });
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async run(): Promise<SyncState> {
    if (this.disposed) return this.state;
    if (!this.d.enabled()) return this.set({ status: 'off', message: null, pending: this.d.ledger.pendingCount() });
    const repo = await this.d.repo();
    if (!repo) return this.set({ status: 'idle', message: null });
    this.set({ status: 'syncing', message: null });
    try {
      const received = await this.receive(repo);
      await this.send(repo);
      const state = this.set({
        status: 'idle',
        lastSyncAt: (this.d.now?.() ?? new Date()).toISOString(),
        pending: this.d.ledger.pendingCount(),
        received: this.state.received + received,
      });
      this.schedule(this.t.periodMs);
      return state;
    } catch (err) {
      const offline = err instanceof CloudError && err.offline;
      const message = err instanceof Error ? err.message : String(err);
      // Si se cerró la sesión a mitad (base de datos cerrada), no queda nada que hacer.
      if (this.disposed) return this.state;
      const state = this.set({ status: offline ? 'offline' : 'error', message, pending: this.d.ledger.pendingCount() });
      this.schedule(offline ? this.t.retryMs : this.t.periodMs);
      return state;
    }
  }

  /** Proyectos y análisis de otros equipos. Devuelve cuántos cambios hubo aquí. */
  private async receive(repo: CloudRepo): Promise<number> {
    const projects = await repo.projects();
    let changes = this.receiveProjects(projects);
    const linked = this.d.ledger.linkedProjects();
    const known = this.d.ledger.knownAnalyses();
    // Solo los más recientes de cada proyecto: los demás no se conservarían.
    const perProject = new Map<string, number>();
    for (const ref of await repo.analysisRefs()) {
      const local = linked.get(ref.projectId);
      const seen = (perProject.get(ref.projectId) ?? 0) + 1;
      perProject.set(ref.projectId, seen);
      if (local === undefined || known.has(ref.id) || seen > HISTORY_LIMIT) continue;
      const a = await repo.analysis(ref.id);
      if (!a) continue;
      let report;
      try {
        report = decodeCloudReport(a.reportGz);
      } catch {
        continue; // un informe dañado en la nube no detiene el resto
      }
      if (this.d.ledger.importAnalysis(local, { cloudId: a.id, startedAt: a.startedAt, finishedAt: a.finishedAt, durationMs: a.durationMs, report })) changes++;
    }
    return changes;
  }

  private receiveProjects(projects: CloudProject[]): number {
    const ledger = this.d.ledger;
    const linked = ledger.linkedProjects();
    const removedHere = new Set(ledger.removals());
    let changes = 0;
    for (const p of projects) {
      const local = linked.get(p.id);
      if (p.deletedAt !== null) {
        // Quitado en otro equipo.
        if (local !== undefined) {
          ledger.forgetProject(local);
          changes++;
        }
        continue;
      }
      if (local !== undefined || removedHere.has(p.id)) continue;
      // El mismo proyecto añadido en este equipo antes de sincronizar: se enlazan.
      const same = ledger.findProject(p.kind, p.location);
      if (same !== null) ledger.linkProject(same, p.id);
      else ledger.importProject({ cloudId: p.id, name: p.name, kind: p.kind, location: p.location, branch: p.branch, createdAt: p.createdAt });
      changes++;
    }
    // Enlazados aquí pero que la nube ya no tiene (se borró la copia): vuelven a subir.
    const inCloud = new Set(projects.map((p) => p.id));
    for (const [cloudId, local] of linked) if (!inCloud.has(cloudId)) ledger.unlinkProject(local);
    return changes;
  }

  /** Proyectos quitados aquí, proyectos nuevos y análisis pendientes. */
  private async send(repo: CloudRepo): Promise<void> {
    const ledger = this.d.ledger;
    for (const cloudId of ledger.removals()) {
      await repo.removeProject(cloudId);
      ledger.clearRemoval(cloudId);
    }
    for (const p of ledger.pendingProjects()) {
      const existing = await repo.findProject(p.kind, p.location);
      if (existing) await repo.restoreProject(existing.id, { name: p.name, branch: p.branch });
      ledger.linkProject(p.id, existing?.id ?? (await repo.addProject(p)));
    }
    for (let batch = ledger.pendingAnalyses(BATCH); batch.length > 0; batch = ledger.pendingAnalyses(BATCH)) {
      for (const a of batch) {
        const cloudId = a.cloudId ?? randomUUID();
        if (!a.cloudId) ledger.assignCloudId(a.id, cloudId);
        const s = a.summary;
        await repo.addAnalysis({
          id: cloudId,
          project_id: a.projectCloudId,
          started_at: s.startedAt,
          finished_at: s.finishedAt,
          duration_ms: s.durationMs,
          score: s.score,
          rating: s.rating,
          debt_ratio: s.debtRatio,
          effort_minutes: s.effortMinutes,
          findings: s.findings,
          critical: s.bySeverity.critical,
          high: s.bySeverity.high,
          medium: s.bySeverity.medium,
          low: s.bySeverity.low,
          info: s.bySeverity.info,
          head: s.head,
          branch: s.branch,
          report_gz: encodeCloudReport(a.report),
        });
        ledger.markUploaded(a.id, cloudId);
      }
    }
  }

  private set(patch: Partial<SyncState>): SyncState {
    this.state = { ...this.state, ...patch };
    if (!this.disposed) this.d.emit(this.state);
    return this.state;
  }
}
