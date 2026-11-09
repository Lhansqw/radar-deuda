import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AccountService } from '../../src/main/account-service.js';
import { cloudConfig, ENV_KEY, ENV_URL } from '../../src/main/cloud-config.js';
import { EncryptedSessionStorage } from '../../src/main/session-storage.js';
import { FAKE_KEY, FAKE_URL, type FakeSupabase } from './fake-supabase.js';

export const TEST_PASSWORD = 'contraseña-larga-1';

/** Sin cifrado del sistema: la sesión no se guarda en disco. */
const cipher = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() };

/**
 * Una cuenta con la sesión iniciada contra el Supabase simulado (la crea si no
 * existe). Lo que hay que limpiar al terminar se añade a `cleanup`.
 */
export async function signedInAccount(server: FakeSupabase, email: string, cleanup: Array<() => Promise<void> | void>): Promise<AccountService> {
  if (!server.users.has(email)) server.addUser(email, TEST_PASSWORD);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'radar-cuenta-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const account = new AccountService({
    config: cloudConfig({ [ENV_URL]: FAKE_URL, [ENV_KEY]: FAKE_KEY }, null),
    storage: new EncryptedSessionStorage(path.join(dir, 'sesion.bin'), cipher),
    onChange: () => undefined,
    fetch: server.fetch,
    retryReads: false,
  });
  cleanup.push(() => account.dispose());
  await account.signIn(email, TEST_PASSWORD, false);
  return account;
}
