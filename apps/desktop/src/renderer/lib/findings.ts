import { SEVERITY_ORDER, type Category, type Finding, type Severity } from '@radar/engine';
import { fold } from './format.js';

export interface FindingFilter {
  severities: ReadonlySet<Severity>;
  /** Vacío: todas. */
  categories: ReadonlySet<Category>;
  text: string;
  /** Solo hallazgos con alguna ubicación en este archivo o carpeta. */
  path: string | null;
  /** Solo la deuda nueva respecto al análisis anterior. */
  onlyNew: boolean;
}

export type FindingSort = 'severity' | 'effort' | 'file';

export const ALL_SEVERITIES: ReadonlySet<Severity> = new Set(['critical', 'high', 'medium', 'low', 'info']);
export const EMPTY_FILTER: FindingFilter = { severities: ALL_SEVERITIES, categories: new Set(), text: '', path: null, onlyNew: false };

function inPath(file: string, path: string): boolean {
  return file === path || file.startsWith(path.endsWith('/') ? path : `${path}/`);
}

/** `newIds`: hallazgos nuevos respecto al análisis anterior (sin él, «solo nuevos» no filtra). */
export function filterFindings(findings: readonly Finding[], f: FindingFilter, newIds?: ReadonlySet<string>): Finding[] {
  const terms = fold(f.text).split(/\s+/).filter(Boolean);
  return findings.filter((x) => {
    if (!f.severities.has(x.severity)) return false;
    if (f.onlyNew && newIds && !newIds.has(x.id)) return false;
    if (f.categories.size > 0 && !f.categories.has(x.category)) return false;
    if (f.path !== null && !x.locations.some((l) => inPath(l.file, f.path as string))) return false;
    if (terms.length === 0) return true;
    const hay = fold([x.title, x.message, x.ruleId, ...x.locations.map((l) => `${l.file} ${l.symbol ?? ''}`)].join(' '));
    return terms.every((t) => hay.includes(t));
  });
}

export function sortFindings(findings: readonly Finding[], sort: FindingSort): Finding[] {
  const file = (x: Finding) => x.locations[0]?.file ?? '';
  const line = (x: Finding) => x.locations[0]?.startLine ?? 0;
  const bySeverity = (a: Finding, b: Finding) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
  return [...findings].sort((a, b) => {
    if (sort === 'effort') return b.effort.minutes - a.effort.minutes || bySeverity(a, b) || a.id.localeCompare(b.id);
    if (sort === 'file') return file(a).localeCompare(file(b)) || line(a) - line(b) || bySeverity(a, b);
    return bySeverity(a, b) || b.effort.minutes - a.effort.minutes || file(a).localeCompare(file(b)) || a.id.localeCompare(b.id);
  });
}

/** Cuántos hallazgos hay de cada severidad (para los botones de filtro). */
export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const c: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}
