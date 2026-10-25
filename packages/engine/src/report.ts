import type { ReportComparison } from './compare.js';
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
  const { score, summary, stats } = report;
  const out: string[] = [];
  out.push('');
  out.push(`Radar de Deuda Técnica v${report.engineVersion} — ${report.root}`);
  if (report.vcs?.head) {
    const branch = report.vcs.branch ? ` (${report.vcs.branch})` : '';
    out.push(`Commit ${report.vcs.head.slice(0, 10)}${branch}${report.vcs.remoteUrl ? ` · ${report.vcs.remoteUrl}` : ''}${report.vcs.shallow ? ' · historial superficial' : ''}`);
  }
  out.push('─'.repeat(72));
  out.push(`Mantenibilidad: ${score.score}/100 (calificación ${score.rating}) · ratio de deuda ${(score.debtRatio * 100).toFixed(1)} %`);
  out.push(`Esfuerzo estimado de corrección: ${hours(score.remediationMinutes)} sobre ${score.codeLines} líneas de código`);
  out.push(
    `Hallazgos: ${report.findings.length} — ` +
      (Object.keys(SEVERITY_LABEL) as Severity[]).map((s) => `${SEVERITY_LABEL[s]} ${summary.bySeverity[s]}`).join(' · '),
  );
  const cats = Object.entries(summary.byCategory)
    .map(([c, n]) => `${CATEGORY_LABEL[c as Category]} ${n}`)
    .join(' · ');
  if (cats) out.push(`Por categoría: ${cats}`);
  out.push('');

  const shown = report.findings.filter((f) => f.severity !== 'info').slice(0, maxFindings);
  if (shown.length > 0) {
    out.push(`Principales hallazgos (${shown.length} de ${report.findings.length}):`);
    for (const f of shown) {
      const loc = f.locations[0];
      const where = loc ? `${loc.file}:${loc.startLine}${loc.endLine !== loc.startLine ? `-${loc.endLine}` : ''}` : '';
      out.push(`  [${SEVERITY_LABEL[f.severity]}] ${f.title}`);
      out.push(`      ${where}${f.locations.length > 1 ? ` (+${f.locations.length - 1} ubicaciones)` : ''} · confianza ${CONFIDENCE_LABEL[f.confidence]} · ~${hours(f.effort.minutes)}`);
    }
    out.push('');
  }

  if (report.hotspots && report.hotspots.length > 0) {
    out.push('Puntos críticos (cambian a menudo y acumulan deuda; empieza por aquí):');
    for (const h of report.hotspots.slice(0, 8)) {
      out.push(`  ${String(h.score).padStart(3)}  ${h.file} · ${h.commits} commits · ${h.authors} autor(es) · deuda ~${hours(h.debtMinutes)}`);
    }
    out.push('');
  }

  const partial = report.coverage.filter((c) => c.status !== 'analyzed');
  if (partial.length > 0) {
    out.push('Límites de este análisis:');
    for (const c of partial) out.push(`  - ${c.area}: ${c.detail}`);
    out.push('');
  }
  if (report.errors.length > 0) {
    out.push(`Errores de analizadores (${report.errors.length}):`);
    for (const e of report.errors.slice(0, 10)) out.push(`  - ${e.analyzer}${e.file ? ` en ${e.file}` : ''}: ${e.message}`);
    out.push('');
  }
  out.push(
    `Archivos: ${stats.filesDiscovered} descubiertos · ${stats.filesAnalyzed} analizados · ${stats.cacheHits} desde caché · ${stats.skipped.length} omitidos`,
  );
  out.push(`Recursos: ${(stats.durationMs / 1000).toFixed(2)} s · CPU ${stats.cpuUserMs + stats.cpuSystemMs} ms · RAM pico ${stats.peakRssMb} MB`);
  out.push('');
  return out.join('\n');
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
