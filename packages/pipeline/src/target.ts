import { existsSync } from 'node:fs';
import path from 'node:path';
import { cloneOrUpdate, GitHubClient, HttpError, parseGitHubRepo, type CloneOptions, type CloneResult, type GitHubRepoRef } from '@radar/sources';
import type { PipelineHooks } from './types.js';

export interface SourceOptions {
  /** Carpeta local, owner/repo, github:owner/repo o URL de GitHub. */
  target: string;
  /** Rama a clonar (por defecto, la principal). */
  branch?: string;
  /** Inicio del historial (AAAA-MM-DD); por defecto, hace 12 meses. */
  since?: string;
  /** Calcular puntos críticos con el historial de Git (y clonar ese periodo). */
  history: boolean;
  /** Token de solo lectura para repositorios privados. Nunca se guarda en disco. */
  githubToken?: string;
  /** Carpeta de los clones (por defecto, la de la aplicación en %LOCALAPPDATA%). */
  reposDir?: string;
}

export interface ResolvedTarget {
  dir: string;
  /** Repositorio de GitHub de origen, si el objetivo no era una carpeta local. */
  github: GitHubRepoRef | null;
}

/** Inicio del periodo de historial: el indicado o hace 12 meses (AAAA-MM-DD). */
export function historyStart(o: Pick<SourceOptions, 'since'>, now = Date.now()): string {
  return o.since ?? new Date(now - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Acceso a GitHub; sustituible en las pruebas para no salir a la red. */
export interface TargetDeps {
  client: (token: string | undefined, signal: AbortSignal) => Pick<GitHubClient, 'getRepository' | 'checkToken'>;
  clone: (ref: GitHubRepoRef, options: CloneOptions) => Promise<CloneResult>;
}

const DEFAULT_DEPS: TargetDeps = {
  client: (token, signal) => new GitHubClient({ ...(token ? { token } : {}), signal }),
  clone: cloneOrUpdate,
};

/** Carpeta local o, si no existe, repositorio de GitHub clonado. */
export async function resolveTarget(o: SourceOptions, hooks: PipelineHooks, signal: AbortSignal, deps: TargetDeps = DEFAULT_DEPS): Promise<ResolvedTarget> {
  const local = path.resolve(o.target);
  if (existsSync(local)) return { dir: local, github: null };
  const ref = parseGitHubRepo(o.target);
  if (!ref) throw new Error(`No existe la carpeta "${o.target}" ni es una referencia válida a GitHub (owner/repo o URL).`);

  const token = o.githubToken;
  const gh = deps.client(token, signal);
  let meta: Awaited<ReturnType<GitHubClient['getRepository']>> | null = null;
  try {
    meta = await gh.getRepository(ref);
    if (token) for (const w of (await gh.checkToken()).warnings) hooks.warn(w);
  } catch (err) {
    // 401 (token inválido) y 404 (no existe o sin acceso) son definitivos. Los metadatos son opcionales:
    // ante un límite de peticiones, un error del servidor o falta de red, se intenta clonar igualmente.
    if (err instanceof Error && err.cause instanceof HttpError && (err.cause.status === 401 || err.cause.status === 404)) throw err;
    hooks.warn(`No se pudieron obtener los metadatos de GitHub (${err instanceof Error ? err.message : String(err)}). Se intenta clonar igualmente.`);
  }
  hooks.info(`Clonando ${ref.owner}/${ref.repo}${meta ? ` (${Math.round(meta.sizeKb / 1024)} MB, rama ${o.branch ?? meta.defaultBranch})` : ''}…`);
  hooks.progress?.({ phase: 'clone', repo: `${ref.owner}/${ref.repo}` });
  const branch = o.branch ?? meta?.defaultBranch;
  const clone = await deps.clone(ref, {
    ...(token ? { token } : {}),
    ...(branch ? { branch } : {}),
    ...(o.history ? { shallowSince: historyStart(o) } : {}),
    ...(meta ? { sizeKb: meta.sizeKb } : {}),
    ...(o.reposDir ? { baseDir: o.reposDir } : {}),
    signal,
  });
  hooks.info(`${clone.updated ? 'Actualizado' : 'Clonado'} en ${clone.dir}`);
  return { dir: clone.dir, github: ref };
}
