import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Cipher } from './credentials.js';

/**
 * Dónde guarda Supabase Auth la sesión (tokens de acceso y de renovación) en
 * el proceso principal. Siempre en memoria y, si el usuario quiere seguir
 * conectado y el sistema ofrece cifrado (DPAPI en Windows), también en un
 * archivo cifrado. Nunca en claro y nunca en la interfaz.
 *
 * Implementa la interfaz de almacenamiento de @supabase/auth-js (getItem,
 * setItem y removeItem, que pueden ser asíncronas).
 */
export class EncryptedSessionStorage {
  private readonly memory = new Map<string, string>();
  private loaded = false;
  /** false: la sesión solo dura mientras la aplicación está abierta. */
  private persistent = true;

  constructor(
    private readonly file: string,
    private readonly cipher: Cipher,
  ) {}

  /** El archivo solo existe si el cifrado del sistema está disponible. */
  get canPersist(): boolean {
    return this.cipher.isEncryptionAvailable();
  }

  get persist(): boolean {
    return this.persistent;
  }

  /** Cambia si la sesión sobrevive al cierre; al desactivarlo se borra el archivo. */
  setPersist(persist: boolean): void {
    this.load();
    this.persistent = persist;
    this.save();
  }

  getItem(key: string): Promise<string | null> {
    this.load();
    return Promise.resolve(this.memory.get(key) ?? null);
  }

  setItem(key: string, value: string): Promise<void> {
    this.load();
    this.memory.set(key, value);
    this.save();
    return Promise.resolve();
  }

  removeItem(key: string): Promise<void> {
    this.load();
    this.memory.delete(key);
    this.save();
    return Promise.resolve();
  }

  /** Olvida la sesión en memoria y en el disco. */
  clear(): void {
    this.loaded = true;
    this.memory.clear();
    this.save();
  }

  /** Lee el archivo una vez. Uno dañado o de otro usuario de Windows se descarta. */
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.canPersist) return;
    let blob: Buffer;
    try {
      blob = readFileSync(this.file);
    } catch {
      return;
    }
    try {
      const data = JSON.parse(this.cipher.decryptString(blob)) as unknown;
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const [k, v] of Object.entries(data)) if (typeof v === 'string') this.memory.set(k, v);
      }
    } catch {
      this.remove();
    }
  }

  private save(): void {
    if (!this.persistent || !this.canPersist || this.memory.size === 0) {
      this.remove();
      return;
    }
    mkdirSync(path.dirname(this.file), { recursive: true });
    // Primero un temporal y después el cambio de nombre: nunca queda un archivo a medias.
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, this.cipher.encryptString(JSON.stringify(Object.fromEntries(this.memory))));
    renameSync(tmp, this.file);
  }

  private remove(): void {
    rmSync(this.file, { force: true });
  }
}
