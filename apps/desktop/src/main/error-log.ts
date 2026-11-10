import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '@radar/engine';

/**
 * Registro local de errores (sin servicios externos): para saber qué falló en
 * el equipo de un usuario sin que la aplicación envíe nada. Se guarda en
 * `<datos>/registros`, una línea JSON por error, con tamaño acotado (al
 * llenarse, el archivo pasa a `.1` y se empieza otro). El usuario lo ve y lo
 * copia desde Configuración → Aplicación → Diagnóstico.
 *
 * Antes de guardar, cada texto se limpia: rutas del equipo, correos, claves
 * con formato conocido y parámetros de las URL. Registrar nunca lanza: un
 * fallo del registro no puede tumbar la aplicación.
 */

export type ErrorSource = 'principal' | 'análisis' | 'interfaz' | 'ipc';

export interface ErrorEntry {
  /** ISO 8601. */
  at: string;
  source: ErrorSource;
  message: string;
  stack?: string;
}

const SOURCES: ReadonlySet<string> = new Set<ErrorSource>(['principal', 'análisis', 'interfaz', 'ipc']);
const MAX_MESSAGE = 1000;
const MAX_STACK = 4000;

/** Rutas absolutas: `C:\…` o `C:/…`, `\\servidor\…`, `file:///…` y las de los directorios de usuario y temporales de Linux y macOS. */
const WINDOWS_PATH = /\b[A-Za-z]:[\\/][^\s"'<>|*?:]*/g;
const UNC_PATH = /\\\\[^\s"'<>|*?:\\]+\\[^\s"'<>|*?:]*/g;
const FILE_URL = /file:\/\/\/?[^\s"'<>)]*/gi;
const POSIX_PATH = /(?<![\w.])\/(?:home|Users|tmp|var|private|mnt|media|opt|root|Volumes|run)\/[^\s"'<>:)]*/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** Los parámetros de una URL pueden llevar claves o tokens (`?apikey=…`). */
const URL_QUERY = /(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>)]*/gi;

export interface SanitizeOptions {
  /** Carpeta de la aplicación: sus rutas se conservan como `<app>/…` (ayudan a localizar el fallo y no dicen nada del usuario). */
  appRoot?: string;
}

const forwardSlashes = (p: string): string => p.split('\\').join('/');

/** Quita del texto lo que identifica al usuario o a su código. */
export function sanitize(text: string, options: SanitizeOptions = {}): string {
  const out = (options.appRoot ? replaceAppRoot(text, options.appRoot) : text)
    .replace(URL_QUERY, '$1?…')
    .replace(FILE_URL, '<ruta>')
    .replace(UNC_PATH, '<ruta>')
    .replace(WINDOWS_PATH, '<ruta>')
    .replace(POSIX_PATH, '<ruta>')
    .replace(EMAIL, '<correo>');
  return redactSecrets(out);
}

/** `C:\…\resources\app.asar\dist\main.cjs` → `<app>/dist/main.cjs`, escrita con `\` o con `/`. */
function replaceAppRoot(text: string, appRoot: string): string {
  const root = appRoot.replace(/[\\/]+$/, '');
  const variants = [...new Set([root, root.split('\\').join('/'), root.split('/').join('\\')])];
  let out = text;
  for (const v of variants) {
    out = out.replace(new RegExp(`${escapeRegExp(v)}((?:[\\\\/][^\\s"'<>|*?:\\\\/]*)*)`, 'g'), (_m, rest: string) => `<app>${forwardSlashes(rest)}`);
  }
  return out;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

export interface ErrorLogOptions {
  /** Carpeta del registro (`<datos>/registros`). */
  dir: string;
  appRoot?: string;
  /** Tamaño máximo del archivo actual antes de rotar. */
  maxBytes?: number;
  now?: () => Date;
}

export class ErrorLog {
  private readonly file: string;
  private readonly previous: string;
  private readonly maxBytes: number;
  private readonly now: () => Date;

  constructor(private readonly options: ErrorLogOptions) {
    this.file = path.join(options.dir, 'errores.jsonl');
    this.previous = path.join(options.dir, 'errores.1.jsonl');
    this.maxBytes = options.maxBytes ?? 256 * 1024;
    this.now = options.now ?? (() => new Date());
  }

  /** Guarda un error ya limpio. Devuelve la entrada guardada (o null si no se pudo). */
  record(source: ErrorSource, error: unknown): ErrorEntry | null {
    try {
      const entry = this.entry(source, error);
      const line = `${JSON.stringify(entry)}\n`;
      mkdirSync(this.options.dir, { recursive: true });
      if (this.size() + Buffer.byteLength(line) > this.maxBytes) renameSync(this.file, this.previous);
      appendFileSync(this.file, line);
      return entry;
    } catch {
      return null;
    }
  }

  /** Los últimos `limit` errores, del más reciente al más antiguo. */
  recent(limit = 20): ErrorEntry[] {
    const entries = [...this.read(this.previous), ...this.read(this.file)];
    return entries.slice(-limit).reverse();
  }

  clear(): void {
    for (const f of [this.file, this.previous]) rmSync(f, { force: true });
  }

  private entry(source: ErrorSource, error: unknown): ErrorEntry {
    const clean = (s: string) => sanitize(s, this.options.appRoot ? { appRoot: this.options.appRoot } : {});
    const raw = error instanceof Error ? error : null;
    const message = clip(clean(raw ? `${raw.name === 'Error' ? '' : `${raw.name}: `}${raw.message}` : String(error)), MAX_MESSAGE);
    const stack = raw?.stack ? clip(clean(raw.stack.split('\n').slice(1).join('\n').trim()), MAX_STACK) : '';
    return { at: this.now().toISOString(), source, message, ...(stack ? { stack } : {}) };
  }

  private size(): number {
    try {
      return statSync(this.file).size;
    } catch {
      return 0;
    }
  }

  private read(file: string): ErrorEntry[] {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    return text.split('\n').flatMap((line) => {
      try {
        const e = JSON.parse(line) as Partial<ErrorEntry>;
        return typeof e.at === 'string' && typeof e.message === 'string' && SOURCES.has(e.source as string) ? [e as ErrorEntry] : [];
      } catch {
        return [];
      }
    });
  }
}

/**
 * Errores que llegan de la interfaz (app:reportError), con un límite por
 * minuto: un error que se repite en bucle en la ventana no llena el registro.
 */
export function interfaceReporter(log: Pick<ErrorLog, 'record'>, { perMinute = 20, now = () => Date.now() } = {}): (message: string, stack: string | null) => void {
  let times: number[] = [];
  return (message, stack) => {
    const t = now();
    times = times.filter((x) => t - x < 60_000);
    if (times.length >= perMinute) return;
    times.push(t);
    const err = new Error(message);
    // La pila del navegador empieza por la línea del mensaje, como la de Node.
    err.stack = stack ?? '';
    log.record('interfaz', err);
  };
}

export interface DiagnosticsInput {
  versions: { app: string; electron: string; chrome: string; node: string };
  os: { platform: string; release: string; arch: string; locale: string; totalMemoryMb: number; freeMemoryMb: number };
  uptimeMinutes: number;
  errors: readonly ErrorEntry[];
}

const PLATFORM: Readonly<Record<string, string>> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

/** El texto que el usuario copia para un informe de error: versiones, sistema y errores recientes (ya limpios). */
export function buildDiagnostics(d: DiagnosticsInput): string {
  const lines = [
    `Radar de Deuda Técnica ${d.versions.app}`,
    `Electron ${d.versions.electron}, Chromium ${d.versions.chrome}, Node ${d.versions.node}`,
    `Sistema: ${PLATFORM[d.os.platform] ?? d.os.platform} ${d.os.release} (${d.os.arch}), idioma ${d.os.locale}`,
    `Memoria: ${d.os.totalMemoryMb} MB, libre ${d.os.freeMemoryMb} MB; abierta hace ${d.uptimeMinutes} min`,
    '',
  ];
  if (d.errors.length === 0) return [...lines, 'Sin errores registrados.'].join('\n');
  lines.push(`Errores recientes (${d.errors.length}, del más reciente al más antiguo):`);
  for (const e of d.errors) {
    lines.push('', `${e.at} [${e.source}] ${e.message}`);
    if (e.stack) lines.push(...e.stack.split('\n').map((l) => `    ${l.trim()}`));
  }
  return lines.join('\n');
}
