import { opendir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import ignoreFactory, { type Ignore } from 'ignore';
import { ALWAYS_EXCLUDED_DIRS } from './config.js';
import type { AnalysisConfig, FileMeta, Language, SkippedFile } from './types.js';
import { toPosix } from './util.js';

const TS_EXT = new Set(['.ts', '.tsx', '.mts', '.cts']);
const JS_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs']);
/** Código de otros lenguajes: se mide tamaño, marcadores y secretos (sin AST por ahora). */
const OTHER_CODE_EXT = new Set([
  '.py', '.java', '.kt', '.kts', '.go', '.rb', '.php', '.cs', '.rs', '.swift', '.scala',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.m', '.dart', '.lua', '.sh', '.ps1', '.vue', '.svelte',
]);
/** Archivos de texto relevantes para secretos/configuración (no cuentan como código). */
const TEXT_EXT = new Set([
  '.json', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.properties', '.xml',
  '.env', '.md', '.txt', '.sql', '.gradle', '.tf', '.html', '.css', '.scss',
]);
const TEXT_NAMES = new Set(['dockerfile', 'makefile', '.npmrc', '.env', 'jenkinsfile', 'procfile']);
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'npm-shrinkwrap.json']);

export interface Classification {
  language: Language;
  isCode: boolean;
  include: boolean;
}

export function classify(relPath: string): Classification {
  const base = path.posix.basename(relPath).toLowerCase();
  if (LOCKFILES.has(base)) return { language: 'other', isCode: false, include: false };
  const ext = path.posix.extname(base);
  if (TS_EXT.has(ext)) return { language: 'typescript', isCode: true, include: true };
  if (JS_EXT.has(ext)) return { language: 'javascript', isCode: true, include: true };
  if (OTHER_CODE_EXT.has(ext)) return { language: 'other', isCode: true, include: true };
  if (TEXT_EXT.has(ext) || TEXT_NAMES.has(base) || base.startsWith('.env.')) {
    return { language: 'other', isCode: false, include: true };
  }
  return { language: 'other', isCode: false, include: false };
}

const TEST_FILE = /(^|\/)(__tests__|__mocks__|tests?|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/i;

export function isTestPath(relPath: string): boolean {
  return TEST_FILE.test(relPath);
}

export interface DiscoveryResult {
  root: string;
  files: FileMeta[];
  skipped: SkippedFile[];
  /** Patrones de .radarignore en la raíz (null si no existe). */
  radarignore: number | null;
}

/** Exclusiones propias del análisis, con la sintaxis de .gitignore (carpetas generadas, vendor…). */
export const RADARIGNORE = '.radarignore';
const MAX_IGNORE_BYTES = 256 * 1024;

/**
 * Valida y normaliza la raíz a analizar. Rechaza rutas que no son directorios
 * y raíces de unidad/sistema de archivos (analizar `C:\` completo nunca es intencional).
 */
export async function resolveRoot(input: string): Promise<string> {
  if (typeof input !== 'string' || input.trim() === '' || input.includes('\0')) {
    throw new Error('Ruta de repositorio inválida.');
  }
  let resolved: string;
  try {
    resolved = await realpath(path.resolve(input));
  } catch {
    throw new Error(`La ruta no existe o no es accesible: ${input}`);
  }
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error(`La ruta no es un directorio: ${resolved}`);
  if (path.parse(resolved).root === resolved) {
    throw new Error(`Por seguridad no se analiza la raíz de una unidad: ${resolved}`);
  }
  return resolved;
}

async function readIgnoreFile(file: string): Promise<string | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_IGNORE_BYTES) return null;
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** Patrones de una lista con la sintaxis de .gitignore (sin comentarios ni líneas vacías). */
function patternCount(text: string): number {
  return text.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#')).length;
}

async function loadIgnores(root: string, config: AnalysisConfig): Promise<{ ig: Ignore; radarignore: number | null }> {
  const ig = ignoreFactory().add(config.exclude);
  if (config.respectGitignore) {
    const gitignore = await readIgnoreFile(path.join(root, '.gitignore'));
    if (gitignore !== null) ig.add(gitignore);
  }
  // .radarignore se aplica siempre: es una decisión explícita sobre qué analizar.
  const own = await readIgnoreFile(path.join(root, RADARIGNORE));
  if (own !== null) ig.add(own);
  return { ig, radarignore: own === null ? null : patternCount(own) };
}

/**
 * Recorre el repositorio sin seguir enlaces simbólicos (así ningún archivo puede
 * quedar fuera de la raíz), podando directorios excluidos antes de descender.
 * Solo recoge metadatos: el contenido se lee después, archivo a archivo.
 */
export async function discoverFiles(
  rootInput: string,
  config: AnalysisConfig,
  signal?: AbortSignal,
): Promise<DiscoveryResult> {
  const root = await resolveRoot(rootInput);
  const { ig, radarignore } = await loadIgnores(root, config);
  const files: FileMeta[] = [];
  const skipped: SkippedFile[] = [];
  const stack: string[] = [''];

  while (stack.length > 0) {
    signal?.throwIfAborted();
    const relDir = stack.pop() as string;
    let dir;
    try {
      dir = await opendir(path.join(root, relDir));
    } catch {
      continue;
    }
    for await (const entry of dir) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (ALWAYS_EXCLUDED_DIRS.has(entry.name) || ig.ignores(`${rel}/`)) continue;
        stack.push(rel);
        continue;
      }
      if (!entry.isFile() || ig.ignores(rel)) continue;
      const cls = classify(rel);
      if (!cls.include) continue;
      const abs = path.join(root, rel);
      let info;
      try {
        info = await stat(abs);
      } catch {
        skipped.push({ relPath: rel, reason: 'unreadable' });
        continue;
      }
      if (info.size > config.hardMaxFileSizeBytes) {
        skipped.push({ relPath: rel, reason: 'too-large' });
        continue;
      }
      files.push({
        absPath: abs,
        relPath: toPosix(rel),
        size: info.size,
        mtimeMs: info.mtimeMs,
        language: cls.language,
        isCode: cls.isCode,
        isTest: isTestPath(rel),
      });
    }
  }
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { root, files, skipped, radarignore };
}

/** Heurística barata para binarios: un byte nulo en los primeros 8 KB. */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Código minificado o generado: líneas extremadamente largas. */
export function looksMinified(lines: readonly string[], size: number): boolean {
  if (size < 2048) return false;
  let longest = 0;
  for (const l of lines) if (l.length > longest) longest = l.length;
  return longest > 5000 || size / Math.max(lines.length, 1) > 300;
}
