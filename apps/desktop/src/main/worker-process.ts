import { utilityProcess } from 'electron';
import type { FromWorker, ToWorker } from '../worker/protocol.js';
import type { WorkerHandle } from './jobs.js';

/**
 * Lanza el proceso de análisis (dist/worker.cjs) como utilityProcess de
 * Electron, con su propio límite de montículo: un repositorio enorme no puede
 * agotar la memoria del equipo, y el proceso se detiene antes con un aviso
 * (worker/memory.ts).
 */
export function spawnAnalysisWorker(file: string, memoryLimitMb: number): WorkerHandle {
  const child = utilityProcess.fork(file, [], {
    serviceName: 'Radar de Deuda Técnica (análisis)',
    stdio: 'inherit',
    // Como opción de V8 (--js-flags): el montículo de un utilityProcess se crea antes de que
    // Node lea sus propias opciones, así que --max-old-space-size a secas no tendría efecto.
    execArgv: [`--js-flags=--max-old-space-size=${Math.round(memoryLimitMb)}`],
  });
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
