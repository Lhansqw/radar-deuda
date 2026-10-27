import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { gunzipSync, gzipSync } from 'node:zlib';
import { parseReport, type AiFixProposal, type AnalysisReport } from '@radar/engine';
import type { AnalysisSummary, ChatMessage, ChatMeta, Project, ProjectKind } from '../shared/model.js';

/**
 * Persistencia de la aplicación en un solo archivo SQLite (node:sqlite, sin
 * módulos nativos; ver docs/DECISIONES.md, D10): proyectos, historial de
 * análisis con el informe completo comprimido, ajustes y credenciales (ya
 * cifradas por credentials.ts). Todo el acceso es síncrono y ocurre en el
 * proceso principal.
 */

/** Cada migración lleva la base de datos de la versión i a la i + 1. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE projects (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('local', 'github')),
     location TEXT NOT NULL,
     branch TEXT,
     created_at TEXT NOT NULL,
     UNIQUE (kind, location)
   );
   CREATE TABLE analyses (
     id INTEGER PRIMARY KEY,
     project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     started_at TEXT NOT NULL,
     finished_at TEXT NOT NULL,
     duration_ms INTEGER NOT NULL,
     score INTEGER NOT NULL,
     rating TEXT NOT NULL,
     debt_ratio REAL NOT NULL,
     effort_minutes INTEGER NOT NULL,
     findings INTEGER NOT NULL,
     critical INTEGER NOT NULL,
     high INTEGER NOT NULL,
     medium INTEGER NOT NULL,
     low INTEGER NOT NULL,
     info INTEGER NOT NULL,
     head TEXT,
     branch TEXT,
     with_ai INTEGER NOT NULL,
     report BLOB NOT NULL
   );
   CREATE INDEX analyses_by_project ON analyses (project_id, finished_at DESC);
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE secrets (name TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at TEXT NOT NULL);`,
  // Fase 9: propuestas de corrección y conversaciones sobre un análisis.
  `CREATE TABLE fix_proposals (
     analysis_id INTEGER NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
     finding_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     proposal TEXT NOT NULL,
     PRIMARY KEY (analysis_id, finding_id)
   );
   CREATE TABLE chat_messages (
     id INTEGER PRIMARY KEY,
     analysis_id INTEGER NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
     role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
     content TEXT NOT NULL,
     meta TEXT,
     created_at TEXT NOT NULL
   );
   CREATE INDEX chat_by_analysis ON chat_messages (analysis_id, id);`,
];

/** Versión del esquema que crea esta versión de la aplicación. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** Mensajes de una conversación que se conservan (los más antiguos se eliminan). */
export const CHAT_LIMIT = 200;

/** Análisis que se conservan por proyecto (los más antiguos se eliminan). */
export const HISTORY_LIMIT = 100;

export class DuplicateProjectError extends Error {
  constructor(location: string) {
    super(`El proyecto ${location} ya está en la lista.`);
    this.name = 'DuplicateProjectError';
  }
}

type Row = Record<string, SQLInputValue>;

const SUMMARY_COLUMNS = `id, project_id, started_at, finished_at, duration_ms, score, rating, debt_ratio, effort_minutes,
  findings, critical, high, medium, low, info, head, branch, with_ai`;

function toSummary(r: Row): AnalysisSummary {
  return {
    id: Number(r['id']),
    projectId: Number(r['project_id']),
    startedAt: String(r['started_at']),
    finishedAt: String(r['finished_at']),
    durationMs: Number(r['duration_ms']),
    score: Number(r['score']),
    rating: String(r['rating']) as AnalysisSummary['rating'],
    debtRatio: Number(r['debt_ratio']),
    effortMinutes: Number(r['effort_minutes']),
    findings: Number(r['findings']),
    bySeverity: { critical: Number(r['critical']), high: Number(r['high']), medium: Number(r['medium']), low: Number(r['low']), info: Number(r['info']) },
    head: r['head'] === null ? null : String(r['head']),
    branch: r['branch'] === null ? null : String(r['branch']),
    withAi: Number(r['with_ai']) === 1,
  };
}

function toChatMessage(r: Row): ChatMessage {
  let meta: ChatMeta | null = null;
  if (r['meta'] !== null) {
    try {
      meta = JSON.parse(String(r['meta'])) as ChatMeta;
    } catch {
      meta = null;
    }
  }
  return { id: Number(r['id']), analysisId: Number(r['analysis_id']), role: String(r['role']) as ChatMessage['role'], content: String(r['content']), createdAt: String(r['created_at']), meta };
}

export class Store {
  private closed = false;

  private constructor(private readonly db: DatabaseSync) {}

  /** Abre (o crea) la base de datos y aplica las migraciones pendientes. Usa ':memory:' en pruebas. */
  static open(file: string): Store {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
    const store = new Store(db);
    try {
      store.migrate();
    } catch (err) {
      // Sin cerrarla, Windows mantiene el archivo bloqueado mientras la aplicación siga abierta.
      db.close();
      throw err;
    }
    return store;
  }

  get schemaVersion(): number {
    return Number((this.db.prepare('PRAGMA user_version').get() as Row)['user_version']);
  }

  private migrate(): void {
    const current = this.schemaVersion;
    if (current > MIGRATIONS.length) {
      throw new Error(`La base de datos es de una versión más reciente de la aplicación (esquema ${current}). Actualiza la aplicación.`);
    }
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v] as string);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Cierra la base de datos. Se puede llamar más de una vez (al salir, la
   * aplicación la cierra en will-quit aunque ya estuviera cerrada): node:sqlite
   * lanzaría «database is not open» y Electron lo mostraría como un error.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // ── Proyectos ──────────────────────────────────────────────────────────

  listProjects(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE, id').all() as Row[];
    return rows.map((r) => this.toProject(r));
  }

  getProject(id: number): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toProject(r) : null;
  }

  addProject(p: { name: string; kind: ProjectKind; location: string; branch?: string | null }): Project {
    const exists = this.db.prepare('SELECT id FROM projects WHERE kind = ? AND location = ?').get(p.kind, p.location);
    if (exists) throw new DuplicateProjectError(p.location);
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO projects (name, kind, location, branch, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(p.name, p.kind, p.location, p.branch ?? null, new Date().toISOString());
    return this.getProject(Number(lastInsertRowid)) as Project;
  }

  /** Elimina el proyecto y su historial (no toca la carpeta ni el repositorio). */
  removeProject(id: number): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  private toProject(r: Row): Project {
    const id = Number(r['id']);
    const last = this.db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM analyses WHERE project_id = ? ORDER BY finished_at DESC, id DESC LIMIT 1`).get(id) as Row | undefined;
    return {
      id,
      name: String(r['name']),
      kind: String(r['kind']) as ProjectKind,
      location: String(r['location']),
      branch: r['branch'] === null ? null : String(r['branch']),
      createdAt: String(r['created_at']),
      lastAnalysis: last ? toSummary(last) : null,
    };
  }

  // ── Análisis ───────────────────────────────────────────────────────────

  /** Guarda un análisis terminado. El informe completo se comprime (suele reducirse a un 10 %). */
  saveAnalysis(projectId: number, report: AnalysisReport, timing: { startedAt: string; durationMs: number }): AnalysisSummary {
    const s = report.summary.bySeverity;
    const blob = gzipSync(JSON.stringify(report));
    return this.transaction(() => {
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO analyses (project_id, started_at, finished_at, duration_ms, score, rating, debt_ratio, effort_minutes,
             findings, critical, high, medium, low, info, head, branch, with_ai, report)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          projectId,
          timing.startedAt,
          new Date().toISOString(),
          Math.round(timing.durationMs),
          report.score.score,
          report.score.rating,
          report.score.debtRatio,
          Math.round(report.score.remediationMinutes),
          report.findings.length,
          s.critical,
          s.high,
          s.medium,
          s.low,
          s.info,
          report.vcs?.head ?? null,
          report.vcs?.branch ?? null,
          report.ai ? 1 : 0,
          blob,
        );
      // Historial acotado: se conservan los HISTORY_LIMIT más recientes.
      this.db
        .prepare(`DELETE FROM analyses WHERE project_id = ? AND id NOT IN (SELECT id FROM analyses WHERE project_id = ? ORDER BY finished_at DESC, id DESC LIMIT ${HISTORY_LIMIT})`)
        .run(projectId, projectId);
      return toSummary(this.db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM analyses WHERE id = ?`).get(Number(lastInsertRowid)) as Row);
    });
  }

  getAnalysis(analysisId: number): AnalysisSummary | null {
    const r = this.db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM analyses WHERE id = ?`).get(analysisId) as Row | undefined;
    return r ? toSummary(r) : null;
  }

  /** Del más reciente al más antiguo. */
  listAnalyses(projectId: number, limit = HISTORY_LIMIT): AnalysisSummary[] {
    const rows = this.db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM analyses WHERE project_id = ? ORDER BY finished_at DESC, id DESC LIMIT ?`).all(projectId, limit) as Row[];
    return rows.map(toSummary);
  }

  getReport(analysisId: number): AnalysisReport | null {
    const r = this.db.prepare('SELECT report FROM analyses WHERE id = ?').get(analysisId) as Row | undefined;
    if (!r) return null;
    return parseReport(gunzipSync(r['report'] as Uint8Array).toString('utf8'));
  }

  /** Sustituye el informe de un análisis (p. ej. al añadir explicaciones de IA a posteriori). */
  updateReport(analysisId: number, report: AnalysisReport): void {
    this.db.prepare('UPDATE analyses SET report = ?, with_ai = ? WHERE id = ?').run(gzipSync(JSON.stringify(report)), report.ai ? 1 : 0, analysisId);
  }

  // ── Propuestas de corrección ───────────────────────────────────────────

  /** Guarda la propuesta de un hallazgo (sustituye la anterior). */
  saveFixProposal(analysisId: number, p: AiFixProposal): void {
    this.db
      .prepare(
        `INSERT INTO fix_proposals (analysis_id, finding_id, created_at, proposal) VALUES (?, ?, ?, ?)
         ON CONFLICT (analysis_id, finding_id) DO UPDATE SET created_at = excluded.created_at, proposal = excluded.proposal`,
      )
      .run(analysisId, p.findingId, p.createdAt, JSON.stringify(p));
  }

  getFixProposal(analysisId: number, findingId: string): AiFixProposal | null {
    const r = this.db.prepare('SELECT proposal FROM fix_proposals WHERE analysis_id = ? AND finding_id = ?').get(analysisId, findingId) as Row | undefined;
    if (!r) return null;
    try {
      return JSON.parse(String(r['proposal'])) as AiFixProposal;
    } catch {
      return null;
    }
  }

  /** Hallazgos del análisis que tienen una propuesta guardada. */
  fixProposalIds(analysisId: number): string[] {
    return (this.db.prepare('SELECT finding_id FROM fix_proposals WHERE analysis_id = ? ORDER BY created_at').all(analysisId) as Row[]).map((r) => String(r['finding_id']));
  }

  deleteFixProposal(analysisId: number, findingId: string): void {
    this.db.prepare('DELETE FROM fix_proposals WHERE analysis_id = ? AND finding_id = ?').run(analysisId, findingId);
  }

  // ── Conversación ───────────────────────────────────────────────────────

  addChatMessage(analysisId: number, m: { role: ChatMessage['role']; content: string; meta?: ChatMeta | null }): ChatMessage {
    return this.transaction(() => {
      const { lastInsertRowid } = this.db
        .prepare('INSERT INTO chat_messages (analysis_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(analysisId, m.role, m.content, m.meta ? JSON.stringify(m.meta) : null, new Date().toISOString());
      this.db
        .prepare(`DELETE FROM chat_messages WHERE analysis_id = ? AND id NOT IN (SELECT id FROM chat_messages WHERE analysis_id = ? ORDER BY id DESC LIMIT ${CHAT_LIMIT})`)
        .run(analysisId, analysisId);
      return toChatMessage(this.db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(Number(lastInsertRowid)) as Row);
    });
  }

  /** En orden de escritura. */
  listChatMessages(analysisId: number): ChatMessage[] {
    return (this.db.prepare('SELECT * FROM chat_messages WHERE analysis_id = ? ORDER BY id').all(analysisId) as Row[]).map(toChatMessage);
  }

  clearChat(analysisId: number): void {
    this.db.prepare('DELETE FROM chat_messages WHERE analysis_id = ?').run(analysisId);
  }

  // ── Ajustes y credenciales ─────────────────────────────────────────────

  getSetting(key: string): unknown {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    if (!r) return undefined;
    try {
      return JSON.parse(String(r['value'])) as unknown;
    } catch {
      return undefined;
    }
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  /** Valor ya cifrado: este módulo nunca ve una credencial en claro. */
  getSecret(name: string): Uint8Array | null {
    const r = this.db.prepare('SELECT value FROM secrets WHERE name = ?').get(name) as Row | undefined;
    return r ? (r['value'] as Uint8Array) : null;
  }

  setSecret(name: string, encrypted: Uint8Array): void {
    this.db
      .prepare('INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(name, encrypted, new Date().toISOString());
  }

  deleteSecret(name: string): void {
    this.db.prepare('DELETE FROM secrets WHERE name = ?').run(name);
  }
}
