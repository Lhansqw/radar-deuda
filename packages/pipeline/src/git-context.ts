import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha1, type AnalysisReport } from '@radar/engine';
import { computeHotspots, fileChurn, getRepoInfo, type FileChurn } from '@radar/sources';
import { historyStart } from './target.js';
import type { PipelineHooks } from './types.js';

/** Formato del archivo de caché del historial (cambiarlo invalida los anteriores). */
const CHURN_CACHE_FORMAT = 1;

interface ChurnCacheFile {
  format: number;
  key: string;
  files: FileChurn[];
}

/**
 * Frecuencia de cambio con caché. El historial hasta un commit no cambia, así
 * que se reutiliza mientras HEAD, la fecha de inicio, la carpeta y el tipo de
 * clon sean los mismos. Un archivo por repositorio: el siguiente commit lo
 * sustituye. En un reanálisis sin cambios era la mayor parte del tiempo.
 */
export async function cachedFileChurn(
  repoRoot: string,
  o: { head: string; shallow: boolean; since: string; prefix: string; cacheBase: string | null },
  signal: AbortSignal,
): Promise<{ churn: Map<string, FileChurn>; fromCache: boolean }> {
  const compute = (): Promise<Map<string, FileChurn>> => fileChurn(repoRoot, { since: o.since, ...(o.prefix ? { pathPrefix: o.prefix } : {}), signal });
  if (!o.cacheBase) return { churn: await compute(), fromCache: false };
  const file = path.join(o.cacheBase, 'git', `${sha1(repoRoot).slice(0, 20)}.json`);
  const key = [CHURN_CACHE_FORMAT, o.head, o.since, o.prefix, o.shallow ? 'superficial' : 'completo'].join('|');
  try {
    const cached = JSON.parse(await readFile(file, 'utf8')) as Partial<ChurnCacheFile>;
    if (cached.format === CHURN_CACHE_FORMAT && cached.key === key && Array.isArray(cached.files)) {
      return { churn: new Map(cached.files.map((f) => [f.file, f])), fromCache: true };
    }
  } catch {
    /* sin caché o dañada: se calcula */
  }
  const churn = await compute();
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const data: ChurnCacheFile = { format: CHURN_CACHE_FORMAT, key, files: [...churn.values()] };
    await writeFile(tmp, JSON.stringify(data), 'utf8');
    await rename(tmp, file);
  } catch {
    /* la caché es una optimización: si no se puede escribir, se sigue */
  }
  return { churn, fromCache: false };
}

/** Añade al informe el commit analizado y, si se pide, los puntos críticos del historial. */
export async function addGitContext(
  report: AnalysisReport,
  o: { history: boolean; since?: string },
  hooks: PipelineHooks,
  signal: AbortSignal,
  cacheBase: string | null = null,
): Promise<void> {
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
  const { churn } = await cachedFileChurn(info.root, { head: info.head, shallow: info.shallow, since, prefix, cacheBase }, signal);
  report.hotspots = computeHotspots(report, churn, { prefix });
  report.coverage.push(
    info.shallow
      ? { area: 'Puntos críticos', status: 'partial', detail: `Clon superficial: solo se dispone del historial descargado (desde ${since} como mucho); ${churn.size} archivo(s) con cambios.` }
      : { area: 'Puntos críticos', status: 'analyzed', detail: `Historial de Git desde ${since}: ${churn.size} archivo(s) con cambios.` },
  );
}
