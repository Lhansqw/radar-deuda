import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Mantenimiento de la caché compartida por la CLI y la aplicación: cuánto
 * ocupa, borrar lo que lleva tiempo sin usarse y vaciarla. Solo toca archivos
 * con los nombres que crea la propia herramienta, así que una caché mal
 * configurada (RADAR_CACHE_DIR apuntando a una carpeta del usuario) nunca
 * pierde otros archivos. Los clones de GitHub (repos/) no forman parte de la
 * caché: se gestionan aparte.
 */

export type CachePartName = 'motor' | 'ia' | 'historial' | 'dependencias';

export interface CachePart {
  name: CachePartName;
  label: string;
  files: number;
  bytes: number;
}

export interface CacheUsage {
  parts: CachePart[];
  files: number;
  bytes: number;
}

export interface CacheCleanup {
  files: number;
  bytes: number;
}

const LABELS: Record<CachePartName, string> = {
  motor: 'Análisis por archivo',
  ia: 'Respuestas de la IA',
  historial: 'Historial de Git',
  dependencias: 'Vulnerabilidades y versiones',
};

/** Dónde vive cada parte y qué nombres de archivo son suyos. */
const LAYOUT: ReadonlyArray<{ name: CachePartName; dir: string; file: RegExp }> = [
  { name: 'motor', dir: '', file: /^[0-9a-f]{20}\.json$/ },
  { name: 'historial', dir: 'git', file: /^[0-9a-f]{20}\.json$/ },
  { name: 'ia', dir: 'ai', file: /^[0-9a-f]{40}\.json$/ },
  { name: 'dependencias', dir: 'osv', file: /^[\w.-]+\.json$/ },
  { name: 'dependencias', dir: 'npm', file: /^[\w.@%-]+\.json$/ },
];
/** Restos de una escritura interrumpida (archivo temporal + rename). */
const LEFTOVER = /\.json\.\d+\.tmp$/;

interface Entry {
  part: CachePartName;
  file: string;
  bytes: number;
  mtimeMs: number;
}

async function entries(cacheBase: string): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const { name, dir, file } of LAYOUT) {
    const folder = path.join(cacheBase, dir);
    let list;
    try {
      list = await readdir(folder, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of list) {
      if (!e.isFile() || !(file.test(e.name) || LEFTOVER.test(e.name))) continue;
      const full = path.join(folder, e.name);
      const s = await stat(full).catch(() => null);
      if (s) out.push({ part: name, file: full, bytes: s.size, mtimeMs: s.mtimeMs });
    }
  }
  return out;
}

export async function cacheUsage(cacheBase: string): Promise<CacheUsage> {
  const all = await entries(cacheBase);
  const parts = (Object.keys(LABELS) as CachePartName[]).map((name) => {
    const mine = all.filter((e) => e.part === name);
    return { name, label: LABELS[name], files: mine.length, bytes: mine.reduce((n, e) => n + e.bytes, 0) };
  });
  return { parts, files: all.length, bytes: all.reduce((n, e) => n + e.bytes, 0) };
}

async function remove(list: readonly Entry[]): Promise<CacheCleanup> {
  let files = 0;
  let bytes = 0;
  for (const e of list) {
    try {
      await rm(e.file, { force: true });
      files++;
      bytes += e.bytes;
    } catch {
      /* en uso o sin permiso: se deja */
    }
  }
  return { files, bytes };
}

/** Borra lo que no se ha escrito desde hace más de `days` días (y los temporales de más de un día). */
export async function pruneCache(cacheBase: string, days: number, now = Date.now()): Promise<CacheCleanup> {
  const limit = now - days * 24 * 3600 * 1000;
  const day = now - 24 * 3600 * 1000;
  return remove((await entries(cacheBase)).filter((e) => e.mtimeMs < (LEFTOVER.test(e.file) ? day : limit)));
}

/** Vacía la caché (no los clones). El siguiente análisis de cada proyecto será completo. */
export async function clearCache(cacheBase: string): Promise<CacheCleanup> {
  return remove(await entries(cacheBase));
}

/** Tamaño de una carpeta (para los clones), sin seguir enlaces simbólicos. */
export async function folderSize(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let list;
    try {
      list = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of list) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        const s = await stat(full).catch(() => null);
        if (s) {
          files++;
          bytes += s.size;
        }
      }
    }
  }
  return { files, bytes };
}
