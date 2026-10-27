import { describe, expect, it } from 'vitest';
import type { WorkerHandle } from '../src/main/jobs.js';
import { checkRenderer, checkWorker } from '../src/main/smoke.js';
import type { FromWorker, ToWorker } from '../src/worker/protocol.js';

describe('prueba de arranque del paquete', () => {
  it('la interfaz tiene que pintarse y estar aislada', async () => {
    const page = (isolation: string, renderedAfter = 0) => {
      let calls = 0;
      return { evaluate: async (e: string) => (e.includes('childElementCount') ? ++calls > renderedAfter : isolation) };
    };
    expect(await checkRenderer(page('object,undefined,undefined', 2), 5_000)).toEqual([]);
    expect(await checkRenderer(page('object,function,object'), 5_000)).toEqual([expect.stringMatching(/no está aislada/)]);
    expect(await checkRenderer(page('', 1_000_000), 300)).toEqual(['La interfaz no llegó a mostrarse.']);
  });

  /** Proceso de análisis simulado que responde a «start» con los mensajes indicados. */
  function worker(reply: (dir: string) => FromWorker[]): { spawn: () => WorkerHandle; received: ToWorker[] } {
    const received: ToWorker[] = [];
    const spawn = (): WorkerHandle => {
      let onMessage: (m: FromWorker) => void = () => undefined;
      return {
        postMessage: (m) => {
          received.push(m);
          if (m.type === 'start') setTimeout(() => reply(m.request.target).forEach((r) => onMessage(r)), 5);
        },
        onMessage: (cb) => (onMessage = cb),
        onExit: () => undefined,
        kill: () => undefined,
      };
    };
    return { spawn, received };
  }
  const report = (filesAnalyzed: number): FromWorker => ({ type: 'report', report: { stats: { filesAnalyzed } } as never, durationMs: 1 });

  it('el proceso de análisis analiza una carpeta temporal sin caché, historial ni red', async () => {
    const w = worker(() => [report(1), { type: 'finished' }]);
    expect(await checkWorker(w.spawn, 5_000)).toEqual([]);
    expect(w.received[0]).toMatchObject({ type: 'start', request: { history: false, online: false, noCache: true } });
  });

  it('informa si el análisis falla, analiza otra cosa o no termina', async () => {
    expect(await checkWorker(worker(() => [{ type: 'error', message: 'sin memoria', cancelled: false }]).spawn, 5_000)).toEqual(['El análisis falló: sin memoria']);
    expect(await checkWorker(worker(() => [report(0), { type: 'finished' }]).spawn, 5_000)).toEqual(['Se esperaba 1 archivo analizado y hubo 0.']);
    expect(await checkWorker(worker(() => []).spawn, 200)).toEqual(['El proceso de análisis no terminó a tiempo.']);
  });
});
