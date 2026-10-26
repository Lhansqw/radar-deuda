import { parseGitHubRepo } from '@radar/sources';
import type { ArgsOf, Channel } from '../shared/ipc.js';
import { SECRET_NAMES, type SecretName } from '../shared/secrets.js';
import { validateSettings } from '../shared/settings.js';

/**
 * Validación en tiempo de ejecución de los argumentos de cada canal IPC. Los
 * tipos de TypeScript no protegen de una interfaz comprometida: aquí se
 * comprueba todo lo que llega antes de usarlo.
 */
export class IpcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpcValidationError';
  }
}

function count(args: unknown[], n: number): void {
  if (args.length !== n) throw new IpcValidationError(`Se esperaban ${n} argumento(s) y se recibieron ${args.length}.`);
}

function id(v: unknown, invalid: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new IpcValidationError(invalid);
  return v;
}

function text(v: unknown, invalid: string, max: number): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new IpcValidationError(invalid);
  return v;
}

/** Mismas reglas que el clonado (packages/sources/src/github/clone.ts). */
const SAFE_BRANCH = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/;

type Validators = { [C in Channel]: (args: unknown[]) => ArgsOf<C> };

export const VALIDATORS: Validators = {
  'app:info': (a) => (count(a, 0), []),
  'app:openExternal': (a) => (count(a, 1), [text(a[0], 'Enlace no válido.', 2000)]),
  'projects:list': (a) => (count(a, 0), []),
  'projects:addFolder': (a) => (count(a, 0), []),
  'projects:addGithub': (a) => {
    count(a, 2);
    const ref = parseGitHubRepo(text(a[0], 'Repositorio no válido.', 300));
    if (!ref) throw new IpcValidationError('Indica el repositorio como owner/repo o con su URL de GitHub.');
    const branch = a[1] === null || a[1] === '' ? null : text(a[1], 'Nombre de rama no válido.', 200).trim();
    if (branch !== null && !SAFE_BRANCH.test(branch)) throw new IpcValidationError('Nombre de rama no válido.');
    return [`${ref.owner}/${ref.repo}`, branch];
  },
  'projects:remove': (a) => (count(a, 1), [id(a[0], 'Proyecto no válido.')]),
  'analyses:list': (a) => (count(a, 1), [id(a[0], 'Proyecto no válido.')]),
  'analyses:report': (a) => (count(a, 1), [id(a[0], 'Análisis no válido.')]),
  'settings:get': (a) => (count(a, 0), []),
  'settings:set': (a) => {
    count(a, 1);
    const r = validateSettings(a[0]);
    if (!r.ok) throw new IpcValidationError(r.errors.join(' '));
    return [r.value];
  },
  'secrets:status': (a) => (count(a, 0), []),
  'secrets:set': (a) => {
    count(a, 2);
    return [secretName(a[0]), text(a[1], 'Credencial no válida.', 1000)];
  },
  'secrets:delete': (a) => (count(a, 1), [secretName(a[0])]),
  'jobs:start': (a) => (count(a, 1), [id(a[0], 'Proyecto no válido.')]),
  'jobs:cancel': (a) => {
    count(a, 1);
    const jobId = text(a[0], 'Análisis no válido.', 36);
    if (!/^[0-9a-f-]{36}$/.test(jobId)) throw new IpcValidationError('Análisis no válido.');
    return [jobId];
  },
  'jobs:list': (a) => (count(a, 0), []),
  'files:snippet': (a) => {
    count(a, 4);
    const start = line(a[2]);
    const end = line(a[3]);
    if (end < start) throw new IpcValidationError('Rango de líneas no válido.');
    return [id(a[0], 'Análisis no válido.'), relPath(a[1]), start, end];
  },
  'files:reveal': (a) => (count(a, 2), [id(a[0], 'Análisis no válido.'), relPath(a[1])]),
};

function line(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > 10_000_000) throw new IpcValidationError('Número de línea no válido.');
  return v;
}

/** Ruta relativa del proyecto con barras normales, sin unidad ni "..". */
function relPath(v: unknown): string {
  const p = text(v, 'Ruta no válida.', 1000);
  if (p.includes('\0') || p.includes('\\') || p.startsWith('/') || /^[a-z]:/i.test(p) || p.split('/').includes('..')) throw new IpcValidationError('Ruta no válida.');
  return p;
}

function secretName(v: unknown): SecretName {
  if (typeof v !== 'string' || !(SECRET_NAMES as readonly string[]).includes(v)) throw new IpcValidationError('Credencial desconocida.');
  return v as SecretName;
}
