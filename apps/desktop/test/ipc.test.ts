import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAccountHandlers, signedInHandlers, type AccountApi } from '../src/main/account-handlers.js';
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

const signedIn = { status: 'signed-in', email: 'ana@ejemplo.com', offline: false } as const;
/** Cuenta simulada: los canales de la cuenta se prueban en account-handlers.test.ts. */
const fakeAccount: AccountApi = {
  state: async () => signedIn,
  signIn: async () => ({ confirmEmail: false }),
  signUp: async () => ({ confirmEmail: true }),
  confirmEmail: async () => signedIn,
  resendConfirmation: async () => null,
  requestPasswordReset: async () => null,
  resetPassword: async () => signedIn,
  setNewPassword: async () => signedIn,
  signOut: async () => ({ status: 'signed-out' }),
};

const syncState = { status: 'idle', lastSyncAt: null, message: null, pending: { projects: 0, analyses: 0, removals: 0 }, received: 0 } as const;
/** Copia en la nube simulada: registra lo que se le pide. */
const syncCalls: string[] = [];
const fakeSync: HandlerDeps['sync'] = {
  current: () => syncState,
  now: async () => (syncCalls.push('now'), syncState),
  schedule: () => void syncCalls.push('schedule'),
  deleteCloudCopy: async () => (syncCalls.push('deleteCloudCopy'), syncState),
};

function setup(over: Partial<HandlerDeps> = {}) {
  const store = Store.open(':memory:');
  cleanup.push(() => store.close());
  const cipher = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s).reverse(), decryptString: (b: Buffer) => Buffer.from(b).reverse().toString() };
  const workspace = createHandlers({
    store,
    credentials: new CredentialStore(store, cipher, {}),
    jobs: { start: () => Promise.reject(new Error('no se usa')) as never, cancel: () => undefined, list: () => [] },
    ai: {
      explain: () => Promise.reject(new Error('no se usa')),
      openRouterModels: async () => [],
      checkOpenRouterKey: () => Promise.reject(new Error('no se usa')),
      fixPreview: () => Promise.reject(new Error('no se usa')),
      proposeFix: () => Promise.reject(new Error('no se usa')),
      getFix: async () => null,
      ask: () => Promise.reject(new Error('no se usa')),
    },
    info: () => ({ versions: { app: '0.1.0', electron: '44', chrome: '152', node: '24' }, dataDir: '/datos', cacheDir: '/cache', reposDir: '/cache/repos' }),
    chooseFolder: async () => null,
    openExternal: async () => true,
    reveal: () => undefined,
    copyText: () => undefined,
    savePatch: async () => null,
    storage: async () => ({ cache: { files: 0, bytes: 0, parts: [] }, clones: { files: 0, bytes: 0 } }),
    clearCache: async () => ({ files: 0, bytes: 0 }),
    removeClone: async () => undefined,
    sync: fakeSync,
    ...over,
  });
  const handlers = signedInHandlers(workspace, createAccountHandlers(fakeAccount));
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

  it('valida los argumentos de la cuenta sin repetirlos en el error', async () => {
    const { call } = setup();
    expect(await call('account:signIn', 'ana@ejemplo.com', 'contraseña-larga', 'sí')).toEqual({ ok: false, error: 'Opción no válida.' });
    expect(await call('account:signIn', 'ana@ejemplo.com', '', true)).toEqual({ ok: false, error: 'Contraseña no válida.' });
    expect(await call('account:signIn', 42, 'contraseña-larga', true)).toEqual({ ok: false, error: 'Correo no válido.' });
    expect(await call('account:confirmEmail', 'ana@ejemplo.com', '12a456')).toEqual({ ok: false, error: 'El código son los dígitos que llegaron a tu correo.' });
    expect(await call('account:confirmEmail', 'ana@ejemplo.com', ' 123456 ')).toMatchObject({ ok: true, value: { status: 'signed-in' } });
    expect(await call('account:setNewPassword', 'x'.repeat(1001))).toEqual({ ok: false, error: 'Contraseña no válida.' });
    expect(await call('account:signOut')).toEqual({ ok: true, value: { status: 'signed-out' } });
  });

  it('guardar los ajustes aplica enseguida la copia en la nube; borrarla la desactiva primero', async () => {
    const { call } = setup();
    syncCalls.length = 0;
    await call('settings:set', { ...DEFAULT_SETTINGS, cloud: { sync: true } });
    expect(syncCalls).toEqual(['schedule']);
    expect(await call('sync:deleteCloud')).toEqual({ ok: true, value: syncState });
    expect(syncCalls).toEqual(['schedule', 'deleteCloudCopy', 'now']);
    expect(await call('settings:get')).toMatchObject({ ok: true, value: { cloud: { sync: false } } });
    expect(await call('sync:state')).toEqual({ ok: true, value: syncState });
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

  it('propuestas y preguntas: valida hallazgo, confirmación y pregunta; el parche lo guarda el proceso principal', async () => {
    const saved: Array<[string, string]> = [];
    const copied: string[] = [];
    const { call, store } = setup({ savePatch: async (name, content) => (saved.push([name, content]), `C:\\descargas\\${name}`), copyText: (t) => void copied.push(t) });
    expect(await call('ai:proposeFix', 1, 'f1', 'sí')).toEqual({ ok: false, error: 'Confirmación no válida.' });
    expect(await call('ai:fixPreview', 1, '../x')).toEqual({ ok: false, error: 'Hallazgo no válido.' });
    expect(await call('chat:ask', 1, '   ')).toEqual({ ok: false, error: 'Escribe una pregunta.' });
    expect(await call('chat:ask', 1, 'x'.repeat(2001))).toEqual({ ok: false, error: 'La pregunta es demasiado larga (máximo 2000 caracteres).' });
    expect(await call('app:copyText', 'parche')).toEqual({ ok: true, value: null });
    expect(copied).toEqual(['parche']);

    const project = store.addProject({ name: 'mi tienda', kind: 'local', location: '/t' });
    const analysis = store.saveAnalysis(project.id, { score: { score: 1, rating: 'E', debtRatio: 1, remediationMinutes: 1, developmentMinutes: 1, codeLines: 1 }, findings: [], summary: { bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } } } as never, { startedAt: '', durationMs: 1 });
    expect(await call('files:savePatch', analysis.id, 'abcdef1234567890')).toEqual({ ok: false, error: 'No hay ningún parche que guardar.' });
    store.saveFixProposal(analysis.id, { findingId: 'abcdef1234567890', patch: 'diff --git a/x b/x\n', createdAt: '2026-10-26T00:00:00Z' } as never);
    expect(await call('files:savePatch', analysis.id, 'abcdef1234567890')).toEqual({ ok: true, value: 'C:\\descargas\\mi-tienda-abcdef12.patch' });
    expect(saved).toEqual([['mi-tienda-abcdef12.patch', 'diff --git a/x b/x\n']]);

    store.addChatMessage(analysis.id, { role: 'user', content: 'hola' });
    expect(await call('chat:list', analysis.id)).toMatchObject({ ok: true, value: [{ role: 'user', content: 'hola' }] });
    expect(await call('chat:clear', analysis.id)).toEqual({ ok: true, value: null });
    expect(store.listChatMessages(analysis.id)).toEqual([]);
  });

  it('quitar un proyecto de GitHub borra su clon; nunca la carpeta de uno local, ni con un análisis en curso', async () => {
    const removed: string[] = [];
    let running: number | null = null;
    const { call, store } = setup({
      removeClone: async (repo) => void removed.push(repo),
      jobs: { start: () => Promise.reject(new Error('no se usa')) as never, cancel: () => undefined, list: () => (running === null ? [] : [{ projectId: running, status: 'running' } as never]) },
    });
    const gh = store.addProject({ name: 'demo', kind: 'github', location: 'owner/demo' });
    const local = store.addProject({ name: 'local', kind: 'local', location: '/mi/carpeta' });
    running = gh.id;
    expect(await call('projects:remove', gh.id)).toEqual({ ok: false, error: 'Hay un análisis en curso de este proyecto: cancélalo antes de quitarlo.' });
    running = null;
    expect(await call('projects:remove', gh.id)).toEqual({ ok: true, value: null });
    expect(await call('projects:remove', local.id)).toEqual({ ok: true, value: null });
    expect(removed).toEqual(['owner/demo']);
    expect(store.listProjects()).toEqual([]);
  });

  it('un análisis inexistente da un mensaje claro', async () => {
    const { call } = setup();
    expect(await call('analyses:report', 7)).toEqual({ ok: false, error: 'Ese análisis ya no existe.' });
  });
});
