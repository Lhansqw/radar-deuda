import { afterEach, describe, expect, it } from 'vitest';
import { pythonDuplicationAnalyzer } from '../src/analyzers/duplication.js';
import { extractPythonImports, moduleBases, parseImport, pythonArchitectureAnalyzer, resolvePythonImport, type PyImportsArtifact } from '../src/analyzers/python-architecture.js';
import { collectPythonFunctionMetrics, pythonComplexityAnalyzer } from '../src/analyzers/python-complexity.js';
import { tokenizePython } from '../src/analyzers/python-lexer.js';
import { testingAnalyzer } from '../src/analyzers/testing.js';
import { forgetTypeScriptForTests, isTypeScriptLoaded } from '../src/analyzers/ts-runtime.js';
import { resolveConfig } from '../src/config.js';
import { analyzeRepository } from '../src/engine.js';
import type { DuplicationArtifact } from '../src/analyzers/duplication-tokens.js';
import type { Finding } from '../src/types.js';
import { fileInput } from './helpers/file-input.js';
import { memoryStore } from './helpers/memory-store.js';
import { projectContext } from './helpers/project-context.js';
import { createTmpRepo, type TmpRepo } from './helpers/tmp-repo.js';

const repos: TmpRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.cleanup()));
});

const dedent = (code: string): string => {
  const lines = code.replace(/^\n/, '').split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim() !== '').map((l) => (/^ */.exec(l) as RegExpExecArray)[0].length));
  return lines.map((l) => l.slice(indent)).join('\n');
};

const only = (code: string) => {
  const [m] = collectPythonFunctionMetrics(dedent(code));
  if (!m) throw new Error('no se encontró ninguna función');
  return m;
};

describe('tokenizador de Python', () => {
  it('agrupa líneas lógicas: paréntesis abiertos, `\\` y strings triples', () => {
    const { lines } = tokenizePython(['x = 1  # comentario', 's = """a', 'b"""', 'f(a,', '  b)', 'y = 2 \\', '  + 3', '', '# solo comentario'].join('\n'));
    expect(lines.map((l) => [l.startLine, l.endLine])).toEqual([
      [1, 1],
      [2, 3],
      [4, 5],
      [6, 7],
    ]);
    expect(lines[1]?.tokens.map((t) => t.type)).toEqual(['name', 'op', 'string']);
  });

  it('un f-string con comillas iguales dentro de la expresión es un solo token (Python 3.12)', () => {
    const { lines } = tokenizePython(`v = f"{d["k"]} y {x!r:>{w}}" + rb'\\d'`);
    expect(lines[0]?.tokens.map((t) => t.type)).toEqual(['name', 'op', 'string', 'op', 'string']);
  });

  it('emite sangría y saltos de línea en el flujo de tokens', () => {
    const { stream } = tokenizePython('if a:\n    b()\nc()\n');
    expect(stream.map((t) => (t.type === 'name' || t.type === 'op' ? t.value : t.type))).toEqual(['if', 'a', ':', 'newline', 'indent', 'b', '(', ')', 'newline', 'dedent', 'c', '(', ')', 'newline']);
  });

  it('tolera código mal formado sin colgarse', () => {
    expect(() => tokenizePython('s = "sin cerrar\n)) ]\n\tdef (:\n"""')).not.toThrow();
  });
});

describe('complejidad de funciones de Python', () => {
  it('bucles anidados con if y for…else: cognitiva 7, ciclomática 4, anidamiento 3', () => {
    const m = only(`
      def sum_of_primes(maximum):
          total = 0
          for i in range(1, maximum + 1):
              for j in range(2, i):
                  if i % j == 0:
                      break
              else:
                  total += i
          return total
    `);
    expect([m.cognitive, m.cyclomatic, m.maxNesting]).toEqual([7, 4, 3]);
  });

  it('if/elif/else y secuencias de and/or', () => {
    const m = only(`
      def clasificar(x, y):
          if x > 0 and y > 0:
              return 1
          elif x < 0 or y < 0 or x == y:
              return 2
          else:
              return 3
    `);
    expect([m.cognitive, m.cyclomatic, m.maxNesting]).toEqual([5, 6, 1]);
    expect(only('def f(a, b, c):\n    return a and b or c\n').cognitive).toBe(2);
  });

  it('comprensiones y expresión condicional', () => {
    const m = only(`
      def filtrar(items):
          return [x for x in items if x] if items else []
    `);
    expect([m.cognitive, m.cyclomatic]).toEqual([3, 4]);
  });

  it('match: un incremento y un camino por cada case salvo el comodín', () => {
    const m = only(`
      def orden(cmd):
          match cmd:
              case "a":
                  return 1
              case "b" | "c":
                  return 2
              case _:
                  return 0
    `);
    expect([m.cognitive, m.cyclomatic, m.maxNesting]).toEqual([1, 3, 1]);
  });

  it('try anida su cuerpo, with no anida y except suma', () => {
    const m = only(`
      def leer(path):
          try:
              with open(path) as fh:
                  if fh:
                      return fh.read()
          except OSError:
              return None
          finally:
              pass
    `);
    expect([m.cognitive, m.cyclomatic, m.maxNesting]).toEqual([3, 3, 2]);
  });

  it('nombres, parámetros (sin self ni separadores) y líneas propias sin las funciones anidadas', () => {
    const metrics = collectPythonFunctionMetrics(
      dedent(`
        class Pedido:
            def __init__(self, cliente, *, urgente=False, **extra):
                self.cliente = cliente

            @staticmethod
            def crear(a, b, /, c):
                def interna(x):
                    return x
                return interna(a)

        async def descargar(url: str = "x", timeout: tuple[int, int] = (1, 2)) -> dict[str, int]:
            pass
      `),
    );
    expect(metrics.map((m) => [m.name, m.parameters, m.startLine, m.endLine, m.lines])).toEqual([
      ['Pedido.__init__', 3, 2, 3, 2],
      ['Pedido.crear', 3, 6, 9, 2],
      ['interna', 1, 7, 8, 2],
      ['descargar', 2, 11, 12, 2],
    ]);
  });

  it('match y case como nombres normales no son sentencias', () => {
    const m = only(`
      def buscar(texto):
          match = patron.match(texto)
          case: int = 3
          return match
    `);
    expect([m.cognitive, m.cyclomatic]).toEqual([0, 1]);
  });

  it('genera el hallazgo con la evidencia de la herramienta de Python', () => {
    const deep = dedent(`
      def procesar(pedido, cliente, items, cupon, envio, impuestos):
          for item in items:
              if item.activo:
                  for d in item.descuentos:
                      if d.valido and cliente.premium:
                          while d.pendiente:
                              if cupon or envio:
                                  d.aplicar()
    `);
    const { findings } = pythonComplexityAnalyzer.analyze(fileInput('app/pedidos.py', deep), resolveConfig());
    expect(findings).toHaveLength(1);
    const f = findings[0] as Finding;
    expect(f.ruleId).toBe('complexity/function');
    expect(f.title).toBe('Función difícil de mantener: procesar');
    expect(f.locations[0]).toMatchObject({ file: 'app/pedidos.py', startLine: 1, endLine: 8 });
    expect(new Set(f.evidence.map((e) => e.tool))).toEqual(new Set(['complexity-python@1.0.0']));
    expect(f.evidence.map((e) => e.metric?.name)).toEqual(['cognitive', 'nesting', 'parameters']);
  });
});

describe('importaciones de Python', () => {
  it('reconoce import, from…import, alias, paréntesis y niveles relativos', () => {
    const imports = extractPythonImports(
      dedent(`
        import os, app.modelos as m
        from . import utilidades
        from ..nucleo.base import (Modelo as M, Campo,)
        from app.servicios import *
        import a; import b
      `),
      'app/vistas/pedidos.py',
    );
    expect(imports.map((i) => [i.line, i.bases[i.bases.length - 1], i.names])).toEqual([
      [1, 'app/vistas/os', []],
      [1, 'app/vistas/app/modelos', []],
      [2, 'app/vistas', ['utilidades']],
      [3, 'app/nucleo/base', ['Modelo', 'Campo']],
      [4, 'app/vistas/app/servicios', []],
      [5, 'app/vistas/a', []],
      [5, 'app/vistas/b', []],
    ]);
    expect(moduleBases('app/vistas/pedidos.py', { level: 0, module: 'app.modelos', names: [] })).toEqual(['app/modelos', 'app/app/modelos', 'app/vistas/app/modelos']);
    expect(moduleBases('a.py', { level: 3, module: 'x', names: [] })).toEqual([]);
    expect(parseImport(tokenizePython('from __future__ import annotations').lines[0]?.tokens ?? [])).toEqual([{ level: 0, module: '__future__', names: ['annotations'] }]);
  });

  it('bajo TYPE_CHECKING o dentro de una función no crean ciclo', () => {
    const imports = extractPythonImports(
      dedent(`
        from typing import TYPE_CHECKING
        if TYPE_CHECKING:
            from .b import B
        else:
            from .c import C
        def f():
            from .d import D
      `),
      'p/a.py',
    );
    expect(imports.map((i) => [i.bases[0], i.typeOnly])).toEqual([
      ['typing', false],
      ['p/b', true],
      ['p/c', false],
      ['p/d', true],
    ]);
  });

  it('resuelve submódulos, paquetes y la raíz src/; ignora la biblioteca estándar', () => {
    const known = new Set(['src/app/__init__.py', 'src/app/modelos.py', 'src/app/servicios/__init__.py', 'src/app/vistas.py']);
    const [mods, pkg, std] = extractPythonImports('from app import modelos, servicios\nimport app\nimport json\n', 'src/app/vistas.py');
    expect(resolvePythonImport(mods as never, known).sort()).toEqual(['src/app/modelos.py', 'src/app/servicios/__init__.py']);
    expect(resolvePythonImport(pkg as never, known)).toEqual(['src/app/__init__.py']);
    expect(resolvePythonImport(std as never, known)).toEqual([]);
  });

  async function architecture(files: Record<string, string>, fanOut = 20): Promise<Finding[]> {
    const artifacts = new Map<string, PyImportsArtifact>();
    for (const [rel, code] of Object.entries(files)) {
      const art = pythonArchitectureAnalyzer.analyze(fileInput(rel, code), resolveConfig()).artifact;
      if (art) artifacts.set(rel, art);
    }
    return (await pythonArchitectureAnalyzer.finalize?.(artifacts, resolveConfig({ thresholds: { fanOut } }), { readText: async () => null, store: memoryStore() })) ?? [];
  }

  it('detecta ciclos entre módulos y el acoplamiento alto', async () => {
    const findings = await architecture(
      {
        'app/__init__.py': '',
        'app/a.py': 'from app import b\nimport app.c\n',
        'app/b.py': 'from .a import x\n',
        'app/c.py': 'from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from app.a import A\n',
      },
      1,
    );
    const cycle = findings.find((f) => f.ruleId === 'architecture/cycle');
    expect(cycle?.message).toContain('app/a.py, app/b.py');
    expect(cycle?.locations.map((l) => [l.file, l.startLine])).toEqual([
      ['app/a.py', 1],
      ['app/b.py', 1],
    ]);
    expect(cycle?.evidence[0]?.tool).toBe('architecture-python@1.0.0');
    expect(findings.filter((f) => f.ruleId === 'architecture/high-fan-out').map((f) => f.locations[0]?.file)).toEqual(['app/a.py']);
  });
});

describe('duplicación en Python', () => {
  const block = (name: string) =>
    dedent(`
      def ${name}(pedido):
          total = 0
          for item in pedido.items:
              if item.categoria == "electronica":
                  total += item.precio * item.cantidad * 0.9
              elif item.categoria == "ropa":
                  total += item.precio * item.cantidad * 0.8
              else:
                  total += item.precio * item.cantidad
          return round(total, 2)
    `);

  it('encuentra el mismo bloque en dos archivos', async () => {
    const files: Record<string, string> = { 'app/a.py': `import os\n\n${block('calcular')}`, 'app/b.py': `${block('calcular')}\n\nprint("fin")\n` };
    const artifacts = new Map<string, DuplicationArtifact>();
    for (const [rel, code] of Object.entries(files)) {
      const art = pythonDuplicationAnalyzer.analyze(fileInput(rel, code), resolveConfig()).artifact;
      if (art) artifacts.set(rel, art);
    }
    const findings = (await pythonDuplicationAnalyzer.finalize?.(artifacts, resolveConfig(), { readText: async (rel) => files[rel] ?? null, store: memoryStore() })) ?? [];
    expect(findings.map((f) => f.ruleId)).toEqual(['duplication/clone']);
    expect(findings[0]?.locations.map((l) => [l.file, l.startLine])).toEqual([
      ['app/a.py', 3],
      ['app/b.py', 1],
    ]);
    expect(findings[0]?.evidence[0]?.tool).toBe('duplication-python@1.0.0');
  });
});

describe('Python en el análisis completo', () => {
  it('cuenta las pruebas de Python y no carga el compilador de TypeScript', async () => {
    const complex = dedent(`
      def procesar(a, b, c, d, e, f):
          for x in a:
              if x:
                  for y in b:
                      if y and c:
                          while d:
                              if e or f:
                                  d = None
    `);
    const files: Record<string, string> = {
      'app/__init__.py': '',
      'app/a.py': `from . import b\n\n${complex}`,
      'app/b.py': 'from .a import procesar\n',
      ...Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`app/m${i}.py`, `VALOR = ${i}\n`])),
    };
    const repo = await createTmpRepo(files);
    repos.push(repo);
    forgetTypeScriptForTests();
    const report = await analyzeRepository(repo.root, { cacheDir: null });
    expect(isTypeScriptLoaded()).toBe(false);
    const rules = report.findings.map((f) => f.ruleId);
    expect(rules).toEqual(expect.arrayContaining(['complexity/function', 'architecture/cycle', 'testing/no-tests']));
    expect(report.coverage.find((n) => n.area === 'Complejidad y duplicación')?.detail).toContain('7 archivo(s) Python');

    const withTests = await createTmpRepo({ ...files, 'tests/test_a.py': 'def test_a():\n    assert True\n', 'app/test_b.py': 'x = 1\n' });
    repos.push(withTests);
    expect(await testingAnalyzer.analyzeProject(await projectContext(withTests.root))).toEqual([]);
  });
});
