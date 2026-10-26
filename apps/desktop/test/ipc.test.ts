import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialStore } from '../src/main/credentials.js';
import { createHandlers, type HandlerDeps } from '../src/main/handlers.js';
import { dispatch } from '../src/main/ipc-dispatch.js';
import { VALIDATORS } from '../src/main/ipc-validation.js';
import { Store } from '../src/main/store.js';
import { CHANNELS } from '../src/shared/ipc.js';
import { APP_ENTRY } from '../src/shared/origin.js';
import { DEFAULT_SETTINGS } from '../src/shared/settings.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

function setup(over: Partial<HandlerDeps> = {}) {
  const store = Store.open(':memory:');
  cleanup.push(() => store.close());
  const cipher = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s).reverse(), decryptString: (b: Buffer) => Buffer.from(b).reverse().toString() };
  const handlers = createHandlers({
    store,
    credentials: new CredentialStore(store, cipher, {}),
    jobs: { start: () => Promise.reject(new Error('no se usa')) as never, cancel: () => undefined, list: () => [] },
    ai: { explain: () => Promise.reject(new Error('no se usa')), openRouterModels: async () => [], checkOpenRouterKey: () => Promise.reject(new Error('no se usa')) },
    info: () => ({ versions: { app: '0.1.0', electron: '44', chrome: '152', node: '24' }, dataDir: '/datos', cacheDir: '/cache', reposDir: '/cache/repos' }),
    chooseFolder: async () => null,
    openExternal: async () => true,
    reveal: () => undefined,
    ...over,
  });
  const call = (channel: (typeof CHANNELS)[number], ...args: unknown[]) => dispatch(channel, APP_ENTRY, args, handlers, null);
  return { store, handlers, call };
}

describe('contrato IPC', () => {
  it('hay un validador para cada canal', () => {
    expect(Object.keys(VALIDATORS).sort()).toEqual([...CHANNELS].sort());
  });

  it('rechaza mensajes que no vienen de la interfaz de la aplicación', async () => {
    const { handlers } = setup();
    for (const sender of [undefined, 'https://evil.example/', 'file:///C:/x.html', 'app://otro/index.html']) {
      expect(await dispatch('projects:list', sender, [], handlers, null)).toEqual({ ok: false, error: 'Remitente no autorizado.' });
    }
    expect(await dispatch('projects:list', 'http://127.0.0.1:5173/', [], handlers, 'http://127.0.0.1:5173/')).toEqual({ ok: true, value: [] });
  });

  it('valida número y tipo de argumentos antes de llamar al manejador', async () => {
    const { call } = setup();
    expect(await call('projects:list', 'extra')).toEqual({ ok: false, error: 'Se esperaban 0 argumento(s) y se recibieron 1.' });
    expect(await call('projects:remove', '1')).toEqual({ ok: false, error: 'Proyecto no válido.' });
    expect(await call('projects:remove', -1)).toEqual({ ok: false, error: 'Proyecto no válido.' });
    expect(await call('analyses:report', 1.5)).toEqual({ ok: false, error: 'Análisis no válido.' });
    expect(await call('secrets:set', 'aws', 'x')).toEqual({ ok: false, error: 'Credencial desconocida.' });
    expect(await call('secrets:set', 'openrouter', 'x'.repeat(1001))).toEqual({ ok: false, error: 'Credencial no válida.' });
    expect(await call('app:openExternal', 42)).toEqual({ ok: false, error: 'Enlace no válido.' });
  });

  it('añade repositorios de GitHub normalizados y valida la rama', async () => {
    const { call } = setup();
    expect(await call('projects:addGithub', 'https://github.com/Lhansqw/radar-deuda.git', null)).toMatchObject({ ok: true, value: { name: 'radar-deuda', kind: 'github', location: 'Lhansqw/radar-deuda', branch: null } });
    expect(await call('projects:addGithub', 'Lhansqw/radar-deuda', '')).toEqual({ ok: false, error: 'El proyecto Lhansqw/radar-deuda ya está en la lista.' });
    expect(await call('projects:addGithub', 'org/otro', 'feature/x')).toMatchObject({ ok: true, value: { branch: 'feature/x' } });
    expect(await call('projects:addGithub', 'org/otro2', '--upload-pack=x')).toEqual({ ok: false, error: 'Nombre de rama no válido.' });
    expect(await call('projects:addGithub', 'org/otro2', 'a..b')).toEqual({ ok: false, error: 'Nombre de rama no válido.' });
    expect(await call('projects:addGithub', 'no es un repo', null)).toMatchObject({ ok: false, error: expect.stringMatching(/owner\/repo/) as unknown });
  });

  it('añade una carpeta elegida en el selector del sistema', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'radar-proyecto-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'archivo.txt');
    await writeFile(file, 'x');
    let choice: string | null = dir;
    const { call } = setup({ chooseFolder: async () => choice });
    expect(await call('projects:addFolder')).toMatchObject({ ok: true, value: { kind: 'local', location: dir, name: path.basename(dir) } });
    choice = null;
    expect(await call('projects:addFolder')).toEqual({ ok: true, value: null });
    choice = file;
    expect(await call('projects:addFolder')).toMatchObject({ ok: false, error: expect.stringMatching(/No existe la carpeta/) as unknown });
  });

  it('guarda ajustes válidos y rechaza los inválidos con todos sus errores', async () => {
    const { call } = setup();
    expect(await call('settings:get')).toEqual({ ok: true, value: DEFAULT_SETTINGS });
    const next = { ...DEFAULT_SETTINGS, analysis: { ...DEFAULT_SETTINGS.analysis, online: true } };
    expect(await call('settings:set', next)).toEqual({ ok: true, value: next });
    expect(await call('settings:get')).toEqual({ ok: true, value: next });
    const r = await call('settings:set', { ...next, ai: { ...next.ai, limit: 0, model: 'sin-barra' } });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Hallazgos a explicar.*Modelo: en OpenRouter/) as unknown });
  });

  it('las credenciales se pueden escribir y borrar, pero ninguna respuesta incluye su valor', async () => {
    const { call } = setup();
    const key = ['sk', 'or', 'v1', 'z'.repeat(64)].join('-');
    const r = await call('secrets:set', 'openrouter', key);
    expect(r).toMatchObject({ ok: true, value: { secrets: { openrouter: { stored: true } } } });
    expect(JSON.stringify(r)).not.toContain(key);
    expect(JSON.stringify(await call('secrets:status'))).not.toContain(key);
    expect(await call('secrets:delete', 'openrouter')).toMatchObject({ ok: true, value: { secrets: { openrouter: { stored: false } } } });
    expect(await call('secrets:set', 'openrouter', 'abcd')).toMatchObject({ ok: false, error: expect.stringMatching(/tiene 4 caracteres/) as unknown });
  });

  it('compara dos análisis del mismo proyecto y nunca de proyectos distintos', async () => {
    const { call, store } = setup();
    const base = {
      schemaVersion: 1,
      engineVersion: '0.1.0',
      root: '/r',
      config: {},
      summary: { bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, byCategory: {} },
      coverage: [],
      errors: [],
      stats: { durationMs: 1, filesDiscovered: 1, filesAnalyzed: 1, cacheHits: 0, skipped: [], cpuUserMs: 1, cpuSystemMs: 1, peakRssMb: 1 },
    };
    const f = (id: string) => ({ id, severity: 'high', title: id, locations: [] });
    const r = (score: number, ids: string[]) => ({ ...base, generatedAt: new Date().toISOString(), score: { score, rating: 'C', debtRatio: 0.1, remediationMinutes: score, developmentMinutes: 1, codeLines: 1 }, findings: ids.map(f) }) as never;
    const p1 = store.addProject({ name: 'a', kind: 'local', location: '/a' });
    const p2 = store.addProject({ name: 'b', kind: 'local', location: '/b' });
    const a1 = store.saveAnalysis(p1.id, r(60, ['x', 'y']), { startedAt: '', durationMs: 1 });
    const a2 = store.saveAnalysis(p1.id, r(70, ['y', 'z']), { startedAt: '', durationMs: 1 });
    const b1 = store.saveAnalysis(p2.id, r(50, []), { startedAt: '', durationMs: 1 });
    const c = await call('analyses:compare', a1.id, a2.id);
    expect(c.ok && c.value).toMatchObject({ scoreDelta: 10, persisting: 1, added: [{ id: 'z' }], resolved: [{ id: 'x' }] });
    expect(await call('analyses:compare', a1.id, b1.id)).toEqual({ ok: false, error: 'Solo se pueden comparar análisis del mismo proyecto.' });
    expect(await call('analyses:compare', a1.id, a1.id)).toEqual({ ok: false, error: 'Elige dos análisis distintos.' });
  });

  it('un análisis inexistente da un mensaje claro', async () => {
    const { call } = setup();
    expect(await call('analyses:report', 7)).toEqual({ ok: false, error: 'Ese análisis ya no existe.' });
  });
});
