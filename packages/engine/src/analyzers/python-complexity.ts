import type { FileAnalyzer, Finding } from '../types.js';
import { buildFunctionFinding, type FunctionMetrics } from './complexity.js';
import type { PyToken } from './python-lexer.js';
import { isName, isOp, parsePython, type PyKeyword, type PyStatement } from './python-syntax.js';

/**
 * Complejidad de las funciones de Python con las mismas métricas y umbrales
 * que en JS/TS (complexity.ts), sin ejecutar ni importar el código:
 *
 * - Ciclomática: 1 + if, elif, for, while, except, cada `case` (salvo `case _`),
 *   cada `and`/`or`, cada `if` de una expresión condicional o de una
 *   comprensión y cada `for` de una comprensión.
 * - Cognitiva (SonarSource): +1 + anidamiento por if, for, while, except, match
 *   y expresión condicional; +1 por elif, else, cada secuencia de `and`/`or`
 *   iguales y cada `for`/`if` de una comprensión. Como en JS/TS, el cuerpo de
 *   `try` cuenta un nivel más de anidamiento; `with` no anida.
 * - Las funciones anidadas se miden aparte y sus líneas no suman a la exterior.
 *   Las lambdas son expresiones: cuentan dentro de su función.
 * - Parámetros sin contar `self`/`cls` de los métodos ni los separadores `/` y `*`.
 */
const ID = 'complexity-python';
const VERSION = '1.0.0';
const TOOL = `${ID}@${VERSION}`;

/** Fin de una expresión en su nivel: aquí termina una secuencia de `and`/`or`. */
const EXPRESSION_BREAK = new Set([',', ':', ';', '=', ':=', '+=', '-=', '*=', '/=', '//=', '%=', '**=', '>>=', '<<=', '&=', '|=', '^=', '@=', '->']);
const EXPRESSION_BREAK_NAMES = new Set(['if', 'else', 'for', 'async', 'lambda', 'in']);

interface Counters {
  cyclomatic: number;
  cognitive: number;
}

const isOpener = (t: PyToken): boolean => t.type === 'op' && (t.value === '(' || t.value === '[' || t.value === '{');
const isCloser = (t: PyToken): boolean => t.type === 'op' && (t.value === ')' || t.value === ']' || t.value === '}');
const isLogical = (t: PyToken): boolean => t.type === 'name' && (t.value === 'and' || t.value === 'or');

/** Un nivel de paréntesis: operadores de la secuencia lógica en curso y si es una comprensión. */
interface Level {
  ops: string[];
  comprehension: boolean;
}

/** Suma la complejidad de una expresión (o sentencia simple), token a token. */
class ExpressionCounter {
  private readonly levels: Level[] = [];

  constructor(
    private readonly c: Counters,
    private readonly nesting: number,
    private readonly base: number,
  ) {}

  feed(t: PyToken): void {
    const rel = Math.max(0, t.depth - this.base);
    if (isOpener(t)) this.level(rel + 1);
    else if (isCloser(t)) this.close(rel);
    else if (isLogical(t)) {
      this.level(rel).ops.push(t.value);
      this.c.cyclomatic++;
    } else if (this.breaks(t, this.level(rel))) this.boundary(t, this.level(rel), rel);
  }

  finish(): void {
    for (const level of this.levels) if (level) this.flush(level);
  }

  private level(rel: number): Level {
    return (this.levels[rel] ??= { ops: [], comprehension: false });
  }

  private close(rel: number): void {
    for (const level of this.levels.slice(rel + 1)) if (level) this.flush(level);
    this.levels.length = rel + 1;
  }

  /** Cada secuencia de operadores iguales suma 1 a la cognitiva (`a and b or c` = 2). */
  private flush(level: Level): void {
    this.c.cognitive += level.ops.filter((op, i) => i === 0 || op !== level.ops[i - 1]).length;
    level.ops = [];
  }

  /** `in` de una comparación (`x in y and z`) no corta la secuencia; el de un `for` sí. */
  private breaks(t: PyToken, level: Level): boolean {
    if (t.type === 'op') return EXPRESSION_BREAK.has(t.value);
    return t.type === 'name' && EXPRESSION_BREAK_NAMES.has(t.value) && (t.value !== 'in' || level.comprehension);
  }

  private boundary(t: PyToken, level: Level, rel: number): void {
    this.flush(level);
    if (t.value === 'for') {
      this.c.cyclomatic++;
      this.c.cognitive++;
      level.comprehension ||= rel > 0;
    } else if (t.value === 'if' && t.type === 'name') {
      this.c.cyclomatic++;
      this.c.cognitive += level.comprehension ? 1 : 1 + this.nesting;
    }
  }
}

function measureExpression(tokens: readonly PyToken[], nesting: number, c: Counters): void {
  const counter = new ExpressionCounter(c, nesting, tokens[0]?.depth ?? 0);
  for (const t of tokens) counter.feed(t);
  counter.finish();
}

/** Lo que suma cada sentencia compuesta y el anidamiento de su cuerpo (relativo al suyo). */
interface Rule {
  cyclomatic: number;
  cognitive: number;
  /** La cognitiva suma además el anidamiento actual. */
  nested: boolean;
  bodyNesting: number;
}
const BRANCH: Rule = { cyclomatic: 1, cognitive: 1, nested: true, bodyNesting: 1 };
const RULES: Partial<Record<PyKeyword, Rule>> = {
  if: BRANCH,
  for: BRANCH,
  while: BRANCH,
  except: BRANCH,
  elif: { cyclomatic: 1, cognitive: 1, nested: false, bodyNesting: 1 },
  else: { cyclomatic: 0, cognitive: 1, nested: false, bodyNesting: 1 },
  try: { cyclomatic: 0, cognitive: 0, nested: false, bodyNesting: 1 },
  finally: { cyclomatic: 0, cognitive: 0, nested: false, bodyNesting: 1 },
};
const PLAIN: Rule = { cyclomatic: 0, cognitive: 0, nested: false, bodyNesting: 0 };

const isWildcardCase = (s: PyStatement): boolean => s.header.length === 1 && isName(s.header[0], '_');

interface FunctionContext {
  name: string;
  isMethod: boolean;
}

/** Recorre el cuerpo de una función acumulando sus métricas. */
class FunctionMeasurer {
  readonly c: Counters = { cyclomatic: 1, cognitive: 0 };
  maxNesting = 0;
  nestedLines = 0;

  visit(stmts: readonly PyStatement[], nesting: number): void {
    for (const s of stmts) this.statement(s, nesting);
  }

  private statement(s: PyStatement, nesting: number): void {
    if (s.keyword === 'def') {
      this.nestedLines += s.endLine - s.line.startLine + 1;
      return;
    }
    this.maxNesting = Math.max(this.maxNesting, nesting);
    if (s.keyword === 'match') return this.match(s, nesting);
    // `with`, `class` y `case` sueltos no suman ni anidan; una sentencia simple solo cuenta su expresión.
    const rule = (s.keyword && RULES[s.keyword]) ?? PLAIN;
    this.c.cyclomatic += rule.cyclomatic;
    this.c.cognitive += rule.cognitive + (rule.nested ? nesting : 0);
    measureExpression(s.header, nesting, this.c);
    this.visit(s.body, nesting + rule.bodyNesting);
  }

  private match(s: PyStatement, nesting: number): void {
    this.c.cognitive += 1 + nesting;
    measureExpression(s.header, nesting, this.c);
    for (const k of s.body) {
      if (k.keyword === 'case') {
        if (!isWildcardCase(k)) this.c.cyclomatic++;
        measureExpression(k.header, nesting + 1, this.c);
      }
      this.visit(k.body, nesting + 1);
    }
  }
}

export function measurePythonFunction(def: PyStatement, ctx: FunctionContext): FunctionMetrics {
  const m = new FunctionMeasurer();
  m.visit(def.body, 0);
  const startLine = def.line.startLine;
  return {
    name: ctx.name,
    startLine,
    endLine: def.endLine,
    lines: Math.max(1, def.endLine - startLine + 1 - m.nestedLines),
    cyclomatic: m.c.cyclomatic,
    cognitive: m.c.cognitive,
    maxNesting: m.maxNesting,
    parameters: countParameters(def.header, ctx.isMethod),
  };
}

/** Parámetros de `nombre[T](a, b=1, *args, **kw) -> R`. */
export function countParameters(header: readonly PyToken[], isMethod: boolean): number {
  const base = header[0]?.depth ?? 0;
  let open = header.findIndex((t) => isOp(t, '(') && t.depth === base);
  // Parámetros de tipo (`def f[T](…)`): el primer paréntesis de su nivel es el de los parámetros.
  if (open < 0) return 0;
  const params: PyToken[][] = [[]];
  for (open++; open < header.length; open++) {
    const t = header[open] as PyToken;
    if (isOp(t, ')') && t.depth === base) break;
    if (isOp(t, ',') && t.depth === base + 1) params.push([]);
    else (params[params.length - 1] as PyToken[]).push(t);
  }
  const named = params.filter((p) => p.length > 0 && !(p.length === 1 && (isOp(p[0], '/') || isOp(p[0], '*'))));
  const first = named[0];
  if (isMethod && first && (isName(first[0], 'self') || isName(first[0], 'cls'))) named.shift();
  return named.length;
}

function functionName(def: PyStatement): string {
  const t = def.header[0];
  return t?.type === 'name' ? t.value : '<anónima>';
}

/** Métricas de todas las funciones del archivo, la exterior antes que sus anidadas. */
export function collectPythonFunctionMetrics(text: string): FunctionMetrics[] {
  const out: FunctionMetrics[] = [];
  const walk = (stmts: readonly PyStatement[], className: string | null): void => {
    for (const s of stmts) {
      if (s.keyword === 'def') {
        const own = functionName(s);
        out.push(measurePythonFunction(s, { name: className ? `${className}.${own}` : own, isMethod: className !== null }));
        walk(s.body, null);
      } else if (s.keyword === 'class') {
        walk(s.body, functionName(s));
      } else walk(s.body, className);
    }
  };
  walk(parsePython(text), null);
  return out;
}

export const pythonComplexityAnalyzer: FileAnalyzer = {
  id: ID,
  version: VERSION,
  description: 'Complejidad cognitiva y ciclomática, longitud, anidamiento y parámetros por función de Python.',
  supports: (meta) => meta.language === 'python',
  analyze(input, config) {
    const seen = new Map<string, number>();
    const findings: Finding[] = [];
    for (const m of collectPythonFunctionMetrics(input.text)) {
      const ordinal = seen.get(m.name) ?? 0;
      seen.set(m.name, ordinal + 1);
      const f = buildFunctionFinding(input.meta.relPath, m, config.thresholds, ordinal, TOOL);
      if (f) findings.push(f);
    }
    return { findings };
  },
};
