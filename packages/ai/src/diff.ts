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
  const { pre, suf } = commonEnds(a, b);
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  const middle = midA.length * midB.length > MAX_LCS_CELLS ? replaceAll(midA.length, midB.length) : align(midA, midB);
  const shift = (x: number | null): number | null => (x === null ? null : x + pre);
  return [
    ...Array.from({ length: pre }, (_, i): Op => ({ kind: 'context', a: i, b: i })),
    ...middle.map((o): Op => ({ kind: o.kind, a: shift(o.a), b: shift(o.b) })),
    ...Array.from({ length: suf }, (_, k): Op => ({ kind: 'context', a: a.length - suf + k, b: b.length - suf + k })),
  ];
}

/** Líneas iguales al principio y al final, sin que se solapen. */
function commonEnds(a: readonly string[], b: readonly string[]): { pre: number; suf: number } {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return { pre, suf };
}

/** Sin buscar alineación: todo lo viejo eliminado y todo lo nuevo añadido. */
function replaceAll(n: number, m: number): Op[] {
  return [
    ...Array.from({ length: n }, (_, i): Op => ({ kind: 'removed', a: i, b: null })),
    ...Array.from({ length: m }, (_, j): Op => ({ kind: 'added', a: null, b: j })),
  ];
}

/** Recorre la tabla de la subsecuencia común más larga de principio a fin. */
function align(a: readonly string[], b: readonly string[]): Op[] {
  const at = lcsTable(a, b);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: 'context', a: i++, b: j++ });
    } else if (j === b.length || (i < a.length && at(i + 1, j) >= at(i, j + 1))) {
      // Ante un empate, primero las eliminaciones: el bloque queda "- viejas / + nuevas".
      ops.push({ kind: 'removed', a: i++, b: null });
    } else {
      ops.push({ kind: 'added', a: null, b: j++ });
    }
  }
  return ops;
}

/** at(i, j): longitud de la subsecuencia común más larga de a[i..] y b[j..]. */
function lcsTable(a: readonly string[], b: readonly string[]): (i: number, j: number) => number {
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  const at = (i: number, j: number): number => lcs[i * w + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  return at;
}

/** Bloques con `context` líneas sin cambios alrededor de cada cambio; los cercanos se unen. */
export function buildHunks(file: string, before: TextLines, after: TextLines, context = 3): DiffHunk[] {
  // La última línea de un archivo sin salto final no es igual a la misma línea seguida de otras:
  // si deja de ser la última, el parche debe mostrarla como cambiada.
  const ops = diffOps(comparable(before), comparable(after));
  const hunks: DiffHunk[] = [];
  let k = ops.findIndex((o) => o.kind !== 'context');
  while (k !== -1) {
    const { start, stop } = hunkRange(ops, k, context);
    hunks.push(toHunk(file, ops, start, stop, before, after));
    const next = ops.slice(stop).findIndex((o) => o.kind !== 'context');
    k = next === -1 ? -1 : stop + next;
  }
  return hunks;
}

/**
 * Desde el cambio en `first`: el bloque sigue mientras no haya más de
 * 2·context líneas sin cambios seguidas, y lleva `context` líneas a cada lado.
 */
function hunkRange(ops: readonly Op[], first: number, context: number): { start: number; stop: number } {
  let end = first;
  let quiet = 0;
  for (let x = first; x < ops.length && quiet <= 2 * context; x++) {
    if (ops[x]?.kind === 'context') quiet++;
    else {
      quiet = 0;
      end = x;
    }
  }
  return { start: Math.max(0, first - context), stop: Math.min(ops.length, end + 1 + context) };
}

function toHunk(file: string, ops: readonly Op[], start: number, stop: number, before: TextLines, after: TextLines): DiffHunk {
  const slice = ops.slice(start, stop);
  const lines: DiffLine[] = slice.map((o) => ({
    kind: o.kind,
    text: o.a !== null ? (before.lines[o.a] ?? '') : (after.lines[o.b ?? 0] ?? ''),
    oldLine: o.a !== null ? o.a + 1 : null,
    newLine: o.b !== null ? o.b + 1 : null,
  }));
  const olds = slice.flatMap((o) => (o.a === null ? [] : [o.a]));
  const news = slice.flatMap((o) => (o.b === null ? [] : [o.b]));
  // Con 0 líneas, el inicio es la línea anterior al bloque (convención del formato unificado).
  const before0 = ops.slice(0, start);
  return {
    file,
    oldStart: olds[0] !== undefined ? olds[0] + 1 : before0.filter((o) => o.a !== null).length,
    oldLines: olds.length,
    newStart: news[0] !== undefined ? news[0] + 1 : before0.filter((o) => o.b !== null).length,
    newLines: news.length,
    lines,
  };
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
const PREFIX: Record<DiffLine['kind'], string> = { added: '+', removed: '-', context: ' ' };

/** Parche unificado que acepta `git apply` (rutas relativas a la raíz del repositorio). */
export function formatPatch(files: readonly FilePatch[]): string {
  const out = files.filter((f) => f.hunks.length > 0).flatMap(fileLines);
  return out.length > 0 ? `${out.join('\n')}\n` : '';
}

function fileLines(f: FilePatch): string[] {
  const out = [`diff --git a/${f.file} b/${f.file}`, `--- a/${f.file}`, `+++ b/${f.file}`];
  for (const h of f.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const l of h.lines) out.push(...patchLine(l, f));
  }
  return out;
}

/**
 * Una línea del parche con su \r si lo tenía y, si es la última del archivo y
 * no termina en salto de línea, la marca que lo indica. Las añadidas se miran
 * en la versión nueva; las demás, en la original.
 */
function patchLine(l: DiffLine, f: FilePatch): string[] {
  const [side, n] = l.kind === 'added' ? [f.after, l.newLine] : [f.before, l.oldLine];
  const line = `${PREFIX[l.kind]}${l.text}${side.crlf[(n ?? 1) - 1] ? '\r' : ''}`;
  return n === side.lines.length && !side.finalNewline ? [line, NO_NEWLINE] : [line];
}
