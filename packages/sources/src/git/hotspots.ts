import path from 'node:path';
import { isTestPath, type AnalysisReport, type Hotspot } from '@radar/engine';
import type { FileChurn } from './history.js';

export interface HotspotOptions {
  /** Carpeta analizada relativa a la raíz del repositorio (`''` si coinciden). */
  prefix?: string;
  /** Mínimo de commits para considerar que un archivo "cambia a menudo". */
  minCommits?: number;
  limit?: number;
  /**
   * Incluir archivos de pruebas. Por defecto no: su deuda sigue en los
   * hallazgos, pero refactorizar código de producción rinde más.
   */
  includeTests?: boolean;
  /** Puntuación mínima para aparecer (por defecto 5): por debajo es ruido. */
  minScore?: number;
}

/**
 * Cruza la frecuencia de cambio con la deuda de cada archivo. La puntuación es
 * el producto de ambas magnitudes normalizadas (0–1) respecto al máximo del
 * repositorio, en escala 0–100: un archivo muy complejo que nunca cambia o uno
 * que cambia mucho pero está limpio puntúan bajo.
 */
export function computeHotspots(report: AnalysisReport, churn: ReadonlyMap<string, FileChurn>, options: HotspotOptions = {}): Hotspot[] {
  const { prefix = '', minCommits = 2, limit = 15, includeTests = false, minScore = 5 } = options;
  const debt = new Map<string, { minutes: number; ids: string[] }>();
  for (const f of report.findings) {
    if (f.severity === 'info') continue;
    // El esfuerzo de un hallazgo con varias ubicaciones se reparte entre sus archivos.
    const files = [...new Set(f.locations.map((l) => l.file))].filter((file) => file !== '.');
    for (const file of files) {
      const entry = debt.get(file) ?? { minutes: 0, ids: [] };
      entry.minutes += f.effort.minutes / files.length;
      entry.ids.push(f.id);
      debt.set(file, entry);
    }
  }

  const candidates: Array<{ churn: FileChurn; rel: string; minutes: number; ids: string[] }> = [];
  for (const c of churn.values()) {
    if (c.commits < minCommits) continue;
    const rel = prefix ? path.posix.relative(prefix, c.file) : c.file;
    if (rel.startsWith('..') || (!includeTests && isTestPath(rel))) continue;
    const d = debt.get(rel);
    if (!d || d.minutes <= 0) continue;
    candidates.push({ churn: c, rel, minutes: d.minutes, ids: d.ids });
  }
  if (candidates.length === 0) return [];

  const maxCommits = Math.max(...candidates.map((c) => c.churn.commits));
  const maxDebt = Math.max(...candidates.map((c) => c.minutes));
  return candidates
    .map(
      (c): Hotspot => ({
        file: c.rel,
        commits: c.churn.commits,
        linesChanged: c.churn.added + c.churn.deleted,
        authors: c.churn.authors,
        lastChangeAt: new Date(c.churn.lastChange * 1000).toISOString(),
        debtMinutes: Math.round(c.minutes),
        findingIds: [...new Set(c.ids)],
        score: Math.round(100 * (c.churn.commits / maxCommits) * (c.minutes / maxDebt)),
      }),
    )
    .filter((h) => h.score >= minScore)
    .sort((a, b) => b.score - a.score || b.commits - a.commits || a.file.localeCompare(b.file))
    .slice(0, limit);
}
