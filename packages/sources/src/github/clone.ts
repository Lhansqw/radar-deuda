import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRepoInfo } from '../git/local.js';
import { runGit } from '../git/run.js';
import { cloneUrl, type GitHubRepoRef } from './url.js';

/** Carpeta donde la aplicación guarda sus clones (nunca dentro de un proyecto del usuario). */
export function defaultReposDir(): string {
  if (process.platform === 'win32') {
    const base = process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'radar-deuda', 'repos');
  }
  return path.join(process.env['XDG_CACHE_HOME'] ?? path.join(os.homedir(), '.cache'), 'radar-deuda', 'repos');
}

export interface CloneOptions {
  token?: string;
  /** Rama o etiqueta; por defecto la rama principal del remoto. */
  branch?: string;
  /**
   * Descarga solo el historial desde esta fecha (AAAA-MM-DD) en lugar de un
   * único commit: lo necesario para medir la frecuencia de cambio.
   */
  shallowSince?: string;
  baseDir?: string;
  /** Tamaño máximo aceptado según la API de GitHub (KB). Se comprueba si se pasa `sizeKb`. */
  maxSizeKb?: number;
  sizeKb?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CloneResult {
  dir: string;
  head: string;
  /** true si ya existía un clon y solo se actualizó. */
  updated: boolean;
}

/**
 * Autenticación por cabecera HTTP pasada en variables de entorno
 * (GIT_CONFIG_COUNT/KEY/VALUE): el token no aparece en la línea de comandos,
 * que otros procesos del equipo pueden leer, ni se escribe en .git/config.
 */
export function authEnv(token: string | undefined): Record<string, string> {
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

const SAFE_BRANCH = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/;

/** Opciones internas: solo las pruebas permiten otro protocolo y URL. */
interface InternalCloneOptions extends CloneOptions {
  url?: string;
  extraConfig?: string[];
}

/**
 * Clona (o actualiza) un repositorio de GitHub en la carpeta de la aplicación.
 * Clon superficial de una sola rama, sin etiquetas, sin submódulos, sin
 * enlaces simbólicos, sin hooks y sin descargar objetos de Git LFS. El clon
 * se hace en una carpeta temporal y se mueve solo si termina bien.
 */
export async function cloneOrUpdate(ref: GitHubRepoRef, options: CloneOptions = {}): Promise<CloneResult> {
  return cloneInternal(ref, options);
}

export async function cloneInternal(ref: GitHubRepoRef, options: InternalCloneOptions): Promise<CloneResult> {
  const { token, branch, shallowSince, baseDir = defaultReposDir(), maxSizeKb = 1024 * 1024, sizeKb, signal, timeoutMs = 10 * 60_000, url = cloneUrl(ref), extraConfig = [] } = options;
  if (branch !== undefined && !SAFE_BRANCH.test(branch)) throw new Error(`Nombre de rama no válido: ${branch}`);
  if (shallowSince !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(shallowSince)) throw new Error(`Fecha no válida: ${shallowSince}`);
  const depthArgs = shallowSince ? [`--shallow-since=${shallowSince}`] : ['--depth', '1'];
  if (sizeKb !== undefined && sizeKb > maxSizeKb) {
    throw new Error(`El repositorio ocupa ${Math.round(sizeKb / 1024)} MB y supera el límite de ${Math.round(maxSizeKb / 1024)} MB.`);
  }
  const name = `${ref.owner}__${ref.repo}`.toLowerCase();
  const dir = path.join(baseDir, name);
  const base = { env: authEnv(token), redact: token ? [token] : [], timeoutMs, ...(signal ? { signal } : {}) };
  const cfg = extraConfig.flatMap((c) => ['-c', c]);
  await mkdir(baseDir, { recursive: true });

  const existing = await getRepoInfo(dir, signal).catch(() => null);
  const sameRepo = existing !== null && path.resolve(existing.root) === path.resolve(dir) && existing.remoteUrl === url;
  if (sameRepo) {
    const target = branch ?? 'HEAD';
    await fetchWithFallback(cfg, depthArgs, ['--no-tags', '--prune', 'origin', '--end-of-options', target], { ...base, cwd: dir });
    await runGit([...cfg, 'reset', '--hard', '-q', 'FETCH_HEAD'], { ...base, cwd: dir });
    await runGit([...cfg, 'clean', '-ffdxq'], { ...base, cwd: dir });
    const head = (await runGit(['rev-parse', 'HEAD'], { cwd: dir })).trim();
    return { dir, head, updated: true };
  }

  const tmp = path.join(baseDir, `.${name}.tmp-${process.pid}-${Date.now()}`);
  try {
    const rest = ['--single-branch', '--no-tags', '--no-recurse-submodules', '-c', 'core.symlinks=false', '-q', ...(branch ? ['--branch', branch] : []), '--', url, tmp];
    await cloneWithFallback(cfg, depthArgs, rest, { ...base, cwd: baseDir }, tmp);
    if (await exists(dir)) await rm(dir, { recursive: true, force: true }); // clon anterior roto o de otro remoto
    await rename(tmp, dir);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  const head = (await runGit(['rev-parse', 'HEAD'], { cwd: dir })).trim();
  return { dir, head, updated: false };
}

/**
 * Con --shallow-since, Git falla si no hay ningún commit en el periodo
 * ("no commits selected"); en ese caso basta con el último commit.
 */
const NO_COMMITS_IN_RANGE = /no commits selected|shallow-since|shallow file has changed/i;

async function cloneWithFallback(cfg: string[], depthArgs: string[], rest: string[], opts: Parameters<typeof runGit>[1], tmp: string): Promise<void> {
  try {
    await runGit([...cfg, 'clone', ...depthArgs, ...rest], opts);
  } catch (err) {
    if (depthArgs[0] === '--depth' || !(err instanceof Error) || !NO_COMMITS_IN_RANGE.test(err.message)) throw err;
    await rm(tmp, { recursive: true, force: true });
    await runGit([...cfg, 'clone', '--depth', '1', ...rest], opts);
  }
}

async function fetchWithFallback(cfg: string[], depthArgs: string[], rest: string[], opts: Parameters<typeof runGit>[1]): Promise<void> {
  try {
    await runGit([...cfg, 'fetch', ...depthArgs, ...rest], opts);
  } catch (err) {
    if (depthArgs[0] === '--depth' || !(err instanceof Error) || !NO_COMMITS_IN_RANGE.test(err.message)) throw err;
    await runGit([...cfg, 'fetch', '--depth', '1', ...rest], opts);
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Clones existentes (para la interfaz: listar y borrar). */
export async function listClones(baseDir = defaultReposDir()): Promise<string[]> {
  try {
    return (await readdir(baseDir, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  } catch {
    return [];
  }
}
