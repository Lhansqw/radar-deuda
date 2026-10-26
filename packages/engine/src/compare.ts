import { SEVERITY_ORDER, type AnalysisReport, type Finding, type ReportComparison, type Severity } from './types.js';

export type { ReportComparison };

/**
 * Compara dos informes por identificador de hallazgo, que es estable entre
 * ejecuciones (se ancla a regla, archivo y símbolo, no a números de línea).
 */
export function compareReports(baseline: AnalysisReport, current: AnalysisReport): ReportComparison {
  const before = new Map(baseline.findings.map((f) => [f.id, f]));
  const after = new Map(current.findings.map((f) => [f.id, f]));
  const added: Finding[] = [];
  const changed: ReportComparison['changed'] = [];
  let persisting = 0;
  for (const [id, f] of after) {
    const old = before.get(id);
    if (!old) added.push(f);
    else {
      persisting++;
      if (old.severity !== f.severity) changed.push({ before: old, after: f });
    }
  }
  const resolved = [...before.values()].filter((f) => !after.has(f.id));
  return {
    added,
    resolved,
    changed,
    persisting,
    scoreDelta: current.score.score - baseline.score.score,
    remediationDeltaMinutes: current.score.remediationMinutes - baseline.score.remediationMinutes,
    baseline: { generatedAt: baseline.generatedAt, head: baseline.vcs?.head ?? null },
  };
}

/** ¿Hay hallazgos nuevos de esta severidad o mayor? (para CI: "no añadir deuda"). */
export function hasNewAtLeast(comparison: ReportComparison, severity: Severity): boolean {
  const limit = SEVERITY_ORDER[severity];
  return comparison.added.some((f) => SEVERITY_ORDER[f.severity] >= limit) || comparison.changed.some((c) => SEVERITY_ORDER[c.after.severity] >= limit && SEVERITY_ORDER[c.after.severity] > SEVERITY_ORDER[c.before.severity]);
}

/** Valida y lee un informe guardado en JSON (p. ej. el de la ejecución anterior). */
export function parseReport(text: string): AnalysisReport {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error('El informe de referencia no es JSON válido.', { cause: err });
  }
  const r = data as Partial<AnalysisReport> | null;
  if (!r || typeof r !== 'object' || r.schemaVersion !== 1 || !Array.isArray(r.findings) || typeof r.score?.score !== 'number') {
    throw new Error('El archivo no es un informe de Radar de Deuda Técnica compatible (schemaVersion 1).');
  }
  for (const f of r.findings) {
    if (typeof f?.id !== 'string' || typeof f.severity !== 'string' || !(f.severity in SEVERITY_ORDER)) {
      throw new Error('El informe de referencia contiene hallazgos con un formato no válido.');
    }
  }
  return r as AnalysisReport;
}
