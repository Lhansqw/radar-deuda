/**
 * Lógica de la CLI, separada del punto de entrada para poder probarla sin
 * lanzar un proceso.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { compareReports, defaultCacheDir, findFindingByRef, findingRefs, formatComparison, formatReport, hasNewAtLeast, parseReport, SEVERITY_ORDER, type Severity } from '@radar/engine';
import { tokenFromEnv } from '@radar/sources';
import { formatAiSection, formatChatAnswer, formatFixProposal } from '@radar/ai';
import { askStep, keysFromEnv, proposeFixStep, runPipeline, type PipelineEvent } from '@radar/pipeline';
import { AI_ARGS, AI_HELP, parseAiOptions, type AiCliOptions } from './ai-setup.js';

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

Con IA (requieren --ai; en lugar de explicar los hallazgos):
  --preguntar "<texto>"   Pregunta sobre el análisis. Solo se envían datos del informe, nunca código
                          (con --baseline, también la deuda nueva y resuelta)
  --proponer <ref>        Propuesta de corrección de un hallazgo (H2, o su identificador) como
                          diferencia. Necesita enviar su código: en la nube, --privacy fragmentos
  --parche <archivo>      Con --proponer: guarda el parche para aplicarlo con git apply
  -h, --help              Muestra esta ayuda

Códigos de salida: 0 correcto · 1 umbral superado · 2 error · 130 cancelado
`;

export const FULL_HELP = HELP.trimEnd() + '\n' + AI_HELP;

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
  ai?: AiCliOptions;
  /** Pregunta a la IA sobre el análisis (en lugar de explicar los hallazgos). */
  ask?: string;
  /** Referencia del hallazgo del que proponer una corrección. */
  propose?: string;
  patch?: string;
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
        preguntar: { type: 'string' },
        proponer: { type: 'string' },
        parche: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
        ...AI_ARGS,
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
  const ai = parseAiOptions(v);
  if (ai instanceof Error) return { kind: 'error', message: ai.message };
  if ((v.preguntar !== undefined || v.proponer !== undefined) && !ai) return { kind: 'error', message: '--preguntar y --proponer requieren --ai.' };
  if (v.preguntar !== undefined && (v.preguntar.trim() === '' || v.preguntar.length > 2000)) return { kind: 'error', message: '--preguntar necesita una pregunta de hasta 2000 caracteres.' };
  if (v.parche !== undefined && v.proponer === undefined) return { kind: 'error', message: '--parche requiere --proponer.' };
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
    ...(ai ? { ai } : {}),
    ...(v.preguntar !== undefined ? { ask: v.preguntar.trim() } : {}),
    ...(v.proponer !== undefined ? { propose: v.proponer.trim() } : {}),
    ...(v.parche !== undefined ? { patch: v.parche } : {}),
  };
  return { kind: 'run', options };
}

export interface Io {
  info(message: string): void;
  warn(message: string): void;
}

/** Progreso en una sola línea de la terminal (solo si es interactiva). */
function progressLine(e: PipelineEvent, online: boolean): string | null {
  switch (e.phase) {
    case 'files':
      return `Analizando archivos ${e.done}/${e.total}…`;
    case 'cross-file':
      return 'Análisis entre archivos…';
    case 'project':
      return online ? 'Consultando dependencias…' : 'Analizando el proyecto…';
    case 'history':
      return 'Leyendo el historial de Git…';
    case 'ai':
      return e.done < e.total ? `IA: ${e.done}/${e.total}…` : '';
    case 'done':
      return '';
    default:
      return null;
  }
}

export async function run(o: CliOptions, io: Io, signal: AbortSignal): Promise<number> {
  const showProgress = !o.quiet && process.stderr.isTTY;
  const token = tokenFromEnv();
  const { report, aiLabel = '' } = await runPipeline(
    {
      target: o.target,
      history: o.history,
      online: o.online,
      noCache: o.noCache,
      ...(o.branch !== undefined ? { branch: o.branch } : {}),
      ...(o.since !== undefined ? { since: o.since } : {}),
      ...(o.cacheDir !== undefined ? { cacheDir: o.cacheDir } : {}),
      ...(o.concurrency !== undefined ? { concurrency: o.concurrency } : {}),
      ...(token ? { githubToken: token } : {}),
      // Con --preguntar o --proponer, la IA se usa solo para eso (no se explican los hallazgos).
      ...(o.ai && !o.ask && !o.propose ? { ai: o.ai, keys: keysFromEnv() } : {}),
    },
    {
      info: io.info,
      warn: io.warn,
      ...(showProgress
        ? {
            progress: (e: PipelineEvent) => {
              const line = progressLine(e, o.online);
              if (line !== null) process.stderr.write(`\r${line.padEnd(40)}${line === '' ? '\r' : ''}`);
            },
          }
        : {}),
    },
    signal,
  );
  console.log(formatReport(report, o.top));
  if (report.ai) console.log(formatAiSection(report.ai, report, aiLabel));

  let comparison = null;
  if (o.baseline) {
    comparison = compareReports(parseReport(await readFile(path.resolve(o.baseline), 'utf8')), report);
    console.log(formatComparison(comparison));
  }
  if (o.ai && o.propose) await proposeFromCli(report, o, o.ai, io, signal);
  if (o.ai && o.ask) {
    io.info('Preguntando a la IA…');
    const answer = await askStep(report, [], o.ask, o.ai, keysFromEnv(), { comparison, signal });
    console.log(formatChatAnswer(answer, report));
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

async function proposeFromCli(report: Parameters<typeof formatReport>[0], o: CliOptions, ai: AiCliOptions, io: Io, signal: AbortSignal): Promise<void> {
  const finding = findFindingByRef(report.findings, o.propose ?? '');
  if (!finding) throw new Error(`No hay ningún hallazgo «${o.propose}» en este análisis. Usa su referencia de la lista (H1, H2…) o su identificador.`);
  const ref = findingRefs(report.findings).get(finding.id) ?? finding.id;
  io.info(`Pidiendo una propuesta de corrección para ${ref}…`);
  const proposal = await proposeFixStep(report, finding.id, ai, keysFromEnv(), { consent: false, cacheBase: o.noCache ? null : defaultCacheDir(), signal });
  console.log(formatFixProposal(proposal, finding, ref));
  if (o.patch) {
    if (proposal.patch === '') {
      io.warn('No se guardó ningún parche: la propuesta no tiene cambios.');
      return;
    }
    const out = path.resolve(o.patch);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, proposal.patch, 'utf8');
    console.log(`Parche guardado en ${out}. Para aplicarlo, en la carpeta del proyecto: git apply ${path.basename(out)}`);
  }
}
