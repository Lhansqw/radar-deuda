import path from 'node:path';
import type ts from 'typescript';
import type { FileAnalyzer, Finding, Location } from '../types.js';
import { findingId } from '../util.js';
import { getSourceFile, isJsLike } from './shared.js';
import { loadTypeScript, tsApi } from './ts-runtime.js';

/**
 * Grafo de importaciones internas: ciclos entre módulos (Tarjan) y módulos con
 * demasiadas dependencias internas (acoplamiento eferente alto).
 * Reutiliza el AST compartido (lo construye el primer analizador que lo pide).
 */
const ID = 'architecture';
const VERSION = '1.0.0';
const TOOL = `${ID}@${VERSION}`;

export interface ImportRef {
  spec: string;
  line: number;
  typeOnly: boolean;
}

export interface ImportsArtifact {
  imports: ImportRef[];
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const ts = tsApi();
  const clause = node.importClause;
  if (!clause) return false; // import './efecto' tiene efectos en ejecución
  if (clause.isTypeOnly) return true;
  // import { type A, type B } from './x' — todas las importaciones son de tipos
  const bindings = clause.namedBindings;
  return !clause.name && bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly);
}

/** Importaciones relativas: import/export…from, require('…') e import('…'). */
export function extractImports(sf: ts.SourceFile): ImportRef[] {
  const ts = tsApi();
  const out: ImportRef[] = [];
  const push = (spec: ts.Expression, typeOnly: boolean): void => {
    if (!ts.isStringLiteralLike(spec) || !spec.text.startsWith('.')) return;
    out.push({ spec: spec.text, line: sf.getLineAndCharacterOfPosition(spec.getStart(sf)).line + 1, typeOnly });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) push(node.moduleSpecifier, isTypeOnlyImport(node));
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) push(node.moduleSpecifier, node.isTypeOnly);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) push(node.moduleReference.expression, node.isTypeOnly);
    else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamic) push(node.arguments[0] as ts.Expression, false);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

export function resolveImport(fromFile: string, spec: string, known: ReadonlySet<string>): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  const candidates = [base];
  const ext = path.posix.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  for (const e of EXTENSIONS) candidates.push(`${stem}${e}`, `${base}${e}`);
  for (const e of EXTENSIONS) candidates.push(`${base}/index${e}`);
  for (const c of candidates) if (known.has(c)) return c;
  return null;
}

/** Componentes fuertemente conexos (Tarjan iterativo, sin riesgo de desbordar la pila). */
export function stronglyConnected(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];

  for (const start of graph.keys()) {
    if (idx.has(start)) continue;
    const work: Array<{ node: string; i: number }> = [{ node: start, i: 0 }];
    idx.set(start, index);
    low.set(start, index);
    index++;
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1] as { node: string; i: number };
      const edges = graph.get(frame.node) ?? [];
      if (frame.i < edges.length) {
        const next = edges[frame.i++] as string;
        if (!idx.has(next)) {
          idx.set(next, index);
          low.set(next, index);
          index++;
          stack.push(next);
          onStack.add(next);
          work.push({ node: next, i: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node) as number, idx.get(next) as number));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node) as number, low.get(frame.node) as number));
      if (low.get(frame.node) === idx.get(frame.node)) {
        const comp: string[] = [];
        let w: string;
        do {
          w = stack.pop() as string;
          onStack.delete(w);
          comp.push(w);
        } while (w !== frame.node);
        result.push(comp);
      }
    }
  }
  return result;
}

export const architectureAnalyzer: FileAnalyzer<ImportsArtifact> = {
  id: ID,
  version: VERSION,
  description: 'Ciclos de dependencias entre módulos y acoplamiento eferente alto (grafo de importaciones relativas).',
  supports: (meta) => isJsLike(meta),
  prepare: async () => {
    await loadTypeScript();
  },
  analyze(input) {
    return { findings: [], artifact: { imports: extractImports(getSourceFile(input)) } };
  },
  finalize(artifacts, config) {
    const known = new Set(artifacts.keys());
    const graph = new Map<string, string[]>();
    const edgeLine = new Map<string, number>();
    const findings: Finding[] = [];

    for (const [file, art] of artifacts) {
      const targets = new Set<string>();
      const all = new Set<string>();
      for (const ref of art.imports) {
        const target = resolveImport(file, ref.spec, known);
        if (!target || target === file) continue;
        all.add(target);
        if (ref.typeOnly) continue; // las importaciones de tipos no crean ciclos en tiempo de ejecución
        targets.add(target);
        if (!edgeLine.has(`${file}>${target}`)) edgeLine.set(`${file}>${target}`, ref.line);
      }
      graph.set(file, [...targets].sort());

      const fanOut = all.size;
      if (fanOut > config.thresholds.fanOut) {
        findings.push({
          id: findingId('architecture/high-fan-out', file, 'fan-out'),
          ruleId: 'architecture/high-fan-out',
          category: 'maintainability',
          severity: fanOut >= config.thresholds.fanOut * 2 ? 'high' : 'medium',
          confidence: 'medium',
          title: `Módulo muy acoplado (${fanOut} dependencias internas)`,
          message: `El archivo importa ${fanOut} módulos internos distintos (umbral ${config.thresholds.fanOut}). Suele indicar baja cohesión o un orquestador con demasiadas responsabilidades.`,
          locations: [{ file, startLine: 1, endLine: 1 }],
          evidence: [{ kind: 'metric', tool: TOOL, description: 'Acoplamiento eferente (importaciones relativas resueltas)', metric: { name: 'fanOut', value: fanOut, threshold: config.thresholds.fanOut } }],
          impact: 'Cualquier cambio en sus dependencias puede romperlo; es difícil de probar de forma aislada.',
          effort: { minutes: Math.min(480, 30 + 5 * (fanOut - config.thresholds.fanOut)), rationale: '30 min base + 5 min por dependencia sobre el umbral (máx. 8 h).' },
        });
      }
    }

    for (const comp of stronglyConnected(graph)) {
      if (comp.length < 2) continue;
      const members = comp.sort();
      const memberSet = new Set(members);
      const locations: Location[] = [];
      for (const from of members) {
        for (const to of graph.get(from) ?? []) {
          if (!memberSet.has(to)) continue;
          const line = edgeLine.get(`${from}>${to}`) ?? 1;
          locations.push({ file: from, startLine: line, endLine: line, symbol: `→ ${to}` });
        }
      }
      findings.push({
        id: findingId('architecture/cycle', members[0] as string, members.join('|')),
        ruleId: 'architecture/cycle',
        category: 'maintainability',
        severity: members.length >= 4 ? 'high' : 'medium',
        confidence: 'high',
        title: `Dependencia circular entre ${members.length} módulos`,
        message: `Estos módulos se importan entre sí formando un ciclo: ${members.join(', ')}.`,
        locations,
        evidence: [{ kind: 'fact', tool: TOOL, description: 'Componente fuertemente conexo del grafo de importaciones (sin contar importaciones de solo tipos)', metric: { name: 'cycleSize', value: members.length, threshold: 1 } }],
        impact: 'Los ciclos impiden entender y probar los módulos por separado y pueden causar errores de inicialización (valores undefined al importar).',
        effort: { minutes: Math.min(960, 30 * members.length), rationale: '30 min por módulo del ciclo para extraer la parte compartida o invertir la dependencia (máx. 16 h).' },
      });
    }
    return findings;
  },
};
