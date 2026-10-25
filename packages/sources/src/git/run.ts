import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * Ejecución endurecida de Git.
 *
 * Ejecutar Git dentro de un repositorio ajeno no es inocuo: su `.git/config`
 * puede pedir a Git que lance programas (core.fsmonitor, hooks, paginador,
 * diff externo, filtros). Las opciones `-c` de la línea de comandos tienen
 * prioridad sobre cualquier archivo de configuración, así que se usan para
 * anular esos vectores en cada invocación. Además:
 *
 * - nunca se usa una shell (los argumentos no se interpretan);
 * - se eliminan las variables GIT_* heredadas (GIT_DIR, GIT_EXTERNAL_DIFF…);
 * - Git nunca pide credenciales de forma interactiva;
 * - hay límite de tiempo, de salida y cancelación.
 */

/** Directorio de hooks que no existe: Git no encuentra ningún hook que ejecutar. */
const NO_HOOKS_DIR = path.join(os.tmpdir(), 'radar-deuda-sin-hooks');

export const HARDENING_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', NO_HOOKS_DIR],
  ['core.pager', 'cat'],
  ['core.editor', 'false'],
  ['core.askPass', ''],
  ['core.sshCommand', 'false'],
  ['core.gitProxy', ''],
  ['core.symlinks', 'false'],
  ['core.longpaths', 'true'],
  ['core.quotePath', 'false'],
  ['diff.external', ''],
  ['credential.helper', ''],
  ['protocol.allow', 'never'],
  ['protocol.https.allow', 'always'],
  ['transfer.fsckObjects', 'true'],
  ['filter.lfs.smudge', ''],
  ['filter.lfs.process', ''],
  ['filter.lfs.required', 'false'],
  ['gc.auto', '0'],
  ['maintenance.auto', 'false'],
];

export function hardenedArgs(args: readonly string[]): string[] {
  const out = ['--no-pager'];
  for (const [key, value] of HARDENING_CONFIG) out.push('-c', `${key}=${value}`);
  return [...out, ...args];
}

/** Entorno heredado sin variables GIT_*, con prompts desactivados. */
export function sanitizedEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^GIT_/i.test(key)) env[key] = value;
  }
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
    LANG: 'C',
    ...extra,
  });
  return env;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitRunOptions {
  cwd: string;
  signal?: AbortSignal;
  /** Por defecto 60 s. */
  timeoutMs?: number;
  /** Por defecto 64 MB; por encima se aborta el proceso. */
  maxOutputBytes?: number;
  /** Variables adicionales (se añaden tras sanear el entorno). */
  env?: Readonly<Record<string, string>>;
  /** Textos que nunca deben aparecer en mensajes de error (p. ej. un token). */
  redact?: readonly string[];
}

function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join('***');
  // Credenciales incrustadas en URLs: https://usuario:secreto@host
  return out.replace(/(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1***@');
}

/** Ejecuta `git <args>` y devuelve la salida estándar. */
export function runGit(args: readonly string[], options: GitRunOptions): Promise<string> {
  const { cwd, signal, timeoutMs = 60_000, maxOutputBytes = 64 * 1024 * 1024, env, redact = [] } = options;
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn('git', hardenedArgs(args), {
      cwd,
      env: sanitizedEnv(env),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let failure: Error | null = null;
    const kill = (err: Error): void => {
      if (!failure) failure = err;
      child.kill();
    };
    const timer = setTimeout(() => kill(new GitError(`git ${args[0] ?? ''} superó el tiempo límite de ${timeoutMs} ms.`, null, '')), timeoutMs);
    const onAbort = (): void => kill(signal?.reason instanceof Error ? signal.reason : new Error('Operación cancelada.'));
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxOutputBytes) kill(new GitError(`La salida de git ${args[0] ?? ''} supera el límite de ${maxOutputBytes} bytes.`, null, ''));
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 16_384) stderr += chunk.toString('utf8');
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      kill(err.code === 'ENOENT' ? new GitError('Git no está instalado o no está en el PATH (https://git-scm.com/downloads/win).', null, '') : err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (failure) return reject(failure);
      if (code !== 0) {
        const clean = redactText(stderr.trim(), redact);
        return reject(new GitError(`git ${args[0] ?? ''} falló (código ${code}): ${clean.split('\n').slice(-3).join(' ')}`, code, clean));
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}
