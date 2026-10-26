/**
 * Proceso de análisis (Electron utilityProcess). Ejecuta el motor fuera del
 * proceso principal: la interfaz no se bloquea y, si hay que cancelar y el
 * motor no responde, el proceso principal puede terminarlo sin más.
 */
import type { FromWorker, ToWorker } from './protocol.js';
import { runJob } from './run-job.js';

const port = process.parentPort;
const controller = new AbortController();
const post = (m: FromWorker): void => port.postMessage(m);
let started = false;

port.on('message', (e: { data: ToWorker }) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    controller.abort();
    return;
  }
  if (msg.type === 'start' && !started) {
    started = true;
    // El proceso principal lo termina al recibir el último mensaje; esto es solo una red de seguridad
    // (con margen para que los mensajes pendientes lleguen antes de salir).
    void runJob(msg, post, controller.signal).finally(() => setTimeout(() => process.exit(0), 5000));
  }
});
