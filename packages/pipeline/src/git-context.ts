import path from 'node:path';
import type { AnalysisReport } from '@radar/engine';
import { computeHotspots, fileChurn, getRepoInfo } from '@radar/sources';
import { historyStart } from './target.js';
import type { PipelineHooks } from './types.js';

/** Añade al informe el commit analizado y, si se pide, los puntos críticos del historial. */
export async function addGitContext(report: AnalysisReport, o: { history: boolean; since?: string }, hooks: PipelineHooks, signal: AbortSignal): Promise<void> {
  let info;
  try {
    info = await getRepoInfo(report.root, signal);
  } catch (err) {
    hooks.warn(`Git no disponible: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!info) return;
  report.vcs = { head: info.head, branch: info.branch, remoteUrl: info.remoteUrl, shallow: info.shallow };
  if (!o.history || !info.head) return;
  hooks.progress?.({ phase: 'history' });
  const since = historyStart(o);
  const prefix = path.relative(info.root, report.root).split(path.sep).join('/');
  const churn = await fileChurn(info.root, { since, ...(prefix ? { pathPrefix: prefix } : {}), signal });
  report.hotspots = computeHotspots(report, churn, { prefix });
  report.coverage.push(
    info.shallow
      ? { area: 'Puntos críticos', status: 'partial', detail: `Clon superficial: solo se dispone del historial descargado (desde ${since} como mucho); ${churn.size} archivo(s) con cambios.` }
      : { area: 'Puntos críticos', status: 'analyzed', detail: `Historial de Git desde ${since}: ${churn.size} archivo(s) con cambios.` },
  );
}
