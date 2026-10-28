import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountService, type AccountChange } from '../src/main/account-service.js';
import { cloudConfig, ENV_KEY, ENV_URL } from '../src/main/cloud-config.js';
import { EncryptedSessionStorage } from '../src/main/session-storage.js';
import { CODES, FAKE_KEY, FAKE_URL, FakeSupabase, type FakeSupabaseOptions } from './helpers/fake-supabase.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

const cipher = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s).reverse(), decryptString: (b: Buffer) => Buffer.from(b).reverse().toString() };
const PASSWORD = 'contraseña-larga-1';

async function setup(options: FakeSupabaseOptions = {}, server = new FakeSupabase(options), dir?: string) {
  const folder = dir ?? (await mkdtemp(path.join(os.tmpdir(), 'radar-cuenta-')));
  if (!dir) cleanup.push(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'sesion.bin');
  const changes: AccountChange[] = [];
  const account = new AccountService({
    config: cloudConfig({ [ENV_URL]: FAKE_URL, [ENV_KEY]: FAKE_KEY }, null),
    storage: new EncryptedSessionStorage(file, cipher),
    onChange: (c) => changes.push(c),
    fetch: server.fetch,
  });
  cleanup.push(() => account.dispose());
  return { account, server, changes, file, folder };
}

describe('AccountService', () => {
  it('sin configuración explica qué falta y no hace nada', async () => {
    const account = new AccountService({ config: cloudConfig({}, null), storage: new EncryptedSessionStorage('/no/se/usa', cipher), onChange: () => undefined });
    expect(await account.state()).toMatchObject({ status: 'unconfigured', message: expect.stringMatching(/RADAR_SUPABASE_URL/) });
    await expect(account.signIn('ana@ejemplo.com', PASSWORD, true)).rejects.toThrow(/RADAR_SUPABASE_URL/);
  });

  it('registro con confirmación por código: crea la cuenta, confirma el correo y entra', async () => {
    const { account, server, changes } = await setup();
    expect(await account.state()).toEqual({ status: 'signed-out' });
    expect(await account.signUp(' Ana@Ejemplo.com ', PASSWORD)).toEqual({ confirmEmail: true });
    expect(server.users.get('ana@ejemplo.com')?.confirmed).toBe(false);
    await expect(account.confirmEmail('ana@ejemplo.com', '000000')).rejects.toThrow('El código no es correcto o ya caducó. Pide uno nuevo.');
    expect(await account.confirmEmail('ana@ejemplo.com', ` ${CODES.signup} `)).toEqual({ status: 'signed-in', email: 'ana@ejemplo.com', offline: false });
    expect(changes.at(-1)?.user).toEqual({ id: server.users.get('ana@ejemplo.com')?.id, email: 'ana@ejemplo.com' });
  });

  it('registro sin confirmación (desactivada en el proyecto): entra directamente; repetido, avisa', async () => {
    const { account } = await setup({ confirmEmail: false });
    expect(await account.signUp('ana@ejemplo.com', PASSWORD)).toEqual({ confirmEmail: false });
    expect(await account.state()).toMatchObject({ status: 'signed-in' });
    await account.signOut();
    await expect(account.signUp('ana@ejemplo.com', PASSWORD)).rejects.toThrow(/Ya hay una cuenta con ese correo/);
  });

  it('valida el correo y la contraseña antes de llamar a Supabase', async () => {
    const { account, server } = await setup();
    await expect(account.signUp('ana', PASSWORD)).rejects.toThrow('Ese correo no parece válido.');
    await expect(account.signUp('ana@ejemplo.com', 'corta')).rejects.toThrow(/al menos 8/);
    expect(server.requests).toEqual([]);
  });

  it('inicio de sesión: credenciales malas, correo sin confirmar y correcto', async () => {
    const { account, server } = await setup();
    server.addUser('ana@ejemplo.com', PASSWORD);
    server.addUser('luis@ejemplo.com', PASSWORD, false);
    await expect(account.signIn('ana@ejemplo.com', 'otra-contraseña', true)).rejects.toThrow('El correo o la contraseña no son correctos.');
    expect(await account.signIn('luis@ejemplo.com', PASSWORD, true)).toEqual({ confirmEmail: true });
    expect(await account.state()).toEqual({ status: 'signed-out' });
    expect(await account.signIn('ANA@ejemplo.com', PASSWORD, true)).toEqual({ confirmEmail: false });
    expect(await account.state()).toEqual({ status: 'signed-in', email: 'ana@ejemplo.com', offline: false });
  });

  it('«seguir conectado»: la sesión guardada se recupera al abrir de nuevo; sin él, no', async () => {
    const server = new FakeSupabase();
    server.addUser('ana@ejemplo.com', PASSWORD);
    const first = await setup({}, server);
    await first.account.signIn('ana@ejemplo.com', PASSWORD, true);
    expect(readFileSync(first.file).toString()).not.toContain('refresh_token');
    first.account.dispose();
    const second = await setup({}, server, first.folder);
    await second.account.settled();
    expect(await second.account.state()).toEqual({ status: 'signed-in', email: 'ana@ejemplo.com', offline: false });

    await second.account.signIn('ana@ejemplo.com', PASSWORD, false);
    expect(existsSync(second.file)).toBe(false);
    second.account.dispose();
    const third = await setup({}, server, first.folder);
    expect(await third.account.state()).toEqual({ status: 'signed-out' });
  });

  it('abre al instante con la sesión guardada, sin esperar a la red (también sin conexión)', async () => {
    const server = new FakeSupabase();
    server.expiresIn = -60; // caducada: al abrir hay que renovarla
    const user = server.addUser('ana@ejemplo.com', PASSWORD);
    const first = await setup({}, server);
    await first.account.signIn('ana@ejemplo.com', PASSWORD, true);
    first.account.dispose();
    // Sin conexión, Supabase Auth reintenta la renovación durante unos segundos; la aplicación no espera.
    server.offline = true;
    const started = Date.now();
    const second = await setup({}, server, first.folder);
    expect(await second.account.state()).toEqual({ status: 'signed-in', email: 'ana@ejemplo.com', offline: false });
    expect(await second.account.user()).toEqual({ id: user.id, email: 'ana@ejemplo.com' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('una sesión revocada en el servidor no se recupera', async () => {
    const server = new FakeSupabase();
    server.expiresIn = -60; // ya caducada: al abrir hay que renovarla
    server.addUser('ana@ejemplo.com', PASSWORD);
    const first = await setup({}, server);
    await first.account.signIn('ana@ejemplo.com', PASSWORD, true);
    first.account.dispose();
    server.revokeAll();
    const second = await setup({}, server, first.folder);
    await second.account.settled();
    expect(await second.account.state()).toEqual({ status: 'signed-out' });
    expect(second.changes.at(-1)).toEqual({ state: { status: 'signed-out' }, user: null });
    expect(existsSync(second.file)).toBe(false);
  });

  it('recuperación: código y contraseña nueva; si la rechaza, se elige otra sin pedir otro código', async () => {
    const { account, server } = await setup({ minPassword: 10 });
    server.addUser('ana@ejemplo.com', PASSWORD);
    expect(await account.requestPasswordReset('ana@ejemplo.com')).toBeNull();
    // Una cuenta que no existe recibe la misma respuesta.
    expect(await account.requestPasswordReset('nadie@ejemplo.com')).toBeNull();
    await expect(account.resetPassword('ana@ejemplo.com', '111111', 'nueva-clave-segura')).rejects.toThrow(/El código no es correcto/);
    await expect(account.resetPassword('ana@ejemplo.com', CODES.recovery, 'corta-123')).rejects.toThrow('La contraseña no es lo bastante segura: es demasiado corta.');
    expect(await account.state()).toEqual({ status: 'password-reset', email: 'ana@ejemplo.com' });
    await expect(account.setNewPassword(PASSWORD)).rejects.toThrow('La contraseña nueva debe ser distinta de la anterior.');
    expect(await account.setNewPassword('nueva-clave-segura')).toEqual({ status: 'signed-in', email: 'ana@ejemplo.com', offline: false });
    expect(server.users.get('ana@ejemplo.com')?.password).toBe('nueva-clave-segura');
  });

  it('la contraseña nueva solo se acepta tras un código de recuperación', async () => {
    const { account } = await setup();
    await expect(account.setNewPassword('nueva-clave-segura')).rejects.toThrow(/código de recuperación/);
  });

  it('IA incluida: con sesión da la función «ia» y el token de la sesión; sin sesión, nada', async () => {
    const { account, server } = await setup();
    server.addUser('ana@ejemplo.com', PASSWORD);
    expect(account.includedAi()).toBeNull();
    await account.signIn('ana@ejemplo.com', PASSWORD, true);
    const access = account.includedAi();
    expect(access).toEqual({ url: `${FAKE_URL}/functions/v1/ia`, token: expect.any(String) as unknown });
    expect(access?.token.length).toBeGreaterThan(10);
    await account.signOut();
    expect(account.includedAi()).toBeNull();
  });

  it('cerrar sesión borra la sesión guardada, también sin conexión', async () => {
    const { account, server, file, changes } = await setup();
    server.addUser('ana@ejemplo.com', PASSWORD);
    await account.signIn('ana@ejemplo.com', PASSWORD, true);
    expect(existsSync(file)).toBe(true);
    server.offline = true;
    expect(await account.signOut()).toEqual({ status: 'signed-out' });
    expect(existsSync(file)).toBe(false);
    expect(changes.at(-1)).toEqual({ state: { status: 'signed-out' }, user: null });
  });

  it('traduce los errores de red y de la clave publicable', async () => {
    const { account, server } = await setup();
    server.offline = true;
    await expect(account.signIn('ana@ejemplo.com', PASSWORD, true)).rejects.toThrow(/No se pudo conectar con Supabase/);
    const other = new AccountService({
      config: cloudConfig({ [ENV_URL]: FAKE_URL, [ENV_KEY]: 'sb_publishable_otra_clave_0123' }, null),
      storage: new EncryptedSessionStorage(path.join(os.tmpdir(), 'radar-no-se-escribe.bin'), { ...cipher, isEncryptionAvailable: () => false }),
      onChange: () => undefined,
      fetch: new FakeSupabase().fetch,
    });
    cleanup.push(() => other.dispose());
    await expect(other.signIn('ana@ejemplo.com', PASSWORD, true)).rejects.toThrow(/RADAR_SUPABASE_PUBLISHABLE_KEY/);
  });
});
