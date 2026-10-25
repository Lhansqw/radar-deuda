import { createHash } from 'node:crypto';
import { GitError, runGit } from './run.js';

/**
 * Lectura del historial con comandos que solo leen objetos de Git (log,
 * diff-tree, rev-parse): nunca tocan el árbol de trabajo, así que no
 * intervienen filtros ni el índice.
 */

/** Referencias aceptadas: sin espacios ni opciones (`-x`) para evitar inyección de argumentos. */
const SAFE_REF = /^(?!-)[\w./~^@{}-]{1,200}$/;

export async function resolveCommit(root: string, ref: string, signal?: AbortSignal): Promise<string> {
  if (!SAFE_REF.test(ref)) throw new Error(`Referencia de Git no válida: ${ref}`);
  try {
    const out = await runGit(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], signal ? { cwd: root, signal } : { cwd: root });
    return out.trim();
  } catch (err) {
    if (err instanceof GitError && err.exitCode !== null) throw new Error(`La referencia "${ref}" no existe en el repositorio.`, { cause: err });
    throw err;
  }
}

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'type-changed';

export interface ChangedFile {
  status: ChangeStatus;
  /** Relativa a la raíz del repositorio, con `/`. */
  path: string;
}

const STATUS: Record<string, ChangeStatus> = { A: 'added', M: 'modified', D: 'deleted', T: 'type-changed' };

/** Archivos que difieren entre dos commits (sin detección de renombrados: borrado + alta). */
export async function changedFiles(root: string, from: string, to = 'HEAD', signal?: AbortSignal): Promise<ChangedFile[]> {
  const [a, b] = await Promise.all([resolveCommit(root, from, signal), resolveCommit(root, to, signal)]);
  const out = await runGit(['diff-tree', '-r', '-z', '--no-commit-id', '--name-status', '--no-renames', '--no-ext-diff', '--no-textconv', a, b], signal ? { cwd: root, signal } : { cwd: root });
  const parts = out.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = STATUS[(parts[i] ?? '').charAt(0)];
    const p = parts[i + 1];
    if (status && p) files.push({ status, path: p });
  }
  return files.sort((x, y) => x.path.localeCompare(y.path));
}

export interface FileChurn {
  file: string;
  commits: number;
  added: number;
  deleted: number;
  authors: number;
  /** Segundos Unix del último commit que tocó el archivo. */
  lastChange: number;
}

export interface ChurnOptions {
  /** Solo commits posteriores a esta fecha (ISO 8601). Por defecto, los últimos 12 meses. */
  since?: string;
  /** Máximo de commits a recorrer (por defecto 5 000). */
  maxCommits?: number;
  /** Limita el historial a esta subcarpeta (relativa a la raíz, con `/`). */
  pathPrefix?: string;
  signal?: AbortSignal;
}

/** Deshace el entrecomillado estilo C que Git aplica a rutas con caracteres de control. */
export function unquoteGitPath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const next = body[i + 1] ?? '';
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(simple[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Frecuencia de cambio por archivo (`git log --numstat`). Los autores se
 * cuentan con un hash de su correo que nunca sale de esta función.
 */
export async function fileChurn(root: string, options: ChurnOptions = {}): Promise<Map<string, FileChurn>> {
  const { maxCommits = 5000, pathPrefix, signal } = options;
  const since = options.since ?? new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}/.test(since)) throw new Error(`Fecha no válida: ${since}`);
  const args = ['log', '--no-merges', '--numstat', '--no-renames', '--no-ext-diff', '--no-textconv', `--max-count=${maxCommits}`, `--since=${since}`, '--format=@@@%at%x09%ae', '--'];
  if (pathPrefix) args.push(pathPrefix);
  let out: string;
  try {
    out = await runGit(args, signal ? { cwd: root, signal } : { cwd: root });
  } catch (err) {
    if (err instanceof GitError && /does not have any commits/i.test(err.stderr)) return new Map();
    throw err;
  }

  const churn = new Map<string, FileChurn>();
  const authorSets = new Map<string, Set<string>>();
  let when = 0;
  let author = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('@@@')) {
      const [ts, email] = line.slice(3).split('\t');
      when = Number(ts);
      author = createHash('sha1').update((email ?? '').toLowerCase()).digest('hex');
      continue;
    }
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    const file = unquoteGitPath(m[3] as string);
    let entry = churn.get(file);
    if (!entry) {
      entry = { file, commits: 0, added: 0, deleted: 0, authors: 0, lastChange: 0 };
      churn.set(file, entry);
      authorSets.set(file, new Set());
    }
    entry.commits++;
    entry.added += m[1] === '-' ? 0 : Number(m[1]);
    entry.deleted += m[2] === '-' ? 0 : Number(m[2]);
    entry.lastChange = Math.max(entry.lastChange, when);
    authorSets.get(file)?.add(author);
  }
  for (const [file, set] of authorSets) {
    const entry = churn.get(file);
    if (entry) entry.authors = set.size;
  }
  return churn;
}
