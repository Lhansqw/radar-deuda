import type { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { parseReport, type AnalysisReport } from '@radar/engine';
import type { AnalysisSummary, ProjectKind } from '../shared/model.js';
import { insertAnalysis, SUMMARY_COLUMNS, toSummary, type Row } from './store-rows.js';

/** Un proyecto tal como se sube a la nube. */
export interface LocalProject {
  id: number;
  name: string;
  kind: ProjectKind;
  location: string;
  branch: string | null;
  createdAt: string;
}

/** Un análisis pendiente de subir, con el identificador del proyecto en la nube. */
export interface PendingAnalysis {
  id: number;
  /** null: aún no tiene identificador en la nube (nunca ha subido). */
  cloudId: string | null;
  projectCloudId: string;
  summary: AnalysisSummary;
  report: AnalysisReport;
}

type Transaction = <T>(fn: () => T) => T;

/**
 * El registro local de la copia en la nube (fase 13b): qué proyectos y
 * análisis faltan por subir, qué proyectos se quitaron aquí y cómo se guarda
 * lo que llega de otros equipos. Nada de esto avisa a Store.onChange: lo que
 * llega de la nube no tiene que volver a subir.
 */
export class CloudLedger {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: Transaction,
  ) {}

  // ── Lo que hay que subir ───────────────────────────────────────────────

  /** Proyectos que aún no tienen su fila en la nube. */
  pendingProjects(): LocalProject[] {
    const rows = this.db.prepare('SELECT id, name, kind, location, branch, created_at FROM projects WHERE cloud_id IS NULL ORDER BY id').all() as Row[];
    return rows.map((r) => ({
      id: Number(r['id']),
      name: String(r['name']),
      kind: String(r['kind']) as ProjectKind,
      location: String(r['location']),
      branch: r['branch'] === null ? null : String(r['branch']),
      createdAt: String(r['created_at']),
    }));
  }

  linkProject(id: number, cloudId: string): void {
    this.db.prepare('UPDATE projects SET cloud_id = ? WHERE id = ?').run(cloudId, id);
  }

  /** Proyectos quitados en este equipo que hay que marcar como quitados en la nube. */
  removals(): string[] {
    return (this.db.prepare('SELECT cloud_id FROM cloud_removals ORDER BY removed_at').all() as Row[]).map((r) => String(r['cloud_id']));
  }

  clearRemoval(cloudId: string): void {
    this.db.prepare('DELETE FROM cloud_removals WHERE cloud_id = ?').run(cloudId);
  }

  /** Análisis por subir (de proyectos que ya están en la nube), de los más antiguos a los más recientes. */
  pendingAnalyses(limit: number): PendingAnalysis[] {
    const rows = this.db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS.split(',')
          .map((c) => `a.${c.trim()}`)
          .join(', ')}, a.cloud_id, a.report, p.cloud_id AS project_cloud_id
         FROM analyses a JOIN projects p ON p.id = a.project_id
         WHERE a.cloud_synced = 0 AND p.cloud_id IS NOT NULL
         ORDER BY a.finished_at, a.id LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((r) => ({
      id: Number(r['id']),
      cloudId: r['cloud_id'] === null ? null : String(r['cloud_id']),
      projectCloudId: String(r['project_cloud_id']),
      summary: toSummary(r),
      report: parseReport(gunzipSync(r['report'] as Uint8Array).toString('utf8')),
    }));
  }

  /**
   * Le da su identificador en la nube antes de subirlo: si la subida se
   * interrumpe, el siguiente intento usa el mismo y la nube no lo duplica.
   */
  assignCloudId(id: number, cloudId: string): void {
    this.db.prepare('UPDATE analyses SET cloud_id = ? WHERE id = ? AND cloud_id IS NULL').run(cloudId, id);
  }

  /** El análisis ya está en la nube con este identificador. */
  markUploaded(id: number, cloudId: string): void {
    this.db.prepare('UPDATE analyses SET cloud_id = ?, cloud_synced = 1 WHERE id = ?').run(cloudId, id);
  }

  // ── Lo que llega de la nube ────────────────────────────────────────────

  /** Identificador en la nube → id local, de los proyectos ya enlazados. */
  linkedProjects(): Map<string, number> {
    const rows = this.db.prepare('SELECT id, cloud_id FROM projects WHERE cloud_id IS NOT NULL').all() as Row[];
    return new Map(rows.map((r) => [String(r['cloud_id']), Number(r['id'])]));
  }

  /** Proyecto local con ese tipo y ubicación (el mismo repositorio añadido en dos equipos). */
  findProject(kind: ProjectKind, location: string): number | null {
    const r = this.db.prepare('SELECT id FROM projects WHERE kind = ? AND location = ?').get(kind, location) as Row | undefined;
    return r ? Number(r['id']) : null;
  }

  /** Proyecto que se añadió en otro equipo. */
  importProject(p: { cloudId: string; name: string; kind: ProjectKind; location: string; branch: string | null; createdAt: string }): number {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO projects (name, kind, location, branch, created_at, cloud_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p.name, p.kind, p.location, p.branch, p.createdAt, p.cloudId);
    return Number(lastInsertRowid);
  }

  /** Proyecto quitado en otro equipo: se quita aquí sin anotarlo para la nube (ya lo está). */
  forgetProject(id: number): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  /** Identificadores en la nube de los análisis que ya hay en este equipo. */
  knownAnalyses(): Set<string> {
    return new Set((this.db.prepare('SELECT cloud_id FROM analyses WHERE cloud_id IS NOT NULL').all() as Row[]).map((r) => String(r['cloud_id'])));
  }

  /** Guarda un análisis de otro equipo (ya subido). null si es más antiguo que los que se conservan. */
  importAnalysis(projectId: number, a: { cloudId: string; startedAt: string; finishedAt: string; durationMs: number; report: AnalysisReport }): AnalysisSummary | null {
    return this.transaction(() => insertAnalysis(this.db, projectId, a.report, a));
  }

  /** El proyecto ya no está en la nube (se borró allí): él y su historial vuelven a estar pendientes. */
  unlinkProject(id: number): void {
    this.transaction(() => {
      this.db.prepare('UPDATE projects SET cloud_id = NULL WHERE id = ?').run(id);
      this.db.prepare('UPDATE analyses SET cloud_id = NULL, cloud_synced = 0 WHERE project_id = ?').run(id);
    });
  }

  /** Tras borrar la copia en la nube: todo vuelve a estar pendiente de subir. */
  unlinkAll(): void {
    this.transaction(() => {
      this.db.exec('UPDATE projects SET cloud_id = NULL; UPDATE analyses SET cloud_id = NULL, cloud_synced = 0; DELETE FROM cloud_removals;');
    });
  }

  /** Cuánto queda por subir. */
  pendingCount(): { projects: number; analyses: number; removals: number } {
    const n = (sql: string) => Number((this.db.prepare(sql).get() as Row)['n']);
    return {
      projects: n('SELECT count(*) AS n FROM projects WHERE cloud_id IS NULL'),
      analyses: n('SELECT count(*) AS n FROM analyses WHERE cloud_synced = 0'),
      removals: n('SELECT count(*) AS n FROM cloud_removals'),
    };
  }
}
