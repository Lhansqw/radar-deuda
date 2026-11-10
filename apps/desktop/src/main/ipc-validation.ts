import { MAX_QUESTION_CHARS } from '@radar/ai';
import { parseGitHubRepo } from '@radar/sources';
import { MAX_EMAIL } from '../shared/account.js';
import type { ArgsOf, Channel } from '../shared/ipc.js';
import { SECRET_NAMES, type SecretName } from '../shared/secrets.js';
import { isLanguageSetting, validateSettings } from '../shared/settings.js';
import { currentLocale } from './i18n.js';
import { tr } from './i18n.js';

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
  if (args.length !== n) throw new IpcValidationError(tr(`Se esperaban ${n} argumento(s) y se recibieron ${args.length}.`, `Expected ${n} argument(s) and got ${args.length}.`));
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
  'account:state': (a) => (count(a, 0), []),
  'account:signIn': (a) => {
    count(a, 3);
    if (typeof a[2] !== 'boolean') throw new IpcValidationError(tr('Opción no válida.', 'Invalid option.'));
    return [email(a[0]), password(a[1]), a[2]];
  },
  'account:signUp': (a) => (count(a, 2), [email(a[0]), password(a[1])]),
  'account:resendConfirmation': (a) => (count(a, 1), [email(a[0])]),
  'account:requestPasswordReset': (a) => (count(a, 1), [email(a[0])]),
  'account:resetPassword': (a) => (count(a, 3), [email(a[0]), code(a[1]), password(a[2])]),
  'account:setNewPassword': (a) => (count(a, 1), [password(a[0])]),
  'account:signOut': (a) => (count(a, 0), []),
  'app:info': (a) => (count(a, 0), []),
  'app:openExternal': (a) => (count(a, 1), [text(a[0], tr('Enlace no válido.', 'Invalid link.'), 2000)]),
  'app:setLanguage': (a) => {
    count(a, 1);
    if (!isLanguageSetting(a[0])) throw new IpcValidationError(tr('Idioma no válido.', 'Invalid language.'));
    return [a[0]];
  },
  'app:copyText': (a) => (count(a, 1), [text(a[0], tr('Texto no válido.', 'Invalid text.'), 2_000_000)]),
  'app:storage': (a) => (count(a, 0), []),
  'app:clearCache': (a) => (count(a, 0), []),
  'app:checkUpdate': (a) => (count(a, 0), []),
  'projects:list': (a) => (count(a, 0), []),
  'projects:addFolder': (a) => (count(a, 0), []),
  'projects:addGithub': (a) => {
    count(a, 2);
    const ref = parseGitHubRepo(text(a[0], tr('Repositorio no válido.', 'Invalid repository.'), 300));
    if (!ref) throw new IpcValidationError(tr('Indica el repositorio como owner/repo o con su URL de GitHub.', 'Enter the repository as owner/repo or with its GitHub URL.'));
    const branch = a[1] === null || a[1] === '' ? null : text(a[1], tr('Nombre de rama no válido.', 'Invalid branch name.'), 200).trim();
    if (branch !== null && !SAFE_BRANCH.test(branch)) throw new IpcValidationError(tr('Nombre de rama no válido.', 'Invalid branch name.'));
    return [`${ref.owner}/${ref.repo}`, branch];
  },
  'projects:remove': (a) => (count(a, 1), [id(a[0], tr('Proyecto no válido.', 'Invalid project.'))]),
  'analyses:list': (a) => (count(a, 1), [id(a[0], tr('Proyecto no válido.', 'Invalid project.'))]),
  'analyses:report': (a) => (count(a, 1), [id(a[0], tr('Análisis no válido.', 'Invalid analysis.'))]),
  'analyses:compare': (a) => {
    count(a, 2);
    const before = id(a[0], tr('Análisis no válido.', 'Invalid analysis.'));
    const after = id(a[1], tr('Análisis no válido.', 'Invalid analysis.'));
    if (before === after) throw new IpcValidationError(tr('Elige dos análisis distintos.', 'Choose two different analyses.'));
    return [before, after];
  },
  'settings:get': (a) => (count(a, 0), []),
  'settings:set': (a) => {
    count(a, 1);
    const r = validateSettings(a[0], currentLocale());
    if (!r.ok) throw new IpcValidationError(r.errors.join(' '));
    return [r.value];
  },
  'secrets:status': (a) => (count(a, 0), []),
  'secrets:set': (a) => {
    count(a, 2);
    return [secretName(a[0]), text(a[1], tr('Credencial no válida.', 'Invalid credential.'), 1000)];
  },
  'secrets:delete': (a) => (count(a, 1), [secretName(a[0])]),
  'jobs:start': (a) => (count(a, 1), [id(a[0], tr('Proyecto no válido.', 'Invalid project.'))]),
  'jobs:cancel': (a) => {
    count(a, 1);
    const jobId = text(a[0], tr('Análisis no válido.', 'Invalid analysis.'), 36);
    if (!/^[0-9a-f-]{36}$/.test(jobId)) throw new IpcValidationError(tr('Análisis no válido.', 'Invalid analysis.'));
    return [jobId];
  },
  'jobs:list': (a) => (count(a, 0), []),
  'files:snippet': (a) => {
    count(a, 4);
    const start = line(a[2]);
    const end = line(a[3]);
    if (end < start) throw new IpcValidationError(tr('Rango de líneas no válido.', 'Invalid line range.'));
    return [id(a[0], tr('Análisis no válido.', 'Invalid analysis.')), relPath(a[1]), start, end];
  },
  'files:reveal': (a) => (count(a, 2), [id(a[0], tr('Análisis no válido.', 'Invalid analysis.')), relPath(a[1])]),
  'files:savePatch': (a) => (count(a, 2), [id(a[0], tr('Análisis no válido.', 'Invalid analysis.')), findingId(a[1])]),
  'ai:explain': (a) => (count(a, 2), [id(a[0], tr('Análisis no válido.', 'Invalid analysis.')), findingId(a[1])]),
  'ai:models': (a) => (count(a, 0), []),
  'ai:checkKey': (a) => (count(a, 0), []),
  'ai:includedQuota': (a) => (count(a, 0), []),
  'ai:fixPreview': (a) => (count(a, 2), [id(a[0], tr('Análisis no válido.', 'Invalid analysis.')), findingId(a[1])]),
  'ai:proposeFix': (a) => {
    count(a, 3);
    if (typeof a[2] !== 'boolean') throw new IpcValidationError(tr('Confirmación no válida.', 'Invalid confirmation.'));
    return [id(a[0], tr('Análisis no válido.', 'Invalid analysis.')), findingId(a[1]), a[2]];
  },
  'ai:getFix': (a) => (count(a, 2), [id(a[0], tr('Análisis no válido.', 'Invalid analysis.')), findingId(a[1])]),
  'chat:list': (a) => (count(a, 1), [id(a[0], tr('Análisis no válido.', 'Invalid analysis.'))]),
  'chat:ask': (a) => {
    count(a, 2);
    const q = typeof a[1] === 'string' ? a[1].trim() : '';
    if (q === '') throw new IpcValidationError(tr('Escribe una pregunta.', 'Write a question.'));
    if (q.length > MAX_QUESTION_CHARS) throw new IpcValidationError(tr(`La pregunta es demasiado larga (máximo ${MAX_QUESTION_CHARS} caracteres).`, `The question is too long (at most ${MAX_QUESTION_CHARS} characters).`));
    return [id(a[0], tr('Análisis no válido.', 'Invalid analysis.')), q];
  },
  'chat:clear': (a) => (count(a, 1), [id(a[0], tr('Análisis no válido.', 'Invalid analysis.'))]),
  'sync:state': (a) => (count(a, 0), []),
  'sync:now': (a) => (count(a, 0), []),
  'sync:deleteCloud': (a) => (count(a, 0), []),
};

function findingId(v: unknown): string {
  const f = text(v, tr('Hallazgo no válido.', 'Invalid finding.'), 128);
  if (!/^[\w:.-]+$/.test(f)) throw new IpcValidationError(tr('Hallazgo no válido.', 'Invalid finding.'));
  return f;
}

function line(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > 10_000_000) throw new IpcValidationError(tr('Número de línea no válido.', 'Invalid line number.'));
  return v;
}

/** Ruta relativa del proyecto con barras normales, sin unidad ni "..". */
function relPath(v: unknown): string {
  const p = text(v, tr('Ruta no válida.', 'Invalid path.'), 1000);
  if (p.includes('\0') || p.includes('\\') || p.startsWith('/') || /^[a-z]:/i.test(p) || p.split('/').includes('..')) throw new IpcValidationError(tr('Ruta no válida.', 'Invalid path.'));
  return p;
}

function secretName(v: unknown): SecretName {
  if (typeof v !== 'string' || !(SECRET_NAMES as readonly string[]).includes(v)) throw new IpcValidationError(tr('Credencial desconocida.', 'Unknown credential.'));
  return v as SecretName;
}

/** Las reglas del formulario (longitud, formato) las aplica el servicio de cuentas con mensajes propios. */
function email(v: unknown): string {
  return text(v, tr('Correo no válido.', 'Invalid email.'), MAX_EMAIL + 20);
}

function password(v: unknown): string {
  return text(v, tr('Contraseña no válida.', 'Invalid password.'), 1000);
}

function code(v: unknown): string {
  const c = text(v, tr('Código no válido.', 'Invalid code.'), 20).trim();
  if (!/^\d{6,10}$/.test(c)) throw new IpcValidationError(tr('El código son los dígitos que llegaron a tu correo.', 'The code is the digits sent to your email.'));
  return c;
}
