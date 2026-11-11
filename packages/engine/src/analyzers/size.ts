import { SPANISH, translator, type Translate } from '../i18n.js';
import type { FileAnalyzer, Finding, Thresholds } from '../types.js';
import { countNonBlankLines, findingId } from '../util.js';
import { severityByRatio } from './shared.js';

const ID = 'size';
const VERSION = '1.0.0';
const TOOL = `${ID}@${VERSION}`;

/**
 * @param codeLines líneas con contenido (la métrica)
 * @param totalLines líneas físicas del archivo (para que la ubicación cubra el archivo entero)
 * @param tr idioma de los textos
 */
export function largeFileFinding(file: string, codeLines: number, totalLines: number, t: Thresholds, note?: string, tr: Translate = SPANISH): Finding | null {
  if (codeLines <= t.fileLines) return null;
  const minutes = Math.min(960, Math.round(30 + (codeLines - t.fileLines) * 0.2));
  return {
    id: findingId('size/large-file', file, 'file'),
    ruleId: 'size/large-file',
    category: 'size',
    severity: severityByRatio(codeLines, t.fileLines),
    confidence: 'high',
    title: tr(`Archivo demasiado grande (${codeLines} líneas)`, `File too large (${codeLines} lines)`),
    message:
      tr(
        `El archivo tiene ${codeLines} líneas con contenido (umbral ${t.fileLines}). Suele indicar un módulo con demasiadas responsabilidades.`,
        `The file has ${codeLines} non-blank lines (threshold ${t.fileLines}). It usually points to a module with too many responsibilities.`,
      ) + (note ? ` ${note}` : ''),
    locations: [{ file, startLine: 1, endLine: Math.max(totalLines, 1) }],
    evidence: [{ kind: 'metric', tool: TOOL, description: tr('Líneas no vacías del archivo', 'Non-blank lines in the file'), metric: { name: 'codeLines', value: codeLines, threshold: t.fileLines, unit: tr('líneas', 'lines') } }],
    impact: tr('Archivos grandes concentran cambios, provocan conflictos de fusión y son difíciles de revisar y probar.', 'Large files concentrate changes, cause merge conflicts and are hard to review and test.'),
    effort: { minutes, rationale: tr('30 min base + 0,2 min por línea sobre el umbral para dividir el módulo (máx. 16 h).', '30 min base + 0.2 min per line over the threshold to split the module (max. 16 h).') },
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
    const f = largeFileFinding(input.meta.relPath, codeLines, input.lines.length, config.thresholds, undefined, translator(config.locale));
    return { findings: f ? [f] : [], artifact: { codeLines } };
  },
};
