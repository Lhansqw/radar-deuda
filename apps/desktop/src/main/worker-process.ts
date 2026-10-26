import { utilityProcess } from 'electron';
import type { FromWorker, ToWorker } from '../worker/protocol.js';
import type { WorkerHandle } from './jobs.js';

/** Lanza el proceso de análisis (dist/worker.cjs) como utilityProcess de Electron. */
export function spawnAnalysisWorker(file: string): WorkerHandle {
  const child = utilityProcess.fork(file, [], { serviceName: 'Radar de Deuda Técnica (análisis)', stdio: 'inherit' });
  // Los mensajes enviados antes de que el proceso arranque se encolan.
  let spawned = false;
  const queue: ToWorker[] = [];
  child.once('spawn', () => {
    spawned = true;
    for (const m of queue.splice(0)) child.postMessage(m);
  });
  return {
    postMessage: (m) => (spawned ? child.postMessage(m) : queue.push(m)),
    onMessage: (cb) => child.on('message', (m: FromWorker) => cb(m)),
    onExit: (cb) => child.on('exit', cb),
    kill: () => {
      child.kill();
    },
  };
}
