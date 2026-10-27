import type ts from 'typescript';
import type { Evidence, FileAnalyzer, Finding, Severity, Thresholds } from '../types.js';
import { SEVERITY_ORDER } from '../types.js';
import { findingId } from '../util.js';
import { isJsLike, scriptKindFor, severityByRatio, getSourceFile } from './shared.js';
import { lazy, loadTypeScript, tsApi } from './ts-runtime.js';

const ID = 'complexity';
const VERSION = '1.1.0';
const TOOL = `${ID}@${VERSION}`;

export interface FunctionMetrics {
  name: string;
  startLine: number;
  endLine: number;
  /** Líneas propias: excluye las de funciones anidadas (que se miden aparte). */
  lines: number;
  cyclomatic: number;
  cognitive: number;
  maxNesting: number;
  parameters: number;
}

type FunctionNode = ts.SignatureDeclaration & { body?: ts.Node | undefined };

function isFunctionWithBody(node: ts.Node): node is FunctionNode {
  const ts = tsApi();
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.body !== undefined
  );
}

function propertyNameText(name: ts.PropertyName | ts.BindingName | undefined, sf: ts.SourceFile): string | undefined {
  const ts = tsApi();
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return name.getText(sf);
}

/** Nombre legible: declaración, variable/propiedad a la que se asigna, o `<anónima>`. */
export function functionName(node: FunctionNode, sf: ts.SourceFile): string {
  const ts = tsApi();
  if (ts.isConstructorDeclaration(node)) {
    const cls = node.parent;
    return `${ts.isClassLike(cls) && cls.name ? cls.name.text : '<clase>'}.constructor`;
  }
  const own = propertyNameText(node.name as ts.PropertyName | undefined, sf);
  const parent = node.parent;
  if (own) {
    if ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && ts.isClassLike(parent) && parent.name) {
      return `${parent.name.text}.${own}`;
    }
    return own;
  }
  if (ts.isVariableDeclaration(parent)) return propertyNameText(parent.name, sf) ?? '<anónima>';
  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) return propertyNameText(parent.name, sf) ?? '<anónima>';
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) return parent.left.getText(sf);
  if (ts.isExportAssignment(parent)) return 'default';
  return '<anónima>';
}

const logicalOperators = lazy((ts) => new Set<ts.SyntaxKind>([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]));
const logicalAssignments = lazy(
  (ts) => new Set<ts.SyntaxKind>([ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken]),
);

function isLogical(node: ts.Node): node is ts.BinaryExpression {
  return tsApi().isBinaryExpression(node) && logicalOperators().has(node.operatorToken.kind);
}

/** Operadores de una cadena lógica en orden (a && b || c → [&&, ||]). */
function logicalSequence(node: ts.Expression, out: ts.SyntaxKind[]): void {
  if (isLogical(node)) {
    logicalSequence(node.left, out);
    out.push(node.operatorToken.kind);
    logicalSequence(node.right, out);
  }
}

function isLoop(node: ts.Node): boolean {
  const ts = tsApi();
  return ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node);
}

/**
 * Mide una función:
 * - Complejidad cognitiva (SonarSource, 2017): penaliza el anidamiento y las
 *   rupturas del flujo lineal; un `switch` cuenta una vez. Es la métrica que
 *   dispara el hallazgo porque refleja la dificultad de *entender* el código.
 * - Complejidad ciclomática de McCabe (1 + puntos de decisión): número de
 *   caminos, útil como estimación de casos de prueba. Se aporta como evidencia.
 * - Anidamiento máximo, líneas propias y número de parámetros.
 * Las funciones anidadas se miden por separado y no suman a la exterior.
 */
export function measureFunction(fn: FunctionNode, sf: ts.SourceFile): FunctionMetrics {
  const ts = tsApi();
  let cyclomatic = 1;
  let cognitive = 0;
  let maxNesting = 0;
  let nestedLines = 0;
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const visitIf = (node: ts.IfStatement, nesting: number, isElseIf: boolean): void => {
    cyclomatic++;
    cognitive += isElseIf ? 1 : 1 + nesting;
    visit(node.expression, nesting);
    visit(node.thenStatement, nesting + 1);
    const elseStmt = node.elseStatement;
    if (elseStmt) {
      if (ts.isIfStatement(elseStmt)) visitIf(elseStmt, nesting, true);
      else {
        cognitive += 1;
        visit(elseStmt, nesting + 1);
      }
    }
  };

  const visit = (node: ts.Node, nesting: number): void => {
    if (isFunctionWithBody(node)) {
      nestedLines += lineOf(node.end) - lineOf(node.getStart(sf)) + 1;
      return;
    }
    if (nesting > maxNesting) maxNesting = nesting;
    if (ts.isIfStatement(node)) return visitIf(node, nesting, false);

    if (isLoop(node) || ts.isCatchClause(node) || ts.isConditionalExpression(node)) {
      cyclomatic++;
      cognitive += 1 + nesting;
      ts.forEachChild(node, (c) => visit(c, nesting + 1));
      return;
    }
    if (ts.isSwitchStatement(node)) {
      cognitive += 1 + nesting;
      cyclomatic += node.caseBlock.clauses.filter((c) => ts.isCaseClause(c)).length;
      visit(node.expression, nesting);
      ts.forEachChild(node.caseBlock, (c) => visit(c, nesting + 1));
      return;
    }
    if (ts.isTryStatement(node)) {
      // try no suma, pero su contenido está un nivel más anidado (como catch).
      visit(node.tryBlock, nesting + 1);
      if (node.catchClause) visit(node.catchClause, nesting);
      if (node.finallyBlock) visit(node.finallyBlock, nesting + 1);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      if (isLogical(node) && !isLogical(node.parent)) {
        const ops: ts.SyntaxKind[] = [];
        logicalSequence(node, ops);
        cyclomatic += ops.length;
        cognitive += ops.filter((op, i) => i === 0 || op !== ops[i - 1]).length;
      } else if (logicalAssignments().has(node.operatorToken.kind)) {
        cyclomatic++;
        cognitive++;
      }
    }
    if ((ts.isBreakStatement(node) || ts.isContinueStatement(node)) && node.label) cognitive++;
    ts.forEachChild(node, (c) => visit(c, nesting));
  };

  if (fn.body) ts.forEachChild(fn.body, (child) => visit(child, 0));

  const startLine = lineOf(fn.getStart(sf));
  const endLine = lineOf(fn.end);
  return {
    name: functionName(fn, sf),
    startLine,
    endLine,
    lines: Math.max(1, endLine - startLine + 1 - nestedLines),
    cyclomatic,
    cognitive,
    maxNesting,
    parameters: fn.parameters.length,
  };
}

export function collectFunctionMetrics(text: string, relPath: string, sourceFile?: ts.SourceFile): FunctionMetrics[] {
  const ts = tsApi();
  const sf = sourceFile ?? ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, scriptKindFor(relPath));
  const out: FunctionMetrics[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionWithBody(node)) out.push(measureFunction(node, sf));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function maxSeverity(list: Severity[]): Severity {
  return list.reduce<Severity>((acc, s) => (SEVERITY_ORDER[s] > SEVERITY_ORDER[acc] ? s : acc), 'info');
}

export function buildFunctionFinding(file: string, m: FunctionMetrics, t: Thresholds, ordinal: number): Finding | null {
  const evidence: Evidence[] = [];
  const severities: Severity[] = [];
  let minutes = 0;
  const parts: string[] = [];

  if (m.cognitive > t.cognitive) {
    evidence.push({ kind: 'metric', tool: TOOL, description: 'Complejidad cognitiva (SonarSource)', metric: { name: 'cognitive', value: m.cognitive, threshold: t.cognitive } });
    severities.push(severityByRatio(m.cognitive, t.cognitive));
    minutes += 4 * (m.cognitive - t.cognitive);
    parts.push(`complejidad cognitiva ${m.cognitive} (umbral ${t.cognitive})`);
  }
  if (m.lines > t.functionLines) {
    evidence.push({ kind: 'metric', tool: TOOL, description: 'Líneas propias de la función (sin funciones anidadas)', metric: { name: 'lines', value: m.lines, threshold: t.functionLines, unit: 'líneas' } });
    severities.push(severityByRatio(m.lines, t.functionLines, 'high'));
    minutes += 0.5 * (m.lines - t.functionLines);
    parts.push(`${m.lines} líneas propias (umbral ${t.functionLines})`);
  }
  if (m.maxNesting > t.nesting) {
    evidence.push({ kind: 'metric', tool: TOOL, description: 'Profundidad máxima de anidamiento', metric: { name: 'nesting', value: m.maxNesting, threshold: t.nesting, unit: 'niveles' } });
    severities.push(m.maxNesting >= t.nesting + 3 ? 'high' : 'medium');
    minutes += 10 * (m.maxNesting - t.nesting);
    parts.push(`anidamiento de ${m.maxNesting} niveles (umbral ${t.nesting})`);
  }
  if (m.parameters > t.parameters) {
    evidence.push({ kind: 'metric', tool: TOOL, description: 'Número de parámetros', metric: { name: 'parameters', value: m.parameters, threshold: t.parameters } });
    severities.push('low');
    minutes += 10;
    parts.push(`${m.parameters} parámetros (umbral ${t.parameters})`);
  }
  if (evidence.length === 0) return null;
  if (m.cyclomatic > t.cyclomatic) {
    // Evidencia de apoyo: no dispara el hallazgo por sí sola (un switch largo y plano es legible).
    evidence.push({ kind: 'metric', tool: TOOL, description: 'Complejidad ciclomática (McCabe): caminos independientes, ≈ casos de prueba necesarios', metric: { name: 'cyclomatic', value: m.cyclomatic, threshold: t.cyclomatic } });
    parts.push(`${m.cyclomatic} caminos de ejecución`);
  }

  const total = Math.min(480, Math.round(15 + minutes));
  return {
    id: findingId('complexity/function', file, `${m.name}#${ordinal}`),
    ruleId: 'complexity/function',
    category: 'complexity',
    severity: maxSeverity(severities),
    confidence: 'high',
    title: `Función difícil de mantener: ${m.name}`,
    message: `La función ${m.name} supera los umbrales: ${parts.join('; ')}.`,
    locations: [{ file, startLine: m.startLine, endLine: m.endLine, symbol: m.name }],
    evidence,
    impact: 'El código anidado y con muchas ramas es difícil de entender, necesita más pruebas y es más propenso a defectos al modificarlo.',
    effort: {
      minutes: total,
      rationale: '15 min base + 4 min por punto de complejidad cognitiva sobre el umbral + 0,5 min por línea propia sobre el umbral + 10 min por nivel de anidamiento extra + 10 min si hay exceso de parámetros (máx. 8 h).',
    },
  };
}

export const complexityAnalyzer: FileAnalyzer = {
  id: ID,
  version: VERSION,
  description: 'Complejidad cognitiva y ciclomática, longitud, anidamiento y parámetros por función (TypeScript Compiler API).',
  supports: (meta) => isJsLike(meta),
  prepare: async () => {
    await loadTypeScript();
  },
  analyze(input, config) {
    const metrics = collectFunctionMetrics(input.text, input.meta.relPath, getSourceFile(input));
    const seen = new Map<string, number>();
    const findings: Finding[] = [];
    for (const m of metrics) {
      const ordinal = seen.get(m.name) ?? 0;
      seen.set(m.name, ordinal + 1);
      const f = buildFunctionFinding(input.meta.relPath, m, config.thresholds, ordinal);
      if (f) findings.push(f);
    }
    return { findings };
  },
};
