import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FileAnalysisResult, FileMeta } from './types.js';
import { sha1 } from './util.js';

const CACHE_FORMAT = 1;

interface FileEntry {
  size: number;
  mtimeMs: number;
  contentHash: string;
  /** Clave: `analizador@versión`. */
  results: Record<string, FileAnalysisResult>;
}

interface CacheFile {
  format: number;
  configHash: string;
  files: Record<string, FileEntry>;
}

/**
 * Caché persistente por archivo. Nunca se escribe dentro del repositorio
 * analizado: vive en el directorio de datos del usuario.
 *
 * Invalidación: cambia el tamaño o la fecha de modificación → se relee y se
 * compara el hash del contenido; cambia la versión de un analizador → se
 * recalcula solo ese analizador; cambia la configuración → se descarta todo.
 */
export class AnalysisCache {
  private data: CacheFile;
  private dirty = false;

  private constructor(
    private readonly filePath: string | null,
    configHash: string,
    loaded: CacheFile | null,
  ) {
    this.data =
      loaded && loaded.format === CACHE_FORMAT && loaded.configHash === configHash
        ? loaded
        : { format: CACHE_FORMAT, configHash, files: {} };
  }

  static disabled(configHash: string): AnalysisCache {
    return new AnalysisCache(null, configHash, null);
  }

  static async open(cacheDir: string, repoRoot: string, configHash: string): Promise<AnalysisCache> {
    const filePath = path.join(cacheDir, `${sha1(repoRoot).slice(0, 20)}.json`);
    let loaded: CacheFile | null = null;
    try {
      const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
      if (isCacheFile(parsed)) loaded = parsed;
    } catch {
      /* caché inexistente o corrupta: se reconstruye */
    }
    return new AnalysisCache(filePath, configHash, loaded);
  }

  /** Resultado cacheado si los metadatos coinciden (sin leer el archivo). */
  lookupByMeta(meta: FileMeta, analyzerKey: string): FileAnalysisResult | undefined {
    const entry = this.data.files[meta.relPath];
    if (!entry || entry.size !== meta.size || entry.mtimeMs !== meta.mtimeMs) return undefined;
    return entry.results[analyzerKey];
  }

  /** Resultado cacheado si el contenido es idéntico (p. ej. tras un `git checkout` que cambia la fecha). */
  lookupByHash(meta: FileMeta, contentHash: string, analyzerKey: string): FileAnalysisResult | undefined {
    const entry = this.data.files[meta.relPath];
    if (!entry || entry.contentHash !== contentHash) return undefined;
    const hit = entry.results[analyzerKey];
    if (hit && (entry.mtimeMs !== meta.mtimeMs || entry.size !== meta.size)) {
      entry.mtimeMs = meta.mtimeMs;
      entry.size = meta.size;
      this.dirty = true;
    }
    return hit;
  }

  store(meta: FileMeta, contentHash: string, analyzerKey: string, result: FileAnalysisResult): void {
    let entry = this.data.files[meta.relPath];
    if (!entry || entry.contentHash !== contentHash) {
      entry = { size: meta.size, mtimeMs: meta.mtimeMs, contentHash, results: {} };
      this.data.files[meta.relPath] = entry;
    }
    entry.size = meta.size;
    entry.mtimeMs = meta.mtimeMs;
    entry.results[analyzerKey] = result;
    this.dirty = true;
  }

  /** Elimina entradas de archivos que ya no existen. */
  prune(existing: ReadonlySet<string>): void {
    for (const key of Object.keys(this.data.files)) {
      if (!existing.has(key)) {
        delete this.data.files[key];
        this.dirty = true;
      }
    }
  }

  /** Escritura atómica: archivo temporal + rename. */
  async save(): Promise<void> {
    if (!this.filePath || !this.dirty) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data), 'utf8');
    await rename(tmp, this.filePath);
    this.dirty = false;
  }
}

function isCacheFile(v: unknown): v is CacheFile {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['format'] === 'number' && typeof o['configHash'] === 'string' && typeof o['files'] === 'object' && o['files'] !== null;
}

/** Directorio de caché por defecto según el sistema operativo. */
export function defaultCacheDir(): string {
  if (process.platform === 'win32') {
    const base = process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'radar-deuda', 'cache');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'radar-deuda');
  return path.join(process.env['XDG_CACHE_HOME'] ?? path.join(os.homedir(), '.cache'), 'radar-deuda');
}
