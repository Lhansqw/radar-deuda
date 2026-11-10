import path from 'node:path';
import type { FileAnalyzer } from '../types.js';
import { translator } from '../i18n.js';
import { graphFindings, importGraph, type ResolvedImport } from './architecture.js';
import type { PyToken } from './python-lexer.js';
import { isName, isOp, parsePython, splitSimple, type PyStatement } from './python-syntax.js';

/**
 * Grafo de importaciones internas de Python: ciclos entre módulos y módulos
 * con demasiadas dependencias internas, con las mismas reglas que en JS/TS.
 *
 * - Relativas (`from .a import b`): desde el paquete del archivo.
 * - Absolutas (`import app.models`, `from app import models`): se prueban
 *   como raíz la del repositorio y cada carpeta por encima del archivo
 *   (cubre `src/` y proyectos dentro de una subcarpeta). Las que no
 *   corresponden a ningún archivo del repositorio (biblioteca estándar,
 *   paquetes instalados) se ignoran.
 * - No crean ciclo, aunque cuentan para el acoplamiento: las importaciones
 *   bajo `if TYPE_CHECKING:` (solo tipos) y las de dentro de una función, que
 *   se ejecutan al llamarla y son la forma habitual de romper un ciclo.
 */
const ID = 'architecture-python';
const VERSION = '1.0.0';
const TOOL = `${ID}@${VERSION}`;

export interface PyImportRef {
  line: number;
  typeOnly: boolean;
  /** Rutas del módulo importado sin extensión, de la más probable a la menos (una por raíz posible). */
  bases: string[];
  /** `from m import a, b`: nombres que pueden ser submódulos de `m`. */
  names: string[];
}

export interface PyImportsArtifact {
  imports: PyImportRef[];
}

const join = (...parts: string[]): string => parts.filter((p) => p !== '').join('/');

/** Carpetas desde la raíz del repositorio hasta la del archivo: '', 'a', 'a/b'. */
function ancestors(dir: string): string[] {
  const parts = dir === '.' || dir === '' ? [] : dir.split('/');
  return parts.reduce<string[]>((acc, p) => [...acc, join(acc[acc.length - 1] ?? '', p)], ['']);
}

/** Nombre con puntos (`a.b.c`) desde `i`; devuelve el nombre y el índice siguiente. */
function dotted(tokens: readonly PyToken[], i: number): [string, number] {
  const parts: string[] = [];
  while (tokens[i]?.type === 'name') {
    parts.push((tokens[i] as PyToken).value);
    if (!isOp(tokens[i + 1], '.')) return [parts.join('.'), i + 1];
    i += 2;
  }
  return [parts.join('.'), i];
}

interface RawImport {
  /** 0 = absoluta; n = n puntos. */
  level: number;
  module: string;
  names: string[];
}

/** `import a.b as c, d`: un módulo por cada elemento separado por comas. */
function parsePlainImport(tokens: readonly PyToken[]): RawImport[] {
  const out: RawImport[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const [module, next] = dotted(tokens, i);
    if (module) out.push({ level: 0, module, names: [] });
    i = next;
    while (i < tokens.length && !isOp(tokens[i], ',')) i++;
  }
  return out;
}

/** Nombres importados desde `i`: `(b as c, d)` → b, d. */
function importedNames(tokens: readonly PyToken[], i: number): string[] {
  const names: string[] = [];
  let expectName = true;
  for (const t of tokens.slice(i)) {
    if (isOp(t, ',')) expectName = true;
    else if (expectName && t.type === 'name' && t.value !== 'as') {
      names.push(t.value);
      expectName = false;
    }
  }
  return names;
}

/** `from ..a import (b as c, d)`. */
function parseFromImport(tokens: readonly PyToken[]): RawImport[] {
  let i = 1;
  let level = 0;
  for (; isOp(tokens[i], '.') || isOp(tokens[i], '...'); i++) level += (tokens[i] as PyToken).value.length;
  // `from . import x`: sin nombre de módulo (y `import` no es un nombre).
  const [module, next] = isName(tokens[i], 'import') ? ['', i] : dotted(tokens, i);
  if (!isName(tokens[next], 'import')) return [];
  return [{ level, module, names: importedNames(tokens, next + 1) }];
}

/** `import a.b as c, d` o `from ..a import (b as c, d)`. */
export function parseImport(tokens: readonly PyToken[]): RawImport[] {
  if (isName(tokens[0], 'import')) return parsePlainImport(tokens);
  return isName(tokens[0], 'from') ? parseFromImport(tokens) : [];
}

/** Rutas candidatas (sin extensión) del módulo que importa `relPath`. */
export function moduleBases(relPath: string, imp: RawImport): string[] {
  const dir = path.posix.dirname(relPath);
  const parts = imp.module === '' ? [] : imp.module.split('.');
  if (imp.level === 0) return ancestors(dir).map((root) => join(root, ...parts));
  const pkg = dir === '.' ? [] : dir.split('/');
  if (imp.level - 1 > pkg.length) return [];
  return [join(...pkg.slice(0, pkg.length - (imp.level - 1)), ...parts)];
}

const isTypeChecking = (header: readonly PyToken[]): boolean => {
  const last = header[header.length - 1];
  return isName(last, 'TYPE_CHECKING') && header.every((t) => t.type === 'name' || isOp(t, '.'));
};

/** Las importaciones de una sentencia simple (puede tener varias separadas por `;`). */
function statementImports(s: PyStatement, relPath: string, typeOnly: boolean): PyImportRef[] {
  return splitSimple(s.header).flatMap((part) =>
    parseImport(part)
      .map((imp) => ({ line: (part[0] as PyToken).line, typeOnly, bases: moduleBases(relPath, imp), names: imp.names }))
      .filter((ref) => ref.bases.length > 0),
  );
}

export function extractPythonImports(text: string, relPath: string): PyImportRef[] {
  const out: PyImportRef[] = [];
  /** `typeOnly`: bajo `if TYPE_CHECKING:` o dentro de una función; no crea dependencia al cargar el módulo. */
  const walk = (stmts: readonly PyStatement[], typeOnly: boolean): void => {
    for (const s of stmts) {
      if (s.keyword === null) out.push(...statementImports(s, relPath, typeOnly));
      else walk(s.body, typeOnly || s.keyword === 'def' || (s.keyword === 'if' && isTypeChecking(s.header)));
    }
  };
  walk(parsePython(text), false);
  return out;
}

/** Los archivos a los que llega la importación tomando `base` como ruta del módulo. */
function resolveFrom(base: string, names: readonly string[], known: ReadonlySet<string>): string[] {
  const first = (...candidates: string[]): string | undefined => candidates.find((c) => known.has(c));
  const submodules = names.map((name) => first(`${join(base, name)}.py`, `${join(base, name, '__init__')}.py`));
  const targets = submodules.filter((t): t is string => t !== undefined);
  // Si algún nombre no es un submódulo, es algo definido en el propio módulo (o paquete).
  if (names.length === 0 || targets.length < names.length) {
    const own = first(...(base === '' ? [] : [`${base}.py`]), `${join(base, '__init__')}.py`);
    if (own) targets.push(own);
  }
  return [...new Set(targets)];
}

/** Archivos del repositorio a los que llega una importación: submódulos nombrados o el propio módulo. */
export function resolvePythonImport(ref: PyImportRef, known: ReadonlySet<string>): string[] {
  for (const base of ref.bases) {
    const targets = resolveFrom(base, ref.names, known);
    if (targets.length > 0) return targets;
  }
  return [];
}

export const pythonArchitectureAnalyzer: FileAnalyzer<PyImportsArtifact> = {
  id: ID,
  version: VERSION,
  description: 'Ciclos de dependencias entre módulos de Python y acoplamiento eferente alto (grafo de importaciones internas).',
  supports: (meta) => meta.language === 'python',
  analyze(input) {
    return { findings: [], artifact: { imports: extractPythonImports(input.text, input.meta.relPath) } };
  },
  finalize(artifacts, config) {
    const known = new Set(artifacts.keys());
    const resolved = [...artifacts].map(([file, art]): [string, ResolvedImport[]] => [
      file,
      art.imports.flatMap((ref) => resolvePythonImport(ref, known).map((target) => ({ target, line: ref.line, typeOnly: ref.typeOnly }))),
    ]);
    return graphFindings(importGraph(resolved), config.thresholds.fanOut, TOOL, translator(config.locale));
  },
};
