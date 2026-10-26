import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha1 } from '@radar/engine';

/**
 * Caché en disco de respuestas YA VALIDADAS. La clave incluye todo lo que
 * influye en la respuesta (versión del prompt, proveedor, modelo, privacidad
 * y el contexto exacto enviado), así que un cambio en el código analizado o en
 * las instrucciones produce otra clave y nunca se sirve una respuesta antigua.
 */
export class AiResponseCache {
  constructor(private readonly dir: string | null) {}

  static key(parts: readonly string[]): string {
    return sha1(parts.join('\u0000'));
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (!this.dir || !/^[0-9a-f]{40}$/.test(key)) return undefined;
    try {
      return (JSON.parse(await readFile(path.join(this.dir, `${key}.json`), 'utf8')) as { value: T }).value;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    if (!this.dir || !/^[0-9a-f]{40}$/.test(key)) return;
    await mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${key}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ savedAt: new Date().toISOString(), value }), 'utf8');
    await rename(tmp, file);
  }
}
