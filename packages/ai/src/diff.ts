import type { DiffHunk, DiffLine } from '@radar/engine';

/**
 * Diferencias de líneas deterministas para las propuestas de corrección. La
 * IA nunca escribe el parche: propone qué líneas sustituir y por qué texto, y
 * aquí se calcula la diferencia y el parche (compatible con `git apply`)
 * contra el archivo real. Así un parche mal formado o con números de línea
 * inventados no puede llegar al usuario.
 */

/** Texto de un archivo por líneas, conservando el final de cada una. */
export interface TextLines {
  lines: string[];
  /** La línea i terminaba en \r\n (se conserva al generar el parche). */
  crlf: boolean[];
  /** El archivo termina con un salto de línea. */
  finalNewline: boolean;
}

/** Misma numeración que el contexto enviado a la IA (\r\n, \r y \n separan líneas). */
export function splitLines(text: string): TextLines {
  if (text === '') return { lines: [], crlf: [], finalNewline: false };
  const parts = text.split(/(\r\n|\r|\n)/);
  const lines: string[] = [];
  const crlf: boolean[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const sep = parts[i + 1];
    // Tras el último salto de línea queda una cadena vacía que no es una línea.
    if (sep === undefined && parts[i] === '' && i > 0) break;
    lines.push(parts[i] ?? '');
    crlf.push(sep === '\r\n');
  }
  return { lines, crlf, finalNewline: /(?:\r\n|\r|\n)$/.test(text) };
}

export function joinLines(t: TextLines): string {
  return t.lines.map((l, i) => l + (i < t.lines.length - 1 || t.finalNewline ? (t.crlf[i] ? '\r\n' : '\n') : '')).join('');
}

/** Sustituye las líneas startLine..endLine (desde 1, ambas incluidas) por `replacement`. */
export interface LineEdit {
  startLine: number;
  endLine: number;
  replacement: string;
}

export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditError';
  }
}

/**
 * Aplica sustituciones que no se solapan. Las líneas nuevas usan el final de
 * línea predominante del archivo; las que no cambian conservan el suyo.
 */
export function applyEdits(src: TextLines, edits: readonly LineEdit[]): TextLines {
  const sorted = [...edits].sort((a, b) => a.startLine - b.startLine);
  const dominantCrlf = src.crlf.filter(Boolean).length * 2 > src.crlf.length;
  const lines: string[] = [];
  const crlf: boolean[] = [];
  let next = 1;
  for (const e of sorted) {
    if (!Number.isInteger(e.startLine) || !Number.isInteger(e.endLine) || e.startLine < 1 || e.endLine < e.startLine || e.endLine > src.lines.length) {
      throw new EditError(`Rango de líneas no válido: ${e.startLine}-${e.endLine} (el archivo tiene ${src.lines.length}).`);
    }
    if (e.startLine < next) throw new EditError(`Los cambios en las líneas ${e.startLine}-${e.endLine} se solapan con otro cambio.`);
    for (let n = next; n < e.startLine; n++) {
      lines.push(src.lines[n - 1] ?? '');
      crlf.push(src.crlf[n - 1] ?? false);
    }
    for (const l of e.replacement === '' ? [] : splitLines(e.replacement).lines) {
      lines.push(l);
      crlf.push(dominantCrlf);
    }
    next = e.endLine + 1;
  }
  for (let n = next; n <= src.lines.length; n++) {
    lines.push(src.lines[n - 1] ?? '');
    crlf.push(src.crlf[n - 1] ?? false);
  }
  return { lines, crlf, finalNewline: src.finalNewline || (src.lines.length === 0 && lines.length > 0) };
}

interface Op {
  kind: DiffLine['kind'];
  /** Índices desde 0 en la versión original y en la nueva. */
  a: number | null;
  b: number | null;
}

/** Por encima de este tamaño (líneas distintas × líneas distintas) no se busca la alineación óptima. */
const MAX_LCS_CELLS = 4_000_000;

/**
 * Operaciones mínimas (subsecuencia común más larga) para pasar de `a` a `b`.
 * Primero se descartan el principio y el final comunes: una propuesta toca
 * pocas líneas, así que la parte que se compara de verdad es pequeña.
 */
export function diffOps(a: readonly string[], b: readonly string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ kind: 'context', a: i, b: i });

  if (n * m > MAX_LCS_CELLS || n === 0 || m === 0) {
    for (let i = 0; i < n; i++) ops.push({ kind: 'removed', a: pre + i, b: null });
    for (let j = 0; j < m; j++) ops.push({ kind: 'added', a: null, b: pre + j });
  } else {
    // lcs[i][j]: longitud de la subsecuencia común de a[pre+i..] y b[pre+j..].
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = a[pre + i] === b[pre + j] ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1 : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[pre + i] === b[pre + j]) {
        ops.push({ kind: 'context', a: pre + i++, b: pre + j++ });
      } else if (j === m || (i < n && (lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0))) {
        // Ante un empate, primero las eliminaciones: el bloque queda "- viejas / + nuevas".
        ops.push({ kind: 'removed', a: pre + i++, b: null });
      } else {
        ops.push({ kind: 'added', a: null, b: pre + j++ });
      }
    }
  }
  for (let k = 0; k < suf; k++) ops.push({ kind: 'context', a: a.length - suf + k, b: b.length - suf + k });
  return ops;
}

/** Bloques con `context` líneas sin cambios alrededor de cada cambio; los cercanos se unen. */
export function buildHunks(file: string, before: TextLines, after: TextLines, context = 3): DiffHunk[] {
  // La última línea de un archivo sin salto final no es igual a la misma línea seguida de otras:
  // si deja de ser la última, el parche debe mostrarla como cambiada.
  const ops = diffOps(comparable(before), comparable(after));
  const hunks: DiffHunk[] = [];
  let k = 0;
  while (k < ops.length) {
    while (k < ops.length && ops[k]?.kind === 'context') k++;
    if (k >= ops.length) break;
    const start = Math.max(0, k - context);
    // Fin del bloque: el cambio sigue mientras no haya más de 2·context líneas sin cambios seguidas.
    let end = k;
    let quiet = 0;
    for (let x = k; x < ops.length; x++) {
      if (ops[x]?.kind === 'context') {
        if (++quiet > 2 * context) break;
      } else {
        quiet = 0;
        end = x;
      }
    }
    const stop = Math.min(ops.length, end + 1 + context);
    const slice = ops.slice(start, stop);
    const lines: DiffLine[] = slice.map((o) => ({
      kind: o.kind,
      text: o.a !== null ? (before.lines[o.a] ?? '') : (after.lines[o.b ?? 0] ?? ''),
      oldLine: o.a !== null ? o.a + 1 : null,
      newLine: o.b !== null ? o.b + 1 : null,
    }));
    const oldLines = slice.filter((o) => o.a !== null).length;
    const newLines = slice.filter((o) => o.b !== null).length;
    // Con 0 líneas, el inicio es la línea anterior al bloque (convención del formato unificado).
    const firstOld = slice.find((o) => o.a !== null)?.a;
    const firstNew = slice.find((o) => o.b !== null)?.b;
    const prevOld = ops.slice(0, start).filter((o) => o.a !== null).length;
    const prevNew = ops.slice(0, start).filter((o) => o.b !== null).length;
    hunks.push({
      file,
      oldStart: firstOld !== undefined && firstOld !== null ? firstOld + 1 : prevOld,
      oldLines,
      newStart: firstNew !== undefined && firstNew !== null ? firstNew + 1 : prevNew,
      newLines,
      lines,
    });
    k = stop;
  }
  return hunks;
}

function comparable(t: TextLines): string[] {
  if (t.finalNewline || t.lines.length === 0) return t.lines;
  return [...t.lines.slice(0, -1), `${t.lines.at(-1) ?? ''}\u0000sin-salto-final`];
}

export interface FilePatch {
  file: string;
  before: TextLines;
  after: TextLines;
  hunks: DiffHunk[];
}

const NO_NEWLINE = '\\ No newline at end of file';

/** Parche unificado que acepta `git apply` (rutas relativas a la raíz del repositorio). */
export function formatPatch(files: readonly FilePatch[]): string {
  const out: string[] = [];
  for (const f of files) {
    if (f.hunks.length === 0) continue;
    out.push(`diff --git a/${f.file} b/${f.file}`, `--- a/${f.file}`, `+++ b/${f.file}`);
    for (const h of f.hunks) {
      out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
      for (const l of h.lines) {
        const cr = l.kind === 'added' ? f.after.crlf[(l.newLine ?? 1) - 1] : f.before.crlf[(l.oldLine ?? 1) - 1];
        out.push(`${l.kind === 'added' ? '+' : l.kind === 'removed' ? '-' : ' '}${l.text}${cr ? '\r' : ''}`);
        const lastOld = l.oldLine === f.before.lines.length && !f.before.finalNewline;
        const lastNew = l.newLine === f.after.lines.length && !f.after.finalNewline;
        if ((l.kind !== 'added' && lastOld) || (l.kind === 'added' && lastNew)) out.push(NO_NEWLINE);
      }
    }
  }
  return out.length > 0 ? `${out.join('\n')}\n` : '';
}
