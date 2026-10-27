import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EncryptedSessionStorage } from '../src/main/session-storage.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function sessionFile(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'radar-sesion-'));
  dirs.push(d);
  return path.join(d, 'cuenta', 'sesion.bin');
}

/** Cifrado de prueba: invierte los bytes (lo bastante para comprobar que no se guarda en claro). */
const cipher = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s: string) => Buffer.from(s).reverse(),
  decryptString: (b: Buffer) => {
    const s = Buffer.from(b).reverse().toString();
    if (!s.startsWith('{')) throw new Error('no descifrable');
    return s;
  },
});

const TOKEN = 'token-de-renovacion-de-prueba';

describe('EncryptedSessionStorage', () => {
  it('guarda la sesión cifrada y la recupera al abrir de nuevo', async () => {
    const file = await sessionFile();
    const a = new EncryptedSessionStorage(file, cipher());
    expect(await a.getItem('sesion')).toBeNull();
    await a.setItem('sesion', TOKEN);
    expect(readFileSync(file).toString()).not.toContain(TOKEN);
    const b = new EncryptedSessionStorage(file, cipher());
    expect(await b.getItem('sesion')).toBe(TOKEN);
    await b.removeItem('sesion');
    expect(existsSync(file)).toBe(false);
  });

  it('sin «seguir conectado», la sesión solo vive en memoria y se borra el archivo', async () => {
    const file = await sessionFile();
    const s = new EncryptedSessionStorage(file, cipher());
    await s.setItem('sesion', TOKEN);
    s.setPersist(false);
    expect(existsSync(file)).toBe(false);
    await s.setItem('sesion', `${TOKEN}-2`);
    expect(await s.getItem('sesion')).toBe(`${TOKEN}-2`);
    expect(existsSync(file)).toBe(false);
    expect(await new EncryptedSessionStorage(file, cipher()).getItem('sesion')).toBeNull();
  });

  it('sin cifrado del sistema nunca escribe en el disco', async () => {
    const file = await sessionFile();
    const s = new EncryptedSessionStorage(file, cipher(false));
    expect(s.canPersist).toBe(false);
    await s.setItem('sesion', TOKEN);
    expect(await s.getItem('sesion')).toBe(TOKEN);
    expect(existsSync(file)).toBe(false);
  });

  it('un archivo dañado o de otro usuario se descarta', async () => {
    const file = await sessionFile();
    await new EncryptedSessionStorage(file, cipher()).setItem('sesion', TOKEN);
    writeFileSync(file, 'basura');
    const s = new EncryptedSessionStorage(file, cipher());
    expect(await s.getItem('sesion')).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it('clear olvida todo', async () => {
    const file = await sessionFile();
    const s = new EncryptedSessionStorage(file, cipher());
    await s.setItem('a', '1');
    await s.setItem('b', '2');
    s.clear();
    expect(await s.getItem('a')).toBeNull();
    expect(existsSync(file)).toBe(false);
  });
});
