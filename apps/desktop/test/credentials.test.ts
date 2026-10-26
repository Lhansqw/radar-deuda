import { afterEach, describe, expect, it } from 'vitest';
import { CredentialError, CredentialStore, type Cipher } from '../src/main/credentials.js';
import { Store } from '../src/main/store.js';

const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

/** Cifrado simulado reversible; registra qué se cifró para comprobar que nunca se guarda en claro. */
function fakeCipher(available = true): Cipher & { plain: string[] } {
  const plain: string[] = [];
  return {
    plain,
    isEncryptionAvailable: () => available,
    encryptString: (s) => {
      plain.push(s);
      return Buffer.from(`cifrado:${Buffer.from(s).toString('base64')}`);
    },
    decryptString: (b) => {
      const t = b.toString();
      if (!t.startsWith('cifrado:')) throw new Error('no descifrable');
      return Buffer.from(t.slice('cifrado:'.length), 'base64').toString();
    },
  };
}

const KEYS = {
  openrouter: ['sk', 'or', 'v1', 'x'.repeat(64)].join('-'),
  anthropic: ['sk', 'ant', 'prueba', 'x'.repeat(40)].join('-'),
  github: `github_pat_${'A'.repeat(30)}`,
};

function setup(env: NodeJS.ProcessEnv = {}, available = true) {
  const store = Store.open(':memory:');
  stores.push(store);
  const cipher = fakeCipher(available);
  return { store, cipher, creds: new CredentialStore(store, cipher, env) };
}

describe('CredentialStore', () => {
  it('guarda la credencial cifrada (sin espacios) y la descifra solo al usarla', () => {
    const { store, cipher, creds } = setup();
    creds.set('openrouter', `  ${KEYS.openrouter}\r\n`);
    expect(cipher.plain).toEqual([KEYS.openrouter]);
    const raw = Buffer.from(store.getSecret('openrouter') ?? []).toString();
    expect(raw).not.toContain(KEYS.openrouter);
    expect(creds.get('openrouter')).toBe(KEYS.openrouter);
    expect(creds.apiKeys()).toEqual({ openrouter: KEYS.openrouter });
  });

  it('el estado nunca incluye valores', () => {
    const { creds } = setup({ RADAR_ANTHROPIC_API_KEY: KEYS.anthropic });
    creds.set('github', KEYS.github);
    const status = creds.status();
    expect(status).toEqual({
      encryptionAvailable: true,
      secrets: {
        openrouter: { stored: false, fromEnv: false },
        anthropic: { stored: false, fromEnv: true },
        openai: { stored: false, fromEnv: false },
        github: { stored: true, fromEnv: false },
      },
    });
    expect(JSON.stringify(status)).not.toMatch(/sk-|github_pat_/);
  });

  it('rechaza formatos incorrectos con un mensaje útil y sin mostrar el valor', () => {
    const { creds, cipher } = setup();
    const err = (() => {
      try {
        creds.set('openrouter', 'abcd');
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(CredentialError);
    expect(err?.message).toMatch(/tiene 4 caracteres/);
    expect(() => creds.set('github', 'ghp_corto')).toThrow(/token de GitHub no tiene el formato esperado/);
    expect(() => creds.set('anthropic', '')).toThrow(CredentialError);
    expect(cipher.plain).toEqual([]);
  });

  it('sin cifrado disponible no guarda nada y sugiere la variable de entorno', () => {
    const { creds, store } = setup({}, false);
    expect(() => creds.set('openrouter', KEYS.openrouter)).toThrow(/RADAR_OPENROUTER_API_KEY/);
    expect(store.getSecret('openrouter')).toBeNull();
    expect(creds.status().encryptionAvailable).toBe(false);
  });

  it('la credencial guardada tiene prioridad; si no se puede descifrar, se usa la variable de entorno', () => {
    const envKey = ['sk', 'or', 'v1', 'y'.repeat(64)].join('-');
    const { creds, store } = setup({ RADAR_OPENROUTER_API_KEY: ` ${envKey} ` });
    expect(creds.get('openrouter')).toBe(envKey);
    creds.set('openrouter', KEYS.openrouter);
    expect(creds.get('openrouter')).toBe(KEYS.openrouter);
    store.setSecret('openrouter', new TextEncoder().encode('basura de otro usuario'));
    expect(creds.get('openrouter')).toBe(envKey);
    creds.delete('openrouter');
    expect(creds.status().secrets.openrouter).toEqual({ stored: false, fromEnv: true });
  });
});
