import { gunzipSync, gzipSync } from 'node:zlib';
import { parseReport, type AnalysisReport, type Evidence } from '@radar/engine';

/** Tamaño máximo de un informe descomprimido que se acepta de la nube (contra «bombas» de compresión). */
const MAX_REPORT_BYTES = 256 * 1024 * 1024;

/**
 * El informe tal como sube a la nube: los resultados de las herramientas sin
 * los fragmentos de código de la evidencia (comentarios TODO, versiones de
 * dependencias, el principio redactado de un secreto) y sin lo que añade la IA
 * (que puede citar código si se usó la privacidad «fragmentos»). Ubicaciones,
 * métricas, mensajes y puntuación se conservan: con ellos se ve el análisis en
 * otro equipo.
 */
export function cloudReport(report: AnalysisReport): AnalysisReport {
  const clean: AnalysisReport = { ...report, findings: report.findings.map((f) => ({ ...f, evidence: f.evidence.map(withoutSnippet) })) };
  delete clean.ai;
  return clean;
}

function withoutSnippet(e: Evidence): Evidence {
  const copy = { ...e };
  delete copy.snippet;
  return copy;
}

/** Informe para la columna report_gz: sin código, en JSON, gzip y base64. */
export function encodeCloudReport(report: AnalysisReport): string {
  return gzipSync(JSON.stringify(cloudReport(report))).toString('base64');
}

/** Lo contrario de encodeCloudReport, comprobando el formato del informe. */
export function decodeCloudReport(encoded: string): AnalysisReport {
  const json = gunzipSync(Buffer.from(encoded, 'base64'), { maxOutputLength: MAX_REPORT_BYTES }).toString('utf8');
  return parseReport(json);
}
