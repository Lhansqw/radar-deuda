import type { FileAnalyzer, Finding, Thresholds } from '../types.js';
import { countNonBlankLines, findingId } from '../util.js';
import { severityByRatio } from './shared.js';

const ID = 'size';
const VERSION = '1.0.0';
const TOOL = `${ID}@${VERSION}`;

/**
 * @param codeLines líneas con contenido (la métrica)
 * @param totalLines líneas físicas del archivo (para que la ubicación cubra el archivo entero)
 */
export function largeFileFinding(file: string, codeLines: number, totalLines: number, t: Thresholds, note?: string): Finding | null {
  if (codeLines <= t.fileLines) return null;
  const minutes = Math.min(960, Math.round(30 + (codeLines - t.fileLines) * 0.2));
  return {
    id: findingId('size/large-file', file, 'file'),
    ruleId: 'size/large-file',
    category: 'size',
    severity: severityByRatio(codeLines, t.fileLines),
    confidence: 'high',
    title: `Archivo demasiado grande (${codeLines} líneas)`,
    message: `El archivo tiene ${codeLines} líneas con contenido (umbral ${t.fileLines}). Suele indicar un módulo con demasiadas responsabilidades.${note ? ` ${note}` : ''}`,
    locations: [{ file, startLine: 1, endLine: Math.max(totalLines, 1) }],
    evidence: [{ kind: 'metric', tool: TOOL, description: 'Líneas no vacías del archivo', metric: { name: 'codeLines', value: codeLines, threshold: t.fileLines, unit: 'líneas' } }],
    impact: 'Archivos grandes concentran cambios, provocan conflictos de fusión y son difíciles de revisar y probar.',
    effort: { minutes, rationale: '30 min base + 0,2 min por línea sobre el umbral para dividir el módulo (máx. 16 h).' },
  };
}

export interface SizeArtifact {
  codeLines: number;
}

/** Su artefacto (líneas de código) alimenta también el cálculo de la puntuación. */
export const sizeAnalyzer: FileAnalyzer<SizeArtifact> = {
  id: ID,
  version: VERSION,
  description: 'Tamaño de archivo (líneas no vacías) para cualquier lenguaje.',
  supports: (meta) => meta.isCode,
  analyze(input, config) {
    const codeLines = countNonBlankLines(input.lines);
    const f = largeFileFinding(input.meta.relPath, codeLines, input.lines.length, config.thresholds);
    return { findings: f ? [f] : [], artifact: { codeLines } };
  },
};
