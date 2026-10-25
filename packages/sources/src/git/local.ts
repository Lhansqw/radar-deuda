import { GitError, runGit } from './run.js';

export interface RepoInfo {
  /** Raíz del repositorio (puede ser superior a la carpeta analizada). */
  root: string;
  /** Commit actual; null en un repositorio sin commits. */
  head: string | null;
  /** Rama actual; null si HEAD está desacoplado. */
  branch: string | null;
  /** URL del remoto `origin` sin credenciales incrustadas. */
  remoteUrl: string | null;
  /** Clon superficial (`--depth`): el historial está incompleto. */
  shallow: boolean;
}

/** Quita usuario y contraseña/token de una URL (https://token@github.com/… → https://github.com/…). */
export function stripCredentials(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@]*@/i, '$1');
}

async function optional(args: string[], cwd: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const out = (await runGit(args, signal ? { cwd, signal } : { cwd })).trim();
    return out === '' ? null : out;
  } catch (err) {
    if (err instanceof GitError && err.exitCode !== null) return null;
    throw err;
  }
}

/**
 * Información del repositorio Git que contiene `dir`, o null si no está bajo
 * control de versiones. Solo usa comandos de lectura sobre objetos y
 * referencias (nunca `status`, que recorre el árbol de trabajo).
 */
export async function getRepoInfo(dir: string, signal?: AbortSignal): Promise<RepoInfo | null> {
  let root: string;
  try {
    root = (await runGit(['rev-parse', '--show-toplevel'], signal ? { cwd: dir, signal } : { cwd: dir })).trim();
  } catch (err) {
    if (!(err instanceof GitError) || err.exitCode === null) throw err;
    if (/dubious ownership/i.test(err.stderr)) {
      throw new GitError(
        'Git rechaza este repositorio porque pertenece a otro usuario de Windows ("dubious ownership"). ' +
          'Si confías en él, ejecuta: git config --global --add safe.directory <ruta>',
        err.exitCode,
        err.stderr,
      );
    }
    return null;
  }
  const [head, branch, remote, shallow] = await Promise.all([
    optional(['rev-parse', '--verify', '-q', 'HEAD'], root, signal),
    optional(['symbolic-ref', '--short', '-q', 'HEAD'], root, signal),
    optional(['config', '--get', 'remote.origin.url'], root, signal),
    optional(['rev-parse', '--is-shallow-repository'], root, signal),
  ]);
  return {
    root,
    head,
    branch,
    remoteUrl: remote ? stripCredentials(remote) : null,
    shallow: shallow === 'true',
  };
}
