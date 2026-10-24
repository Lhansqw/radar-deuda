import type { FileAnalyzer, Finding, Location } from '../types.js';
import { findingId } from '../util.js';

const ID = 'markers';
const VERSION = '1.0.0';
const TOOL = `${ID}@${VERSION}`;

/** Marcador dentro de un comentario (// # /* * <!-- --). */
const MARKER = /(?:\/\/|#|\/\*|^\s*\*|<!--|--)\s*(TODO|FIXME|HACK|XXX)\b[:\s(]?(.*)$/;

export interface MarkerMatch {
  tag: 'TODO' | 'FIXME' | 'HACK' | 'XXX';
  line: number;
  text: string;
}

export function scanMarkers(lines: readonly string[]): MarkerMatch[] {
  const out: MarkerMatch[] = [];
  lines.forEach((line, i) => {
    if (line.length > 1000) return;
    const m = MARKER.exec(line);
    if (m) out.push({ tag: m[1] as MarkerMatch['tag'], line: i + 1, text: (m[2] ?? '').trim().slice(0, 120) });
  });
  return out;
}

/** Un hallazgo por archivo, no por marcador: evita inundar el panel. */
export const markersAnalyzer: FileAnalyzer = {
  id: ID,
  version: VERSION,
  description: 'Marcadores de deuda reconocida por el equipo (TODO, FIXME, HACK, XXX).',
  supports: (meta) => meta.isCode,
  analyze(input) {
    const markers = scanMarkers(input.lines);
    if (markers.length === 0) return { findings: [] };
    const serious = markers.filter((m) => m.tag !== 'TODO');
    const counts = markers.reduce<Record<string, number>>((acc, m) => ((acc[m.tag] = (acc[m.tag] ?? 0) + 1), acc), {});
    const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
    const locations: Location[] = markers.slice(0, 25).map((m) => ({ file: input.meta.relPath, startLine: m.line, endLine: m.line, symbol: m.tag }));
    const finding: Finding = {
      id: findingId('maintainability/markers', input.meta.relPath, 'markers'),
      ruleId: 'maintainability/markers',
      category: 'maintainability',
      severity: serious.length > 0 ? 'low' : 'info',
      confidence: 'medium',
      title: `Deuda marcada explícitamente (${summary})`,
      message: `El archivo contiene ${markers.length} marcador(es) de trabajo pendiente: ${summary}.`,
      locations,
      evidence: markers.slice(0, 10).map((m) => ({ kind: 'match' as const, tool: TOOL, description: `${m.tag} en línea ${m.line}`, snippet: m.text })),
      impact: 'Los marcadores indican deuda conocida pero no planificada; FIXME y HACK suelen señalar soluciones provisionales.',
      effort: {
        minutes: serious.length * 30 + (markers.length - serious.length) * 10,
        rationale: 'Estimación por defecto (30 min por FIXME/HACK/XXX, 10 min por TODO): el marcador no describe el alcance real.',
      },
    };
    return { findings: [finding] };
  },
};
