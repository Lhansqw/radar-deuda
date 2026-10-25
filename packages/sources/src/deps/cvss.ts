import type { Severity } from '@radar/engine';

/**
 * Puntuación base CVSS v3.0/v3.1 a partir del vector, según la especificación
 * de FIRST (sección 7, "CVSS v3.1 Equations"). Se usa cuando la base de
 * datos de vulnerabilidades no trae una severidad propia.
 */

const AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC: Record<string, number> = { L: 0.77, H: 0.44 };
const UI: Record<string, number> = { N: 0.85, R: 0.62 };
const CIA: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };

/** Redondeo hacia arriba a un decimal tal como lo define CVSS v3.1 (Apéndice A). */
export function roundUp(value: number): number {
  const int = Math.round(value * 100_000);
  return int % 10_000 === 0 ? int / 100_000 : (Math.floor(int / 10_000) + 1) / 10;
}

export function cvss3BaseScore(vector: string): number | null {
  if (!/^CVSS:3\.[01]\//.test(vector)) return null;
  const m = new Map<string, string>();
  for (const part of vector.split('/').slice(1)) {
    const [k, v] = part.split(':');
    if (k && v) m.set(k, v);
  }
  const scope = m.get('S');
  const av = AV[m.get('AV') ?? ''];
  const ac = AC[m.get('AC') ?? ''];
  const ui = UI[m.get('UI') ?? ''];
  const c = CIA[m.get('C') ?? ''];
  const i = CIA[m.get('I') ?? ''];
  const a = CIA[m.get('A') ?? ''];
  const prKey = m.get('PR');
  const pr = prKey === 'N' ? 0.85 : prKey === 'L' ? (scope === 'C' ? 0.68 : 0.62) : prKey === 'H' ? (scope === 'C' ? 0.5 : 0.27) : undefined;
  if ((scope !== 'U' && scope !== 'C') || av === undefined || ac === undefined || ui === undefined || pr === undefined || c === undefined || i === undefined || a === undefined) {
    return null;
  }
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = scope === 'U' ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15;
  const exploitability = 8.22 * av * ac * pr * ui;
  if (impact <= 0) return 0;
  return scope === 'U' ? roundUp(Math.min(impact + exploitability, 10)) : roundUp(Math.min(1.08 * (impact + exploitability), 10));
}

/** Escala cualitativa de CVSS v3: ninguna, baja, media, alta, crítica. */
export function severityFromScore(score: number): Severity {
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  if (score > 0) return 'low';
  return 'info';
}
