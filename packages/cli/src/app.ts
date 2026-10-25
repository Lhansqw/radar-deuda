/**
 * Lógica de la CLI, separada del punto de entrada para poder probarla sin
 * lanzar un proceso.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  analyzeRepository,
  compareReports,
  DEFAULT_PROJECT_ANALYZERS,
  defaultCacheDir,
  formatComparison,
  formatReport,
  hasNewAtLeast,
  parseReport,
  SEVERITY_ORDER,
  type AnalysisReport,
  type ProjectAnalyzer,
  type Severity,
} from '@radar/engine';
import {
  cloneOrUpdate,
  computeHotspots,
  fileChurn,
  getRepoInfo,
  GitHubClient,
  HttpError,
  NpmRegistryClient,
  OsvClient,
  outdatedAnalyzer,
  parseGitHubRepo,
  tokenFromEnv,
  vulnerabilityAnalyzer,
} from '@radar/sources';

export const HELP = `
Uso: radar-deuda <carpeta | owner/repo | URL de GitHub> [opciones]

Origen:
  <carpeta>               Repositorio local (si la carpeta existe, tiene prioridad)
  owner/repo, github:owner/repo, https://github.com/owner/repo
                          Se clona (superficial) en %LOCALAPPDATA%\\radar-deuda\\repos.
                          Repos privados: define RADAR_GITHUB_TOKEN (token fine-grained
                          de solo lectura). El token nunca se guarda en disco.
  --branch <rama>         Rama a clonar (por defecto, la principal)

Análisis:
  --online                Consulta vulnerabilidades (OSV) y versiones (registro npm).
                          Solo se envían nombres y versiones de paquetes, nunca código.
  --no-history            No calcula puntos críticos con el historial de Git
  --since <AAAA-MM-DD>    Inicio del historial para los puntos críticos (por defecto, 12 meses)
  --no-cache              Desactiva todas las cachés
  --cache-dir <dir>       Directorio de caché del motor
  --concurrency <n>       Lecturas simultáneas (1–64, por defecto 8)

Salida:
  --json <archivo>        Guarda el informe completo en JSON
  --baseline <archivo>    Compara con un informe JSON anterior (deuda nueva y resuelta)
  --top <n>               Hallazgos a mostrar (por defecto 15)
  --fail-on <sev>         Código 1 si hay hallazgos de esa severidad o mayor
  --fail-on-new <sev>     Con --baseline: código 1 solo si hay hallazgos NUEVOS de esa severidad o mayor
                          (critical | high | medium | low)
  --quiet                 Sin progreso ni avisos
  -h, --help              Muestra esta ayuda

Códigos de salida: 0 correcto · 1 umbral superado · 2 error · 130 cancelado
`;

export interface CliOptions {
  target: string;
  json?: string;
  baseline?: string;
  branch?: string;
  since?: string;
  cacheDir?: string;
  noCache: boolean;
  online: boolean;
  history: boolean;
  quiet: boolean;
  concurrency?: number;
  top: number;
  failOn?: Severity;
  failOnNew?: Severity;
}

type Parsed = { kind: 'run'; options: CliOptions } | { kind: 'help' } | { kind: 'error'; message: string };

function severityOption(name: string, value: string | undefined): Severity | undefined | Error {
  if (value === undefined) return undefined;
  return value in SEVERITY_ORDER && value !== 'info' ? (value as Severity) : new Error(`Severidad no válida para --${name}: ${value}`);
}

export function parseCli(argv: string[]): Parsed {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'string' },
        baseline: { type: 'string' },
        branch: { type: 'string' },
        since: { type: 'string' },
        online: { type: 'boolean', default: false },
        'no-history': { type: 'boolean', default: false },
        'no-cache': { type: 'boolean', default: false },
        'cache-dir': { type: 'string' },
        concurrency: { type: 'string' },
        top: { type: 'string' },
        'fail-on': { type: 'string' },
        'fail-on-new': { type: 'string' },
        quiet: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
  const { values: v, positionals } = parsed;
  if (v.help) return { kind: 'help' };
  if (positionals.length !== 1) return { kind: 'error', message: 'Indica exactamente una carpeta o repositorio a analizar.' };
  const failOn = severityOption('fail-on', v['fail-on']);
  const failOnNew = severityOption('fail-on-new', v['fail-on-new']);
  if (failOn instanceof Error) return { kind: 'error', message: failOn.message };
  if (failOnNew instanceof Error) return { kind: 'error', message: failOnNew.message };
  if (failOnNew && !v.baseline) return { kind: 'error', message: '--fail-on-new requiere --baseline.' };
  if (v.since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(v.since)) return { kind: 'error', message: `Fecha no válida para --since: ${v.since} (usa AAAA-MM-DD).` };
  const top = v.top !== undefined ? Number(v.top) : 15;
  const options: CliOptions = {
    target: positionals[0] as string,
    noCache: v['no-cache'],
    online: v.online,
    history: !v['no-history'],
    quiet: v.quiet,
    top: Number.isInteger(top) && top >= 0 ? top : 15,
    ...(v.json !== undefined ? { json: v.json } : {}),
    ...(v.baseline !== undefined ? { baseline: v.baseline } : {}),
    ...(v.branch !== undefined ? { branch: v.branch } : {}),
    ...(v.since !== undefined ? { since: v.since } : {}),
    ...(v['cache-dir'] !== undefined ? { cacheDir: v['cache-dir'] } : {}),
    ...(v.concurrency !== undefined ? { concurrency: Number(v.concurrency) } : {}),
    ...(failOn ? { failOn } : {}),
    ...(failOnNew ? { failOnNew } : {}),
  };
  return { kind: 'run', options };
}

export interface Io {
  info(message: string): void;
  warn(message: string): void;
}

/** Carpeta local o, si no existe, repositorio de GitHub clonado. */
async function resolveTarget(o: CliOptions, io: Io, signal: AbortSignal): Promise<string> {
  const local = path.resolve(o.target);
  if (existsSync(local)) return local;
  const ref = parseGitHubRepo(o.target);
  if (!ref) throw new Error(`No existe la carpeta "${o.target}" ni es una referencia válida a GitHub (owner/repo o URL).`);

  const token = tokenFromEnv();
  const gh = new GitHubClient({ ...(token ? { token } : {}), signal });
  let meta: Awaited<ReturnType<GitHubClient['getRepository']>> | null = null;
  try {
    meta = await gh.getRepository(ref);
    if (token) for (const w of (await gh.checkToken()).warnings) io.warn(w);
  } catch (err) {
    // 401 (token inválido) y 404 (no existe o sin acceso) son definitivos. Los metadatos son opcionales:
    // ante un límite de peticiones, un error del servidor o falta de red, se intenta clonar igualmente.
    if (err instanceof Error && err.cause instanceof HttpError && (err.cause.status === 401 || err.cause.status === 404)) throw err;
    io.warn(`No se pudieron obtener los metadatos de GitHub (${err instanceof Error ? err.message : String(err)}). Se intenta clonar igualmente.`);
  }
  io.info(`Clonando ${ref.owner}/${ref.repo}${meta ? ` (${Math.round(meta.sizeKb / 1024)} MB, rama ${o.branch ?? meta.defaultBranch})` : ''}…`);
  const branch = o.branch ?? meta?.defaultBranch;
  const clone = await cloneOrUpdate(ref, {
    ...(token ? { token } : {}),
    ...(branch ? { branch } : {}),
    ...(o.history ? { shallowSince: historyStart(o) } : {}),
    ...(meta ? { sizeKb: meta.sizeKb } : {}),
    signal,
  });
  io.info(`${clone.updated ? 'Actualizado' : 'Clonado'} en ${clone.dir}`);
  return clone.dir;
}

/** Inicio del periodo de historial: --since o hace 12 meses (AAAA-MM-DD). */
function historyStart(o: CliOptions): string {
  return o.since ?? new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

function onlineAnalyzers(o: CliOptions): ProjectAnalyzer[] {
  const base = o.noCache ? null : defaultCacheDir();
  return [
    vulnerabilityAnalyzer(new OsvClient({ cacheDir: base ? path.join(base, 'osv') : null })),
    outdatedAnalyzer(new NpmRegistryClient({ cacheDir: base ? path.join(base, 'npm') : null })),
  ];
}

/** Añade al informe el commit analizado y, con historial completo, los puntos críticos. */
async function addGitContext(report: AnalysisReport, o: CliOptions, io: Io, signal: AbortSignal): Promise<void> {
  let info;
  try {
    info = await getRepoInfo(report.root, signal);
  } catch (err) {
    io.warn(`Git no disponible: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!info) return;
  report.vcs = { head: info.head, branch: info.branch, remoteUrl: info.remoteUrl, shallow: info.shallow };
  if (!o.history || !info.head) return;
  const since = historyStart(o);
  const prefix = path.relative(info.root, report.root).split(path.sep).join('/');
  const churn = await fileChurn(info.root, { since, ...(prefix ? { pathPrefix: prefix } : {}), signal });
  report.hotspots = computeHotspots(report, churn, { prefix });
  report.coverage.push(
    info.shallow
      ? { area: 'Puntos críticos', status: 'partial', detail: `Clon superficial: solo se dispone del historial descargado (desde ${since} como mucho); ${churn.size} archivo(s) con cambios.` }
      : { area: 'Puntos críticos', status: 'analyzed', detail: `Historial de Git desde ${since}: ${churn.size} archivo(s) con cambios.` },
  );
}

export async function run(o: CliOptions, io: Io, signal: AbortSignal): Promise<number> {
  const showProgress = !o.quiet && process.stderr.isTTY;
  const dir = await resolveTarget(o, io, signal);
  if (o.online) io.info('Modo en línea: se enviarán nombres y versiones de paquetes a api.osv.dev y registry.npmjs.org.');

  const report = await analyzeRepository(dir, {
    config: o.concurrency !== undefined ? { concurrency: o.concurrency } : {},
    ...(o.noCache ? { cacheDir: null } : o.cacheDir ? { cacheDir: o.cacheDir } : {}),
    ...(o.online ? { projectAnalyzers: [...DEFAULT_PROJECT_ANALYZERS, ...onlineAnalyzers(o)] } : {}),
    signal,
    ...(showProgress
      ? {
          onProgress: (e) => {
            if (e.phase === 'files') process.stderr.write(`\rAnalizando archivos ${e.done}/${e.total}…`);
            if (e.phase === 'cross-file') process.stderr.write('\rAnálisis entre archivos…            ');
            if (e.phase === 'project') process.stderr.write(`\r${o.online ? 'Consultando dependencias…' : 'Analizando el proyecto…'}      `);
            if (e.phase === 'done') process.stderr.write('\r'.padEnd(60) + '\r');
          },
        }
      : {}),
  });
  await addGitContext(report, o, io, signal);
  console.log(formatReport(report, o.top));

  let comparison = null;
  if (o.baseline) {
    comparison = compareReports(parseReport(await readFile(path.resolve(o.baseline), 'utf8')), report);
    console.log(formatComparison(comparison));
  }
  if (o.json) {
    const out = path.resolve(o.json);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(report, null, 2), 'utf8');
    console.log(`Informe JSON guardado en ${out}`);
  }
  if (o.failOn) {
    const limit = SEVERITY_ORDER[o.failOn];
    if (report.findings.some((f) => SEVERITY_ORDER[f.severity] >= limit)) return 1;
  }
  if (o.failOnNew && comparison && hasNewAtLeast(comparison, o.failOnNew)) return 1;
  return 0;
}
