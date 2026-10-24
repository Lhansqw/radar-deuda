import { createHash } from 'node:crypto';
import { SEVERITY_ORDER, type Finding } from './types.js';

export function sha1(input: string | Buffer): string {
  return createHash('sha1').update(input).digest('hex');
}

/** Identificador estable de un hallazgo: no depende del número de línea cuando hay un ancla mejor. */
export function findingId(ruleId: string, file: string, anchor: string): string {
  return sha1(`${ruleId}\u0000${file}\u0000${anchor}`).slice(0, 16);
}

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Líneas con contenido (no vacías). Se usa como medida de tamaño del código. */
export function countNonBlankLines(lines: readonly string[]): number {
  let n = 0;
  for (const line of lines) if (line.trim().length > 0) n++;
  return n;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Ejecuta `worker` sobre `items` con un máximo de `limit` tareas simultáneas. */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  const runners: Promise<void>[] = [];
  const run = async (): Promise<void> => {
    while (next < items.length) {
      signal?.throwIfAborted();
      const index = next++;
      await worker(items[index] as T, index);
    }
  };
  for (let i = 0; i < Math.min(limit, items.length); i++) runners.push(run());
  await Promise.all(runners);
}

export function sortFindings(findings: Finding[]): Finding[] {
  return findings.sort(
    (a, b) =>
      SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] ||
      (a.locations[0]?.file ?? '').localeCompare(b.locations[0]?.file ?? '') ||
      (a.locations[0]?.startLine ?? 0) - (b.locations[0]?.startLine ?? 0) ||
      a.ruleId.localeCompare(b.ruleId),
  );
}

/** Convierte una ruta del sistema a ruta relativa con `/` (estable en Windows y Unix). */
export function toPosix(p: string): string {
  return p.split('\\').join('/');
}

/** Posiciones de inicio de cada línea (acepta \n, \r\n y \r). */
export function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    } else if (c === 10) {
      starts.push(i + 1);
    }
  }
  return starts;
}

/** Línea (base 1) de una posición, por búsqueda binaria sobre `lineStarts`. */
export function lineAt(lineStarts: readonly number[], pos: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((lineStarts[mid] as number) <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
