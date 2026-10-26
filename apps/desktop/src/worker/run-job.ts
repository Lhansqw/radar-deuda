import { defaultCacheDir } from '@radar/engine';
import { runAiStep, runPipeline, type PipelineHooks } from '@radar/pipeline';
import type { FromWorker, StartMessage } from './protocol.js';

/**
 * Trabajo del proceso de análisis, separado de su punto de entrada para
 * probarlo sin Electron. Nunca lanza: informa de todo con `post`.
 */
export async function runJob(msg: StartMessage, post: (m: FromWorker) => void, signal: AbortSignal): Promise<void> {
  const hooks: PipelineHooks = {
    info: (message) => post({ type: 'log', level: 'info', message }),
    warn: (message) => post({ type: 'log', level: 'warn', message }),
    progress: (event) => post({ type: 'event', event }),
  };
  const started = performance.now();
  let report;
  try {
    ({ report } = await runPipeline(msg.request, { ...hooks, progress: (e) => e.phase !== 'done' && hooks.progress?.(e) }, signal));
  } catch (err) {
    if (signal.aborted) post({ type: 'error', message: 'Análisis cancelado.', cancelled: true });
    else post({ type: 'error', message: err instanceof Error ? err.message : String(err), cancelled: false });
    return;
  }
  post({ type: 'report', report, durationMs: performance.now() - started });

  if (msg.ai) {
    try {
      const cacheBase = msg.request.noCache ? null : (msg.request.cacheBase ?? defaultCacheDir());
      const r = await runAiStep(report, msg.ai.options, msg.ai.keys, hooks, signal, cacheBase);
      post({ type: 'ai', section: r.section, label: r.label });
    } catch (err) {
      if (signal.aborted) {
        post({ type: 'error', message: 'Análisis cancelado durante la IA. El análisis del motor se guardó.', cancelled: true });
        return;
      }
      post({ type: 'ai-error', message: err instanceof Error ? err.message : String(err) });
    }
  }
  post({ type: 'finished' });
}
