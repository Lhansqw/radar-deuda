import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FromWorker } from '../worker/protocol.js';
import type { WorkerHandle } from './jobs.js';

/**
 * Prueba de arranque de la aplicación empaquetada: `radar-deuda --prueba-arranque`.
 *
 * Con los *fuses* de la versión instalada no se puede controlar la aplicación
 * desde fuera (sin --inspect ni ELECTRON_RUN_AS_NODE), así que la prueba de
 * extremo a extremo usa la versión sin empaquetar. Esta comprueba lo que solo
 * existe en el paquete: que la interfaz se carga desde el ASAR con el puente
 * seguro y que el proceso de análisis arranca desde el ASAR y analiza una
 * carpeta. Usa una carpeta de datos temporal: nunca toca la del usuario.
 */
export const SMOKE_FLAG = '--prueba-arranque';

export interface SmokePage {
  /** Ejecuta una expresión en la interfaz (webContents.executeJavaScript). */
  evaluate(expression: string): Promise<unknown>;
}

const SAMPLE = `export function clasificar(n: number): string {
  if (n < 0) {
    if (n < -10) return 'muy negativo';
    return 'negativo';
  }
  return n === 0 ? 'cero' : 'positivo';
}
`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Espera a que la interfaz pinte su primera vista y comprueba el aislamiento. */
export async function checkRenderer(page: SmokePage, timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rendered = await page.evaluate(`document.querySelector('#root')?.childElementCount > 0`).catch(() => false);
    if (rendered === true) break;
    if (Date.now() > deadline) return ['La interfaz no llegó a mostrarse.'];
    await sleep(100);
  }
  const isolation = (await page.evaluate(`[typeof window.radar, typeof require, typeof process].join(',')`)) as string;
  return isolation === 'object,undefined,undefined' ? [] : [`La interfaz no está aislada como se espera (radar, require, process: ${isolation}).`];
}

/** Analiza una carpeta temporal con un archivo en el proceso de análisis real. */
export async function checkWorker(spawn: (memoryLimitMb: number) => WorkerHandle, timeoutMs: number): Promise<string[]> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'radar-prueba-'));
  try {
    await writeFile(path.join(dir, 'clasificar.ts'), SAMPLE);
    const worker = spawn(512);
    const outcome = new Promise<string[]>((resolve) => {
      let analyzed = -1;
      const timer = setTimeout(() => resolve(['El proceso de análisis no terminó a tiempo.']), timeoutMs);
      const finish = (problems: string[]): void => {
        clearTimeout(timer);
        resolve(problems);
      };
      worker.onMessage((m: FromWorker) => {
        if (m.type === 'report') analyzed = m.report.stats.filesAnalyzed;
        else if (m.type === 'error') finish([`El análisis falló: ${m.message}`]);
        else if (m.type === 'finished') finish(analyzed === 1 ? [] : [`Se esperaba 1 archivo analizado y hubo ${analyzed}.`]);
      });
      worker.onExit((code) => finish([`El proceso de análisis terminó antes de tiempo (código ${code}).`]));
    });
    worker.postMessage({ type: 'start', request: { target: dir, history: false, online: false, noCache: true } });
    const problems = await outcome;
    worker.kill();
    return problems;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
