import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packageDirOf, thirdPartyNotices } from '../scripts/licenses.js';
import type { WorkerHandle } from '../src/main/jobs.js';
import { checkRenderer, checkWorker } from '../src/main/smoke.js';
import type { FromWorker, ToWorker } from '../src/worker/protocol.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

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

describe('licencias del software empaquetado', () => {
  it('reconoce el paquete de cada módulo, con ámbito, en Windows y con consultas de Vite', () => {
    expect(packageDirOf('/r/node_modules/react/cjs/react.production.js')).toBe('/r/node_modules/react');
    expect(packageDirOf('C:\\r\\node_modules\\@fontsource-variable\\jetbrains-mono\\index.css?inline')).toBe('C:/r/node_modules/@fontsource-variable/jetbrains-mono');
    expect(packageDirOf('/r/node_modules/a/node_modules/b/index.js')).toBe('/r/node_modules/a/node_modules/b');
    expect(packageDirOf('/r/packages/engine/src/index.ts')).toBeNull();
  });

  it('una sección por paquete con su licencia y sus avisos, sin repetir', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'radar-licencias-'));
    dirs.push(root);
    const pkg = async (name: string, files: Record<string, string>): Promise<string> => {
      const dir = path.join(root, 'node_modules', name);
      await mkdir(dir, { recursive: true });
      for (const [f, text] of Object.entries(files)) await writeFile(path.join(dir, f), text);
      return dir;
    };
    const a = await pkg('a', { 'package.json': '{"name":"a","version":"1.0.0","license":"MIT"}', LICENSE: 'Texto MIT de a' });
    const b = await pkg('@x/b', { 'package.json': '{"name":"@x/b","version":"2.0.0","license":"Apache-2.0"}', 'LICENSE.txt': 'Apache', NOTICE: 'Aviso de b', 'README.md': 'no' });
    const { text, packages } = await thirdPartyNotices([`${a}/index.js`, `${a}/otro.js`, `${b}/dist/b.js`, path.join(root, 'src', 'propio.ts')]);
    expect(packages).toEqual(['@x/b@2.0.0', 'a@1.0.0']);
    expect(text).toContain('@x/b 2.0.0 (Apache-2.0)');
    expect(text).toContain('Apache\n\nAviso de b');
    expect(text).toContain('a 1.0.0 (MIT)\n-------------\nTexto MIT de a');
    expect(text).not.toContain('no\n');
  });
});
