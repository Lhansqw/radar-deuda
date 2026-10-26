import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { safeJoin, scanSecrets, type AnalysisReport } from '@radar/engine';
import type { CodeSnippet } from '../shared/model.js';

/** Tamaño máximo de archivo que se abre para mostrar un fragmento. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Líneas máximas por petición. */
export const MAX_SNIPPET_LINES = 400;

export class SnippetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnippetError';
  }
}

/**
 * Ruta absoluta de un archivo de un análisis, solo si lo cita algún hallazgo
 * de ese análisis y queda dentro de la carpeta analizada sin pasar por
 * enlaces simbólicos. La interfaz no puede leer otros archivos del disco.
 */
export async function resolveReportFile(report: AnalysisReport, rel: string): Promise<string> {
  const cited = report.findings.some((f) => f.locations.some((l) => l.file === rel));
  if (!cited) throw new SnippetError('Ese archivo no aparece en los hallazgos de este análisis.');
  const abs = safeJoin(report.root, rel);
  if (!abs) throw new SnippetError('Ruta no válida.');
  const st = await lstat(abs).catch(() => null);
  if (!st) throw new SnippetError('El archivo ya no existe en la carpeta del proyecto.');
  if (st.isSymbolicLink() || !st.isFile()) throw new SnippetError('No se muestran enlaces simbólicos ni elementos que no son archivos.');
  const [realRoot, realFile] = await Promise.all([realpath(report.root), realpath(abs)]);
  const back = path.relative(realRoot, realFile);
  if (back.startsWith('..') || path.isAbsolute(back)) throw new SnippetError('El archivo está fuera de la carpeta del proyecto.');
  return abs;
}

/**
 * Líneas [start, end] de un archivo citado por el análisis. Los secretos se
 * ocultan con el mismo detector del motor: el fragmento puede mostrarse en
 * pantalla (o en una presentación) sin exponerlos.
 */
export async function readSnippet(report: AnalysisReport, rel: string, start: number, end: number): Promise<CodeSnippet> {
  const abs = await resolveReportFile(report, rel);
  const st = await lstat(abs);
  if (st.size > MAX_FILE_BYTES) throw new SnippetError(`El archivo ocupa ${Math.round(st.size / 1024 / 1024)} MB; no se muestra.`);
  const text = await readFile(abs, 'utf8');
  if (text.includes('\0')) throw new SnippetError('El archivo parece binario; no se muestra.');
  const all = text.split(/\r?\n/);
  const from = Math.max(1, Math.min(start, all.length));
  const to = Math.min(all.length, Math.max(from, end), from + MAX_SNIPPET_LINES - 1);
  const lines = all.slice(from - 1, to);
  const secrets = scanSecrets(all, rel).filter((m) => m.line >= from && m.line <= to);
  for (const m of secrets) {
    // m.redacted es la línea con el valor sustituido, sin la sangría: se conserva la original.
    const original = lines[m.line - from] ?? '';
    lines[m.line - from] = `${/^\s*/.exec(original)?.[0] ?? ''}${m.redacted}`;
  }
  return {
    file: rel,
    startLine: from,
    endLine: to,
    totalLines: all.length,
    lines,
    redactedLines: secrets.map((m) => m.line),
    changedSinceAnalysis: st.mtimeMs > Date.parse(report.generatedAt),
  };
}
