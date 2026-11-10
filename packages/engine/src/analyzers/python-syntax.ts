import { tokenizePython, type PyLine, type PyToken } from './python-lexer.js';

/**
 * Árbol de sentencias de Python a partir de las líneas lógicas y su sangría.
 * No es un parser completo: reconoce las sentencias compuestas (`if`, `for`,
 * `def`…) y su bloque, que es lo que necesitan la complejidad y las
 * importaciones.
 */

export type PyKeyword = 'if' | 'elif' | 'else' | 'for' | 'while' | 'try' | 'except' | 'finally' | 'with' | 'def' | 'class' | 'match' | 'case';

export interface PyStatement {
  /** null en una sentencia simple. */
  keyword: PyKeyword | null;
  line: PyLine;
  /** Compuesta: lo que hay entre la palabra clave y los dos puntos. Simple: toda la sentencia. */
  header: PyToken[];
  body: PyStatement[];
  /** Última línea de la sentencia, con su bloque. */
  endLine: number;
}

const COMPOUND = new Set<string>(['if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with', 'def', 'class']);
const SOFT = new Set<string>(['match', 'case']);
/** Tras `match` o `case` como nombre normal (`match = …`, `match.group()`, `match: int`). */
const NOT_SOFT_KEYWORD = new Set<string>(['=', '.', ':', ',', ')', ']', '}', ':=', '+=', '-=', '*=', '/=', '%=', '|=', '&=', '^=']);

function keywordOf(tokens: readonly PyToken[]): { keyword: PyKeyword; at: number } | null {
  let at = 0;
  if (tokens[0]?.type === 'name' && tokens[0].value === 'async') at = 1;
  const t = tokens[at];
  if (t?.type !== 'name') return null;
  if (COMPOUND.has(t.value)) return { keyword: t.value as PyKeyword, at };
  if (at === 0 && SOFT.has(t.value)) {
    const next = tokens[1];
    if (next && !(next.type === 'op' && NOT_SOFT_KEYWORD.has(next.value))) return { keyword: t.value as PyKeyword, at };
  }
  return null;
}

function makeStatement(line: PyLine): { stmt: PyStatement; inline: PyToken[] | null } {
  const tokens = line.tokens;
  const kw = keywordOf(tokens);
  if (kw) {
    const depth = tokens[0]?.depth ?? 0;
    const colon = tokens.findIndex((t, i) => i > kw.at && t.type === 'op' && t.value === ':' && t.depth === depth);
    if (colon >= 0) {
      const stmt: PyStatement = { keyword: kw.keyword, line, header: tokens.slice(kw.at + 1, colon), body: [], endLine: line.endLine };
      const rest = tokens.slice(colon + 1);
      return { stmt, inline: rest.length > 0 ? rest : null };
    }
  }
  return { stmt: { keyword: null, line, header: tokens, body: [], endLine: line.endLine }, inline: null };
}

function parseBlock(lines: readonly PyLine[], start: number, parentIndent: number): [PyStatement[], number] {
  const out: PyStatement[] = [];
  let i = start;
  while (i < lines.length && (lines[i] as PyLine).indent > parentIndent) {
    const line = lines[i] as PyLine;
    const { stmt, inline } = makeStatement(line);
    i++;
    if (stmt.keyword !== null) {
      if (inline) {
        // `if x: return y`: el cuerpo va en la misma línea.
        stmt.body = [{ keyword: null, line, header: inline, body: [], endLine: line.endLine }];
      } else {
        const [body, next] = parseBlock(lines, i, line.indent);
        stmt.body = body;
        i = next;
      }
      const last = stmt.body[stmt.body.length - 1];
      if (last) stmt.endLine = Math.max(stmt.endLine, last.endLine);
    }
    out.push(stmt);
  }
  return [out, i];
}

export function parsePython(text: string): PyStatement[] {
  return parseLines(tokenizePython(text).lines);
}

export function parseLines(lines: readonly PyLine[]): PyStatement[] {
  // Si una línea tiene menos sangría que la primera, el bloque superior sigue con ella.
  const out: PyStatement[] = [];
  let i = 0;
  while (i < lines.length) {
    const [stmts, next] = parseBlock(lines, i, (lines[i] as PyLine).indent - 1);
    out.push(...stmts);
    i = next;
  }
  return out;
}

/** Separa una sentencia simple por los `;` de su nivel. */
export function splitSimple(tokens: readonly PyToken[]): PyToken[][] {
  const depth = tokens[0]?.depth ?? 0;
  const parts: PyToken[][] = [[]];
  for (const t of tokens) {
    if (t.type === 'op' && t.value === ';' && t.depth === depth) parts.push([]);
    else (parts[parts.length - 1] as PyToken[]).push(t);
  }
  return parts.filter((p) => p.length > 0);
}

export const isName = (t: PyToken | undefined, value: string): boolean => t?.type === 'name' && t.value === value;
export const isOp = (t: PyToken | undefined, value: string): boolean => t?.type === 'op' && t.value === value;
