import path from 'node:path';
import { analyzeRepository, DEFAULT_PROJECT_ANALYZERS, defaultCacheDir, type AnalysisReport, type ProjectAnalyzer } from '@radar/engine';
import { NpmRegistryClient, OsvClient, outdatedAnalyzer, vulnerabilityAnalyzer } from '@radar/sources';
import { runAiStep, type AiOptions, type ApiKeys } from './ai.js';
import { addGitContext } from './git-context.js';
import { resolveTarget, type SourceOptions } from './target.js';
import type { PipelineHooks } from './types.js';

export interface PipelineRequest extends SourceOptions {
  /** Consultar vulnerabilidades (OSV) y versiones (registro npm). Solo se envían nombres y versiones. */
  online: boolean;
  /** Desactiva todas las cachés (motor, dependencias en línea e IA). */
  noCache: boolean;
  /** Carpeta de la caché del motor (por defecto, la de la aplicación). */
  cacheDir?: string;
  /** Carpeta base de las cachés de dependencias en línea e IA (por defecto, la de la aplicación). */
  cacheBase?: string;
  /** Lecturas simultáneas del motor. */
  concurrency?: number;
  ai?: AiOptions;
  keys?: ApiKeys;
}

export interface PipelineResult {
  report: AnalysisReport;
  /** Proveedor y modelos de la IA, si se ejecutó. */
  aiLabel?: string;
}

function onlineAnalyzers(cacheBase: string | null): ProjectAnalyzer[] {
  return [
    vulnerabilityAnalyzer(new OsvClient({ cacheDir: cacheBase ? path.join(cacheBase, 'osv') : null })),
    outdatedAnalyzer(new NpmRegistryClient({ cacheDir: cacheBase ? path.join(cacheBase, 'npm') : null })),
  ];
}

/**
 * Análisis completo: resuelve el origen (carpeta o clon de GitHub), ejecuta el
 * motor, añade el contexto de Git y, si se pide, la capa de IA. No imprime
 * nada: informa mediante `hooks`.
 */
export async function runPipeline(req: PipelineRequest, hooks: PipelineHooks, signal: AbortSignal): Promise<PipelineResult> {
  const { dir } = await resolveTarget(req, hooks, signal);
  if (req.online) hooks.info('Modo en línea: se enviarán nombres y versiones de paquetes a api.osv.dev y registry.npmjs.org.');
  const cacheBase = req.noCache ? null : (req.cacheBase ?? defaultCacheDir());

  const report = await analyzeRepository(dir, {
    config: req.concurrency !== undefined ? { concurrency: req.concurrency } : {},
    ...(req.noCache ? { cacheDir: null } : req.cacheDir ? { cacheDir: req.cacheDir } : {}),
    ...(req.online ? { projectAnalyzers: [...DEFAULT_PROJECT_ANALYZERS, ...onlineAnalyzers(cacheBase)] } : {}),
    signal,
    onProgress: (e) => {
      if (e.phase === 'discovery') hooks.progress?.({ phase: 'discovery' });
      if (e.phase === 'files') hooks.progress?.({ phase: 'files', done: e.done, total: e.total });
      if (e.phase === 'cross-file') hooks.progress?.({ phase: 'cross-file' });
      if (e.phase === 'project') hooks.progress?.({ phase: 'project', online: req.online });
    },
  });
  await addGitContext(report, req, hooks, signal, cacheBase);

  let aiLabel: string | undefined;
  if (req.ai) {
    const r = await runAiStep(report, req.ai, req.keys ?? {}, hooks, signal, cacheBase);
    report.ai = r.section;
    aiLabel = r.label;
  }
  hooks.progress?.({ phase: 'done' });
  return { report, ...(aiLabel !== undefined ? { aiLabel } : {}) };
}
