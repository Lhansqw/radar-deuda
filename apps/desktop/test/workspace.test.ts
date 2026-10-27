import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAccountHandlers, type AccountApi } from '../src/main/account-handlers.js';
import type { AppDeps } from '../src/main/handlers.js';
import { dispatch } from '../src/main/ipc-dispatch.js';
import { Store } from '../src/main/store.js';
import { openWorkspace, SessionRouter, type Workspace } from '../src/main/workspace.js';
import type { AccountState } from '../src/shared/account.js';
import type { CHANNELS } from '../src/shared/ipc.js';
import { APP_ENTRY } from '../src/shared/origin.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

const ANA = { id: '6f1c2a4e-9b3d-4c5e-8f70-112233445566', email: 'ana@ejemplo.com' };
const LUIS = { id: '0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3', email: 'luis@ejemplo.com' };
const signedIn = (email: string): AccountState => ({ status: 'signed-in', email, offline: false });
const cipher = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() };
const noWorker = () => {
  throw new Error('no se usa');
};

const app: AppDeps = {
  info: () => ({ versions: { app: '0.1.0', electron: '44', chrome: '152', node: '24' }, dataDir: '/datos', cacheDir: '/cache', reposDir: '/cache/repos' }),
  chooseFolder: async () => null,
  openExternal: async () => true,
  reveal: () => undefined,
  copyText: () => undefined,
  savePatch: async () => null,
  storage: async () => ({ cache: { files: 0, bytes: 0, parts: [] }, clones: { files: 0, bytes: 0 } }),
  clearCache: async () => ({ files: 0, bytes: 0 }),
  removeClone: async () => undefined,
};

const account: AccountApi = {
  state: async () => ({ status: 'signed-out' }),
  signIn: async () => ({ confirmEmail: false }),
  signUp: async () => ({ confirmEmail: true }),
  confirmEmail: async () => signedIn(ANA.email),
  resendConfirmation: async () => null,
  requestPasswordReset: async () => null,
  resetPassword: async () => signedIn(ANA.email),
  setNewPassword: async () => signedIn(ANA.email),
  signOut: async () => ({ status: 'signed-out' }),
};

/** Espacios de trabajo en memoria que registran si se cerraron. */
function memoryWorkspaces() {
  const opened: Array<{ userId: string; closed: boolean }> = [];
  const open = (userId: string): Workspace => {
    const store = Store.open(':memory:');
    const entry = { userId, closed: false };
    opened.push(entry);
    const ws = openWorkspaceLike(userId, store);
    return {
      ...ws,
      dispose: () => {
        entry.closed = true;
        store.close();
      },
    };
  };
  return { opened, open };
}

function openWorkspaceLike(userId: string, store: Store): Workspace {
  return {
    userId,
    dir: `/datos/usuarios/${userId}`,
    store,
    credentials: { status: () => ({ encryptionAvailable: true, secrets: {} }) } as unknown as Workspace['credentials'],
    jobs: { start: () => Promise.reject(new Error('no se usa')) as never, cancel: () => undefined, list: () => [] },
    ai: {} as Workspace['ai'],
    dispose: () => store.close(),
  };
}

function setup() {
  const ws = memoryWorkspaces();
  const notified: AccountState[] = [];
  const router = new SessionRouter({ account: createAccountHandlers(account), app, open: ws.open, notify: (s) => notified.push(s) });
  cleanup.push(() => router.dispose());
  const call = (channel: (typeof CHANNELS)[number], ...args: unknown[]) => dispatch(channel, APP_ENTRY, args, router.handlers(), null);
  return { router, call, notified, opened: ws.opened };
}

describe('SessionRouter', () => {
  it('sin sesión solo responden la cuenta, app:info y abrir enlaces', async () => {
    const { call } = setup();
    expect(await call('projects:list')).toEqual({ ok: false, error: 'Inicia sesión para continuar.' });
    expect(await call('settings:get')).toEqual({ ok: false, error: 'Inicia sesión para continuar.' });
    expect(await call('secrets:status')).toEqual({ ok: false, error: 'Inicia sesión para continuar.' });
    expect(await call('account:state')).toEqual({ ok: true, value: { status: 'signed-out' } });
    expect(await call('app:info')).toMatchObject({ ok: true });
    expect(await call('app:openExternal', 'https://supabase.com/')).toEqual({ ok: true, value: true });
  });

  it('con sesión, cada usuario ve sus datos; al cambiar de usuario se cierra lo del anterior', async () => {
    const { router, call, notified, opened } = setup();
    router.change({ state: signedIn(ANA.email), user: ANA });
    expect(router.userDir).toBe(`/datos/usuarios/${ANA.id}`);
    expect(await call('projects:list')).toEqual({ ok: true, value: [] });
    await call('projects:addGithub', 'ana/tienda', null);
    expect(await call('projects:list')).toMatchObject({ ok: true, value: [{ location: 'ana/tienda' }] });

    // La misma sesión renovada no vuelve a abrir nada.
    router.change({ state: signedIn(ANA.email), user: ANA });
    expect(opened).toHaveLength(1);

    router.change({ state: signedIn(LUIS.email), user: LUIS });
    expect(opened).toEqual([
      { userId: ANA.id, closed: true },
      { userId: LUIS.id, closed: false },
    ]);
    expect(await call('projects:list')).toEqual({ ok: true, value: [] });

    router.change({ state: { status: 'signed-out' }, user: null });
    expect(opened[1]?.closed).toBe(true);
    expect(router.userDir).toBeNull();
    expect(await call('projects:list')).toEqual({ ok: false, error: 'Inicia sesión para continuar.' });
    expect(notified.map((s) => s.status)).toEqual(['signed-in', 'signed-in', 'signed-in', 'signed-out']);
  });

  it('la recuperación de contraseña no abre los datos hasta tener la nueva', async () => {
    const { router, call, opened } = setup();
    router.change({ state: { status: 'password-reset', email: ANA.email }, user: null });
    expect(opened).toEqual([]);
    expect(await call('projects:list')).toEqual({ ok: false, error: 'Inicia sesión para continuar.' });
  });
});

describe('openWorkspace', () => {
  it('abre la base de datos del usuario en su carpeta, con los datos de antes de las cuentas', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'radar-espacio-'));
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
    const legacy = Store.open(path.join(dataDir, 'radar.db'));
    legacy.addProject({ name: 'tienda', kind: 'local', location: '/proyectos/tienda' });
    legacy.close();
    const ws = openWorkspace(ANA.id, { dataDir, cipher, spawn: noWorker, emit: () => undefined });
    expect(ws.dir).toBe(path.join(dataDir, 'usuarios', ANA.id));
    expect(ws.store.listProjects().map((p) => p.name)).toEqual(['tienda']);
    ws.dispose();
    expect(existsSync(path.join(dataDir, 'radar.db'))).toBe(false);

    // Otro usuario empieza vacío, aunque aparezca otra vez un radar.db suelto.
    writeFileSync(path.join(dataDir, 'radar.db'), '');
    const luis = openWorkspace(LUIS.id, { dataDir, cipher, spawn: noWorker, emit: () => undefined });
    expect(luis.store.listProjects()).toEqual([]);
    luis.dispose();
  });
});
