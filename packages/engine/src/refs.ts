import { SEVERITY_ORDER, type Finding } from './types.js';

/**
 * Referencia corta y estable de cada hallazgo de un informe (H1 es el más
 * grave): la usan la salida de la CLI, las preguntas a la IA y la
 * aplicación. Más fácil de escribir y de citar que el identificador largo.
 * Orden: severidad, esfuerzo y, a igualdad, el identificador.
 */
export function findingRefs(findings: readonly Finding[]): Map<string, string> {
  const ordered = [...findings].sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || b.effort.minutes - a.effort.minutes || a.id.localeCompare(b.id));
  return new Map(ordered.map((f, i) => [f.id, `H${i + 1}`]));
}

/**
 * Hallazgo indicado por su referencia corta (H3, sin distinguir mayúsculas),
 * su identificador o un prefijo de al menos 6 caracteres que no sea ambiguo.
 */
export function findFindingByRef(findings: readonly Finding[], ref: string): Finding | null {
  const r = ref.trim();
  if (/^h\d+$/i.test(r)) {
    const want = r.toUpperCase();
    const id = [...findingRefs(findings)].find(([, alias]) => alias === want)?.[0];
    return findings.find((f) => f.id === id) ?? null;
  }
  const exact = findings.find((f) => f.id === r);
  if (exact) return exact;
  if (r.length < 6) return null;
  const matches = findings.filter((f) => f.id.startsWith(r));
  return matches.length === 1 ? (matches[0] ?? null) : null;
}
