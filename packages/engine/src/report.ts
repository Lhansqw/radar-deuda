import { findingRefs } from './refs.js';
import type { ReportComparison } from './types.js';
import type { AnalysisReport, Category, Confidence, Finding, Severity } from './types.js';

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'CRÍTICA',
  high: 'ALTA',
  medium: 'MEDIA',
  low: 'BAJA',
  info: 'INFO',
};

export const CATEGORY_LABEL: Record<Category, string> = {
  complexity: 'Complejidad',
  size: 'Tamaño',
  duplication: 'Duplicación',
  security: 'Seguridad',
  dependencies: 'Dependencias',
  testing: 'Pruebas',
  maintainability: 'Mantenibilidad',
};

const CONFIDENCE_LABEL: Record<Confidence, string> = { high: 'alta', medium: 'media', low: 'baja' };

function hours(minutes: number): string {
  return minutes < 60 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
}

/** Resumen legible para la terminal. La interfaz de escritorio consumirá el JSON. */
export function formatReport(report: AnalysisReport, maxFindings = 15): string {
  return [
    '',
    ...headerLines(report),
    '─'.repeat(72),
    ...scoreLines(report),
    '',
    ...section(findingLines(report, maxFindings)),
    ...section(hotspotLines(report)),
    ...section(limitLines(report)),
    ...section(errorLines(report)),
    ...statsLines(report),
    '',
  ].join('\n');
}

/** Un bloque seguido de una línea en blanco, o nada si está vacío. */
const section = (lines: string[]): string[] => (lines.length > 0 ? [...lines, ''] : []);

function headerLines({ engineVersion, root, vcs }: AnalysisReport): string[] {
  const out = [`Radar de Deuda Técnica v${engineVersion} — ${root}`];
  if (vcs?.head) {
    const branch = vcs.branch ? ` (${vcs.branch})` : '';
    out.push(`Commit ${vcs.head.slice(0, 10)}${branch}${vcs.remoteUrl ? ` · ${vcs.remoteUrl}` : ''}${vcs.shallow ? ' · historial superficial' : ''}`);
  }
  return out;
}

function scoreLines({ score, summary, findings }: AnalysisReport): string[] {
  const severities = (Object.keys(SEVERITY_LABEL) as Severity[]).map((s) => `${SEVERITY_LABEL[s]} ${summary.bySeverity[s]}`).join(' · ');
  const cats = Object.entries(summary.byCategory)
    .map(([c, n]) => `${CATEGORY_LABEL[c as Category]} ${n}`)
    .join(' · ');
  return [
    `Mantenibilidad: ${score.score}/100 (calificación ${score.rating}) · ratio de deuda ${(score.debtRatio * 100).toFixed(1)} %`,
    `Esfuerzo estimado de corrección: ${hours(score.remediationMinutes)} sobre ${score.codeLines} líneas de código`,
    `Hallazgos: ${findings.length} — ${severities}`,
    ...(cats ? [`Por categoría: ${cats}`] : []),
  ];
}

/** En el orden de sus referencias (H1, H2…), las mismas que se citan al preguntar a la IA. */
function findingLines(report: AnalysisReport, max: number): string[] {
  const refs = findingRefs(report.findings);
  const rank = (f: Finding): number => Number((refs.get(f.id) ?? 'H0').slice(1));
  const shown = report.findings
    .filter((f) => f.severity !== 'info')
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, max);
  if (shown.length === 0) return [];
  return [`Principales hallazgos (${shown.length} de ${report.findings.length}):`, ...shown.flatMap((f) => findingEntry(f, refs.get(f.id) ?? ''))];
}

function findingEntry(f: Finding, ref: string): string[] {
  const loc = f.locations[0];
  const where = loc ? `${loc.file}:${loc.startLine}${loc.endLine !== loc.startLine ? `-${loc.endLine}` : ''}` : '';
  const more = f.locations.length > 1 ? ` (+${f.locations.length - 1} ubicaciones)` : '';
  return [`  ${ref.padEnd(4)}[${SEVERITY_LABEL[f.severity]}] ${f.title}`, `          ${where}${more} · confianza ${CONFIDENCE_LABEL[f.confidence]} · ~${hours(f.effort.minutes)}`];
}

function hotspotLines({ hotspots }: AnalysisReport): string[] {
  if (!hotspots || hotspots.length === 0) return [];
  return [
    'Puntos críticos (cambian a menudo y acumulan deuda; empieza por aquí):',
    ...hotspots.slice(0, 8).map((h) => `  ${String(h.score).padStart(3)}  ${h.file} · ${h.commits} commits · ${h.authors} autor(es) · deuda ~${hours(h.debtMinutes)}`),
  ];
}

function limitLines({ coverage }: AnalysisReport): string[] {
  const partial = coverage.filter((c) => c.status !== 'analyzed');
  return partial.length === 0 ? [] : ['Límites de este análisis:', ...partial.map((c) => `  - ${c.area}: ${c.detail}`)];
}

function errorLines({ errors }: AnalysisReport): string[] {
  if (errors.length === 0) return [];
  return [`Errores de analizadores (${errors.length}):`, ...errors.slice(0, 10).map((e) => `  - ${e.analyzer}${e.file ? ` en ${e.file}` : ''}: ${e.message}`)];
}

function statsLines({ stats }: AnalysisReport): string[] {
  return [
    `Archivos: ${stats.filesDiscovered} descubiertos · ${stats.filesAnalyzed} analizados · ${stats.cacheHits} desde caché · ${stats.skipped.length} omitidos`,
    `Recursos: ${(stats.durationMs / 1000).toFixed(2)} s · CPU ${stats.cpuUserMs + stats.cpuSystemMs} ms · RAM pico ${stats.peakRssMb} MB`,
  ];
}

function line(f: Finding): string {
  const loc = f.locations[0];
  return `  [${SEVERITY_LABEL[f.severity]}] ${f.title}${loc ? ` — ${loc.file}:${loc.startLine}` : ''}`;
}

/** Resumen de la comparación con un informe anterior. */
export function formatComparison(c: ReportComparison, max = 10): string {
  const out: string[] = [];
  const sign = (n: number): string => (n > 0 ? `+${n}` : String(n));
  const ref = c.baseline.head ? `commit ${c.baseline.head.slice(0, 10)}` : c.baseline.generatedAt;
  out.push(`Comparación con el análisis de referencia (${ref}):`);
  out.push(`  Puntuación ${sign(c.scoreDelta)} · esfuerzo ${sign(c.remediationDeltaMinutes)} min · ${c.added.length} nuevos · ${c.resolved.length} resueltos · ${c.persisting} sin cambios`);
  if (c.added.length > 0) {
    out.push('  Nuevos:');
    for (const f of c.added.slice(0, max)) out.push(`  ${line(f)}`);
  }
  if (c.changed.length > 0) {
    out.push('  Cambiaron de severidad:');
    for (const { before, after } of c.changed.slice(0, max)) out.push(`    ${after.title}: ${SEVERITY_LABEL[before.severity]} → ${SEVERITY_LABEL[after.severity]}`);
  }
  if (c.resolved.length > 0) {
    out.push('  Resueltos:');
    for (const f of c.resolved.slice(0, max)) out.push(`  ${line(f)}`);
  }
  out.push('');
  return out.join('\n');
}
