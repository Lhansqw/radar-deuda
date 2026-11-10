/**
 * Proceso de análisis (Electron utilityProcess). Ejecuta el motor fuera del
 * proceso principal: la interfaz no se bloquea y, si hay que cancelar y el
 * motor no responde, el proceso principal puede terminarlo sin más.
 */
import { getHeapStatistics } from 'node:v8';
import { translator, type Locale } from '@radar/engine';
import { memoryPressure } from './memory.js';
import type { FromWorker, ToWorker } from './protocol.js';
import { runJob } from './run-job.js';

const port = process.parentPort;
const controller = new AbortController();
const post = (m: FromWorker): void => port.postMessage(m);
let started = false;
let locale: Locale = 'es';

// Se comprueba entre archivo y archivo (el motor cede el control en cada lectura).
const guard = setInterval(() => {
  const message = memoryPressure(getHeapStatistics(), undefined, locale);
  if (!message) return;
  clearInterval(guard);
  controller.abort();
  post({ type: 'error', message, cancelled: false });
  setTimeout(() => process.exit(3), 200);
}, 250);
guard.unref();

port.on('message', (e: { data: ToWorker }) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    controller.abort();
    return;
  }
  if (msg.type === 'start' && !started) {
    started = true;
    locale = msg.request.locale ?? 'es';
    const mb = Math.round(getHeapStatistics().heap_size_limit / (1024 * 1024));
    post({ type: 'log', level: 'info', message: translator(locale)(`Memoria máxima del análisis: ${mb} MB.`, `Maximum analysis memory: ${mb} MB.`) });
    // El proceso principal lo termina al recibir el último mensaje; esto es solo una red de seguridad
    // (con margen para que los mensajes pendientes lleguen antes de salir).
    void runJob(msg, post, controller.signal).finally(() => setTimeout(() => process.exit(0), 5000));
  }
});
