import { beforeAll, describe, expect, it } from 'vitest';
import { loadTypeScript } from '../src/analyzers/ts-runtime.js';
import { architectureAnalyzer, extractImports, resolveImport, stronglyConnected, type ImportsArtifact } from '../src/analyzers/architecture.js';
import { getSourceFile } from '../src/analyzers/shared.js';
import { resolveConfig } from '../src/config.js';
import type { Finding } from '../src/types.js';
import { fileInput } from './helpers/file-input.js';
import { memoryStore } from './helpers/memory-store.js';

// Estas pruebas llaman a los analizadores directamente, sin el motor que carga el compilador.
beforeAll(async () => {
  await loadTypeScript();
});

const importsOf = (code: string, file = 'src/a.ts') => extractImports(getSourceFile(fileInput(file, code)));

async function analyze(files: Record<string, string>, fanOut = 20): Promise<Finding[]> {
  const artifacts = new Map<string, ImportsArtifact>();
  for (const [rel, code] of Object.entries(files)) {
    const art = architectureAnalyzer.analyze(fileInput(rel, code), resolveConfig()).artifact;
    if (art) artifacts.set(rel, art);
  }
  const finalize = architectureAnalyzer.finalize;
  if (!finalize) throw new Error('el analizador de arquitectura debe implementar finalize');
  return finalize(artifacts, resolveConfig({ thresholds: { fanOut } }), { readText: async () => null, store: memoryStore() });
}

describe('extractImports', () => {
  it('reconoce import, export…from, require e import() relativos', () => {
    const refs = importsOf(`
      import a from './a';
      import { type T } from './tipos';
      import type { U } from './u';
      export * from './reexport';
      const b = require('./b');
      const c = await import('./c');
      import ext from 'lodash';
    `);
    expect(refs.map((r) => [r.spec, r.typeOnly])).toEqual([
      ['./a', false],
      ['./tipos', true],
      ['./u', true],
      ['./reexport', false],
      ['./b', false],
      ['./c', false],
    ]);
    expect(refs[0]?.line).toBe(2);
  });
});

describe('resolveImport', () => {
  const known = new Set(['src/a.ts', 'src/util/index.ts', 'src/b.tsx', 'src/esm.ts']);
  it.each([
    ['./a', 'src/a.ts'],
    ['./util', 'src/util/index.ts'],
    ['./b', 'src/b.tsx'],
    ['./esm.js', 'src/esm.ts'], // convención ESM: se importa .js y existe .ts
    ['../src/a', 'src/a.ts'],
    ['./no-existe', null],
  ])('%s → %s', (spec, expected) => {
    expect(resolveImport('src/main.ts', spec, known)).toBe(expected);
  });
});

describe('stronglyConnected', () => {
  it('encuentra los ciclos (Tarjan)', () => {
    const graph = new Map([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a', 'd']],
      ['d', []],
    ]);
    const comps = stronglyConnected(graph).map((c) => c.sort());
    expect(comps).toContainEqual(['a', 'b', 'c']);
    expect(comps).toContainEqual(['d']);
  });

  it('no desborda la pila con cadenas muy largas', () => {
    const graph = new Map<string, string[]>();
    for (let i = 0; i < 50_000; i++) graph.set(`n${i}`, i < 49_999 ? [`n${i + 1}`] : ['n0']);
    const comps = stronglyConnected(graph);
    expect(comps).toHaveLength(1);
    expect(comps[0]).toHaveLength(50_000);
  });
});

describe('architectureAnalyzer', () => {
  it('reporta un ciclo con la línea exacta de cada importación', async () => {
    const findings = await analyze({
      'src/a.ts': "import { b } from './b';\nexport const a = 1;",
      'src/b.ts': "\n\nimport { a } from './a';\nexport const b = 2;",
      'src/c.ts': "import { a } from './a';",
    });
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f?.ruleId).toBe('architecture/cycle');
    expect(f?.locations).toEqual([
      { file: 'src/a.ts', startLine: 1, endLine: 1, symbol: '→ src/b.ts' },
      { file: 'src/b.ts', startLine: 3, endLine: 3, symbol: '→ src/a.ts' },
    ]);
  });

  it('las importaciones de solo tipos no forman ciclos', async () => {
    const findings = await analyze({
      'src/a.ts': "import type { B } from './b';\nexport interface A { b: B }",
      'src/b.ts': "import type { A } from './a';\nexport interface B { a: A }",
    });
    expect(findings).toEqual([]);
  });

  it('reporta acoplamiento eferente alto', async () => {
    const files: Record<string, string> = {};
    const imports: string[] = [];
    for (let i = 0; i < 6; i++) {
      files[`src/m${i}.ts`] = `export const v${i} = ${i};`;
      imports.push(`import { v${i} } from './m${i}';`);
    }
    files['src/orquestador.ts'] = imports.join('\n');
    const findings = await analyze(files, 5);
    expect(findings.map((f) => f.ruleId)).toEqual(['architecture/high-fan-out']);
    expect(findings[0]?.evidence[0]?.metric).toMatchObject({ name: 'fanOut', value: 6, threshold: 5 });
  });
});
