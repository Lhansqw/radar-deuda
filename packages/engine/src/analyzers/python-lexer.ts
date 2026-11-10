/**
 * Tokenizador de Python sin dependencias: lo justo para medir complejidad,
 * importaciones y duplicación sin ejecutar ni compilar el código.
 *
 * - Agrupa los tokens en líneas lógicas (una sentencia, aunque ocupe varias
 *   líneas físicas por paréntesis abiertos o por `\` al final de línea).
 * - Ignora comentarios y líneas en blanco; los strings (con prefijos, triples
 *   y f-strings con expresiones anidadas) son un único token.
 * - Cada token lleva la profundidad de paréntesis en la que aparece.
 * Tolera código mal formado: un string sin cerrar termina al final de la
 * línea y un paréntesis de cierre de más no baja de cero.
 */

export type PyTokenType = 'name' | 'number' | 'string' | 'op' | 'newline' | 'indent' | 'dedent';

export interface PyToken {
  type: PyTokenType;
  value: string;
  line: number;
  endLine: number;
  /** Profundidad de paréntesis, corchetes y llaves (la de la apertura para `(` y la de su cierre para `)`). */
  depth: number;
}

export interface PyLine {
  /** Columna de la sangría (un tabulador avanza hasta el siguiente múltiplo de 8). */
  indent: number;
  tokens: PyToken[];
  startLine: number;
  endLine: number;
}

export interface PyTokens {
  lines: PyLine[];
  /** Todos los tokens en orden, con `newline`, `indent` y `dedent` (para la duplicación). */
  stream: PyToken[];
}

const OPS3 = new Set(['**=', '//=', '>>=', '<<=', '...']);
const OPS2 = new Set(['**', '//', '<<', '>>', '<=', '>=', '==', '!=', '->', ':=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '@=']);
const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);
const STRING_PREFIX = /^(?:[rR]|[uU]|[bB]|[fF]|[tT]|[rR][bBfFtT]|[bBfFtT][rR])$/;
const NAME = /[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]*/uy;
const NUMBER = /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)[jJlL]?/y;

const isQuote = (c: string | undefined): boolean => c === '"' || c === "'";
const isNewline = (c: string | undefined): boolean => c === '\n' || c === '\r';

class Lexer {
  private i = 0;
  private line = 1;
  private depth = 0;
  private readonly lines: PyLine[] = [];
  private readonly stream: PyToken[] = [];
  private readonly indents: number[] = [0];
  private current: PyToken[] = [];
  private lineIndent = 0;

  constructor(private readonly text: string) {}

  run(): PyTokens {
    let atLineStart = true;
    while (this.i < this.text.length) {
      if (atLineStart && this.depth === 0 && !this.startLine()) continue;
      atLineStart = this.step(this.text[this.i] as string);
    }
    this.endLogicalLine();
    for (let k = this.indents.length - 1; k > 0; k--) this.stream.push({ type: 'dedent', value: '', line: this.line, endLine: this.line, depth: 0 });
    return { lines: this.lines, stream: this.stream };
  }

  /** Procesa lo que empieza en `c`; devuelve true si termina una línea lógica. */
  private step(c: string): boolean {
    if (c === ' ' || c === '\t' || c === '\f') this.i++;
    else if (c === '#') this.skipComment();
    else if (c === '\\' && isNewline(this.text[this.i + 1])) {
      this.i++;
      this.consumeNewline();
    } else if (isNewline(c)) {
      this.consumeNewline();
      if (this.depth > 0) return false;
      this.endLogicalLine();
      return true;
    } else this.token(c);
    return false;
  }

  /** Mide la sangría; en una línea en blanco o solo de comentario la salta y devuelve false. */
  private startLine(): boolean {
    let col = 0;
    for (let c = this.text[this.i]; c === ' ' || c === '\t' || c === '\f'; c = this.text[++this.i]) {
      col = c === ' ' ? col + 1 : c === '\t' ? Math.floor(col / 8) * 8 + 8 : 0;
    }
    const c = this.text[this.i];
    if (c === '#') this.skipComment();
    else if (isNewline(c)) this.consumeNewline();
    else if (c !== undefined) {
      this.lineIndent = col;
      return true;
    }
    return false;
  }

  private skipComment(): void {
    while (this.i < this.text.length && !isNewline(this.text[this.i])) this.i++;
  }

  private consumeNewline(): void {
    if (this.text[this.i] === '\r' && this.text[this.i + 1] === '\n') this.i++;
    this.i++;
    this.line++;
  }

  private push(type: PyTokenType, value: string, line: number, depth = this.depth): void {
    this.current.push({ type, value, line, endLine: this.line, depth });
  }

  private token(c: string): void {
    const start = this.i;
    const line = this.line;
    if (isQuote(c)) {
      this.scanString(start, '');
      this.push('string', this.text.slice(start, this.i), line);
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(this.text[start + 1] ?? ''))) {
      this.push('number', this.match(NUMBER, start), line);
    } else if (!this.nameOrString(start, line)) {
      this.operator(start, line);
    }
  }

  /** El texto de `re` en `start` (al menos un carácter) y avanza hasta su final. */
  private match(re: RegExp, start: number): string {
    re.lastIndex = start;
    this.i = start + (re.exec(this.text)?.[0].length ?? 1);
    return this.text.slice(start, this.i);
  }

  /** Un nombre, o un string con prefijo (`rb'…'`, `f"…"`); false si en `start` no empieza un nombre. */
  private nameOrString(start: number, line: number): boolean {
    NAME.lastIndex = start;
    const name = NAME.exec(this.text)?.[0];
    if (!name) return false;
    this.i = start + name.length;
    if (isQuote(this.text[this.i]) && STRING_PREFIX.test(name)) {
      this.scanString(this.i, name);
      this.push('string', this.text.slice(start, this.i), line);
    } else this.push('name', name, line);
    return true;
  }

  private operator(start: number, line: number): void {
    const three = this.text.slice(start, start + 3);
    const two = this.text.slice(start, start + 2);
    const op = OPS3.has(three) ? three : OPS2.has(two) ? two : (this.text[start] as string);
    this.i = start + op.length;
    if (CLOSERS.has(op)) this.depth = Math.max(0, this.depth - 1);
    this.push('op', op, line);
    if (OPENERS.has(op)) this.depth++;
  }

  /** Avanza `this.i` hasta después del string que empieza en `quoteAt` (las comillas). */
  private scanString(quoteAt: number, prefix: string): void {
    const t = this.text;
    const q = t[quoteAt] as string;
    const closing = t[quoteAt + 1] === q && t[quoteAt + 2] === q ? q.repeat(3) : q;
    const interpolated = /[fFtT]/.test(prefix);
    this.i = quoteAt + closing.length;
    while (this.i < t.length) {
      const c = t[this.i] as string;
      if (t.startsWith(closing, this.i)) {
        this.i += closing.length;
        return;
      }
      if (isNewline(c) && closing.length === 1) return; // sin cerrar: termina con la línea
      this.stringChar(c, interpolated);
    }
  }

  /** Un carácter (o escape, o campo `{…}` de un f-string) dentro de un string. */
  private stringChar(c: string, interpolated: boolean): void {
    if (c === '\\') {
      this.i++;
      if (isNewline(this.text[this.i])) this.consumeNewline();
      else this.i++;
    } else if (isNewline(c)) this.consumeNewline();
    else if (interpolated && c === '{' && this.text[this.i + 1] !== '{') this.scanReplacementField();
    else this.i += interpolated && c === '{' ? 2 : 1;
  }

  /** `{expresión!r:formato}` de un f-string: puede contener strings con las mismas comillas (Python 3.12). */
  private scanReplacementField(): void {
    let braces = 0;
    while (this.i < this.text.length) {
      const c = this.text[this.i] as string;
      if (isQuote(c)) this.nestedString();
      else if (isNewline(c)) this.consumeNewline();
      else {
        braces += c === '{' ? 1 : c === '}' ? -1 : 0;
        this.i++;
        if (braces === 0) return;
      }
    }
  }

  /** Un string dentro de un campo de f-string, con el prefijo que lo precede (ya recorrido). */
  private nestedString(): void {
    let p = this.i;
    while (p > 0 && /[a-zA-Z]/.test(this.text[p - 1] as string)) p--;
    const prefix = this.text.slice(p, this.i);
    this.scanString(this.i, STRING_PREFIX.test(prefix) ? prefix : '');
  }

  private endLogicalLine(): void {
    if (this.current.length === 0) return;
    const tokens = this.current;
    this.current = [];
    const first = tokens[0] as PyToken;
    const indent = this.lineIndent;
    if (indent > (this.indents[this.indents.length - 1] as number)) {
      this.indents.push(indent);
      this.stream.push({ type: 'indent', value: '', line: first.line, endLine: first.line, depth: 0 });
    } else {
      while (this.indents.length > 1 && indent < (this.indents[this.indents.length - 1] as number)) {
        this.indents.pop();
        this.stream.push({ type: 'dedent', value: '', line: first.line, endLine: first.line, depth: 0 });
      }
    }
    const last = tokens[tokens.length - 1] as PyToken;
    this.lines.push({ indent, tokens, startLine: first.line, endLine: last.endLine });
    this.stream.push(...tokens, { type: 'newline', value: '', line: last.endLine, endLine: last.endLine, depth: 0 });
  }
}

export function tokenizePython(text: string): PyTokens {
  return new Lexer(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).run();
}

export function isPythonPath(relPath: string): boolean {
  return /\.pyw?$/i.test(relPath);
}
