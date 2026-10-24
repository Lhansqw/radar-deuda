import type { Finding, ScoreResult } from './types.js';

/**
 * Puntuación de mantenibilidad basada en el modelo SQALE (el mismo principio
 * que usa SonarQube):
 *
 *   ratio de deuda = minutos de corrección estimados / coste de desarrollo
 *   coste de desarrollo = líneas de código no vacías × 30 min
 *
 * Calificación: A ≤ 5 %, B ≤ 10 %, C ≤ 20 %, D ≤ 50 %, E > 50 %.
 * Puntuación 0–100 = 100 × (1 − ratio / 0,5), acotada. Así A ⇔ ≥ 90,
 * B ⇔ ≥ 80, C ⇔ ≥ 60, D ⇔ ≥ 0.
 *
 * Los hallazgos de severidad `info` no suman esfuerzo: son contexto, no deuda.
 */
export const MINUTES_PER_LINE = 30;

export function computeScore(findings: readonly Finding[], codeLines: number): ScoreResult {
  const remediationMinutes = findings
    .filter((f) => f.severity !== 'info')
    .reduce((sum, f) => sum + f.effort.minutes, 0);
  const developmentMinutes = Math.max(codeLines, 1) * MINUTES_PER_LINE;
  const debtRatio = remediationMinutes / developmentMinutes;
  const rating = debtRatio <= 0.05 ? 'A' : debtRatio <= 0.1 ? 'B' : debtRatio <= 0.2 ? 'C' : debtRatio <= 0.5 ? 'D' : 'E';
  const score = Math.round(Math.max(0, Math.min(100, 100 * (1 - debtRatio / 0.5))));
  return {
    score,
    rating,
    debtRatio: Number(debtRatio.toFixed(4)),
    remediationMinutes: Math.round(remediationMinutes),
    developmentMinutes,
    codeLines,
  };
}
