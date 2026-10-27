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

/** Métricas base ya convertidas a sus pesos numéricos. */
interface BaseMetrics {
  /** Alcance: sin cambio (U) o con cambio (C). */
  scope: 'U' | 'C';
  av: number;
  ac: number;
  pr: number;
  ui: number;
  c: number;
  i: number;
  a: number;
}

/** Métricas del vector «CVSS:3.1/AV:N/AC:L/…» (las que no son base se ignoran). */
function parseVector(vector: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of vector.split('/').slice(1)) {
    const [k, v] = part.split(':');
    if (k && v) m.set(k, v);
  }
  return m;
}

/** El peso de los privilegios requeridos depende del alcance. */
function privilegesRequired(value: string | undefined, scope: 'U' | 'C'): number | undefined {
  if (value === 'N') return 0.85;
  if (value === 'L') return scope === 'C' ? 0.68 : 0.62;
  if (value === 'H') return scope === 'C' ? 0.5 : 0.27;
  return undefined;
}

/** Las ocho métricas base o null si falta alguna o tiene un valor desconocido. */
function baseMetrics(m: ReadonlyMap<string, string>): BaseMetrics | null {
  const scope = m.get('S');
  if (scope !== 'U' && scope !== 'C') return null;
  const values = {
    scope,
    av: AV[m.get('AV') ?? ''],
    ac: AC[m.get('AC') ?? ''],
    pr: privilegesRequired(m.get('PR'), scope),
    ui: UI[m.get('UI') ?? ''],
    c: CIA[m.get('C') ?? ''],
    i: CIA[m.get('I') ?? ''],
    a: CIA[m.get('A') ?? ''],
  };
  return Object.values(values).every((v) => v !== undefined) ? (values as BaseMetrics) : null;
}

export function cvss3BaseScore(vector: string): number | null {
  if (!/^CVSS:3\.[01]\//.test(vector)) return null;
  const b = baseMetrics(parseVector(vector));
  if (!b) return null;
  const iss = 1 - (1 - b.c) * (1 - b.i) * (1 - b.a);
  const impact = b.scope === 'U' ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * b.av * b.ac * b.pr * b.ui;
  const base = b.scope === 'U' ? impact + exploitability : 1.08 * (impact + exploitability);
  return roundUp(Math.min(base, 10));
}

/** Escala cualitativa de CVSS v3: ninguna, baja, media, alta, crítica. */
export function severityFromScore(score: number): Severity {
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  if (score > 0) return 'low';
  return 'info';
}
