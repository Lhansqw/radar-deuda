import { checkApiKey, KEY_RULES } from '@radar/ai';
import type { ApiKeys } from '@radar/pipeline';
import { SECRET_NAMES, type SecretName, type SecretsStatus } from '../shared/secrets.js';
import type { Store } from './store.js';

/**
 * Cifrado del sistema operativo (en Electron, safeStorage: DPAPI en Windows,
 * Llavero en macOS, el almacén de secretos del escritorio en Linux). Se
 * inyecta para poder probar este módulo sin Electron.
 */
export interface Cipher {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** Variables de entorno que también se aceptan (las mismas que la CLI). */
export const ENV_VARS: Readonly<Record<SecretName, string>> = {
  openrouter: 'RADAR_OPENROUTER_API_KEY',
  anthropic: 'RADAR_ANTHROPIC_API_KEY',
  openai: 'RADAR_OPENAI_API_KEY',
  github: 'RADAR_GITHUB_TOKEN',
};

/** Tokens de GitHub: fine-grained (github_pat_…) o clásicos (ghp_…, gho_…). */
const GITHUB_TOKEN = /^(?:github_pat_[A-Za-z0-9_]{22,255}|gh[pousr]_[A-Za-z0-9]{36,255})$/;

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialError';
  }
}

/**
 * Credenciales de la aplicación. Se guardan cifradas en la base de datos y
 * solo se descifran en el proceso principal en el momento de usarlas. La
 * interfaz puede escribirlas o borrarlas y saber si existen, pero nunca
 * leerlas: ningún método que llegue por IPC devuelve un valor.
 */
export class CredentialStore {
  constructor(
    private readonly store: Store,
    private readonly cipher: Cipher,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  get encryptionAvailable(): boolean {
    return this.cipher.isEncryptionAvailable();
  }

  status(): SecretsStatus {
    const secrets = Object.fromEntries(
      SECRET_NAMES.map((name) => [name, { stored: this.store.getSecret(name) !== null, fromEnv: this.fromEnv(name) !== undefined }]),
    ) as SecretsStatus['secrets'];
    return { encryptionAvailable: this.encryptionAvailable, secrets };
  }

  /** Valida el formato y guarda la credencial cifrada. Lanza CredentialError con un mensaje para el usuario. */
  set(name: SecretName, value: string): void {
    const v = value.trim();
    validate(name, v);
    if (!this.encryptionAvailable) {
      throw new CredentialError(
        `Este equipo no ofrece un almacén cifrado para guardar la credencial. Puedes definirla en la variable de entorno ${ENV_VARS[name]} antes de abrir la aplicación.`,
      );
    }
    this.store.setSecret(name, this.cipher.encryptString(v));
  }

  delete(name: SecretName): void {
    this.store.deleteSecret(name);
  }

  /**
   * Valor en claro, solo para el proceso principal: primero la credencial
   * guardada y, si no hay, la variable de entorno. Una credencial que no se
   * puede descifrar (p. ej. la base de datos se copió a otro usuario de
   * Windows) se trata como ausente.
   */
  get(name: SecretName): string | undefined {
    const blob = this.store.getSecret(name);
    if (blob !== null && this.encryptionAvailable) {
      try {
        const v = this.cipher.decryptString(Buffer.from(blob));
        if (v !== '') return v;
      } catch {
        /* no descifrable en esta sesión: se ignora */
      }
    }
    return this.fromEnv(name);
  }

  apiKeys(): ApiKeys {
    const keys: ApiKeys = {};
    const openrouter = this.get('openrouter');
    const anthropic = this.get('anthropic');
    const openai = this.get('openai');
    if (openrouter) keys.openrouter = openrouter;
    if (anthropic) keys.anthropic = anthropic;
    if (openai) keys.openai = openai;
    return keys;
  }

  private fromEnv(name: SecretName): string | undefined {
    const v = (this.env[ENV_VARS[name]] ?? '').trim();
    return v === '' ? undefined : v;
  }
}

function validate(name: SecretName, value: string): void {
  if (name === 'github') {
    if (!GITHUB_TOKEN.test(value)) {
      throw new CredentialError(`El token de GitHub no tiene el formato esperado (tiene ${value.length} caracteres; debería empezar por github_pat_ o ghp_). Cópialo de nuevo.`);
    }
    return;
  }
  try {
    checkApiKey(value, KEY_RULES[name], name);
  } catch (err) {
    throw new CredentialError(err instanceof Error ? err.message : String(err));
  }
}
