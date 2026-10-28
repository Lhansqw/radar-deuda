import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import type { AnalysisReport } from '@radar/engine';
import type { AnalysisSummary } from '../shared/model.js';

/** Filas de la base de datos de la aplicación que comparten store.ts y cloud-ledger.ts. */

/** Análisis que se conservan por proyecto (los más antiguos se eliminan). */
export const HISTORY_LIMIT = 100;

export type Row = Record<string, SQLInputValue>;

export const SUMMARY_COLUMNS = `id, project_id, started_at, finished_at, duration_ms, score, rating, debt_ratio, effort_minutes,
  findings, critical, high, medium, low, info, head, branch, with_ai`;

export function toSummary(r: Row): AnalysisSummary {
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

/** Lo que identifica un análisis guardado aparte del informe. */
export interface AnalysisTiming {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Solo los que llegan de la nube: ya están subidos. */
  cloudId?: string;
}

/**
 * Inserta un análisis (con su informe comprimido) y recorta el historial del
 * proyecto a los HISTORY_LIMIT más recientes. Debe ir dentro de una
 * transacción. Devuelve null si el análisis no queda por ser de los antiguos.
 */
export function insertAnalysis(db: DatabaseSync, projectId: number, report: AnalysisReport, t: AnalysisTiming): AnalysisSummary | null {
  const s = report.summary.bySeverity;
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO analyses (project_id, started_at, finished_at, duration_ms, score, rating, debt_ratio, effort_minutes,
         findings, critical, high, medium, low, info, head, branch, with_ai, report, cloud_id, cloud_synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      projectId,
      t.startedAt,
      t.finishedAt,
      Math.round(t.durationMs),
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
      gzipSync(JSON.stringify(report)),
      t.cloudId ?? null,
      t.cloudId ? 1 : 0,
    );
  // Historial acotado: se conservan los HISTORY_LIMIT más recientes.
  db.prepare(`DELETE FROM analyses WHERE project_id = ? AND id NOT IN (SELECT id FROM analyses WHERE project_id = ? ORDER BY finished_at DESC, id DESC LIMIT ${HISTORY_LIMIT})`).run(
    projectId,
    projectId,
  );
  const row = db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM analyses WHERE id = ?`).get(Number(lastInsertRowid)) as Row | undefined;
  // Uno que llega de la nube puede ser más antiguo que los que se conservan: no queda.
  return row ? toSummary(row) : null;
}
