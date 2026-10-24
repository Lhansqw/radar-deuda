import { describe, expect, it } from 'vitest';
import { collectFunctionMetrics, complexityAnalyzer } from '../src/analyzers/complexity.js';
import { resolveConfig } from '../src/config.js';
import { fileInput } from './helpers/file-input.js';

const metricsOf = (code: string, file = 'a.ts') => collectFunctionMetrics(code, file);
const only = (code: string) => {
  const [m] = metricsOf(code);
  if (!m) throw new Error('no se encontró ninguna función');
  return m;
};

describe('complejidad cognitiva (ejemplos del artículo de SonarSource)', () => {
  it('sumOfPrimes: cognitiva 7, ciclomática 4', () => {
    const m = only(`
      function sumOfPrimes(max: number): number {
        let total = 0;
        OUT: for (let i = 1; i <= max; ++i) {
          for (let j = 2; j < i; ++j) {
            if (i % j === 0) {
              continue OUT;
            }
          }
          total += i;
        }
        return total;
      }`);
    expect(m.cognitive).toBe(7);
    expect(m.cyclomatic).toBe(4);
    expect(m.maxNesting).toBe(3);
  });

  it('getWords: un switch suma 1 a la cognitiva aunque tenga muchos casos', () => {
    const m = only(`
      function getWords(n: number): string {
        switch (n) {
          case 1: return 'one';
          case 2: return 'a couple';
          case 3: return 'a few';
          default: return 'lots';
        }
      }`);
    expect(m.cognitive).toBe(1);
    expect(m.cyclomatic).toBe(4);
  });

  it('las secuencias de operadores lógicos suman por cada cambio de operador', () => {
    expect(only('function f(a, b, c, d) { return a && b && c; }').cognitive).toBe(1);
    expect(only('function f(a, b, c, d) { return a && b || c && d; }').cognitive).toBe(3);
    expect(only('function f(a, b) { return a ?? b; }').cyclomatic).toBe(2);
  });

  it('else if y else no acumulan anidamiento', () => {
    const m = only(`
      function f(x: number) {
        if (x > 0) { return 1; }
        else if (x < 0) { return -1; }
        else { return 0; }
      }`);
    expect(m.cognitive).toBe(3);
    expect(m.cyclomatic).toBe(3);
  });

  it('try no suma pero catch sí, con anidamiento', () => {
    const m = only(`
      function f() {
        try { if (a) { b(); } } catch (e) { if (c) { d(); } }
      }`);
    // if dentro de try: 1 + 1 (anidado) · catch: 1 · if dentro de catch: 1 + 1
    expect(m.cognitive).toBe(5);
  });
});

describe('collectFunctionMetrics', () => {
  it('mide funciones anidadas por separado sin sumarlas a la exterior', () => {
    const metrics = metricsOf(`
      export function exterior() {
        const interior = () => {
          if (a) { if (b) { return 1; } }
          return 0;
        };
        return interior();
      }`);
    const ext = metrics.find((m) => m.name === 'exterior');
    const int = metrics.find((m) => m.name === 'interior');
    expect(ext?.cognitive).toBe(0);
    expect(int?.cognitive).toBe(3);
    expect(ext?.lines).toBeLessThan(5);
  });

  it('nombra métodos, constructores, propiedades y funciones anónimas', () => {
    const names = metricsOf(`
      class Pedido {
        constructor() {}
        total() { return 1; }
        get id() { return 'x'; }
      }
      const obj = { calcular: function () { return 2; } };
      export default () => 3;
      [1].map(function () { return 4; });
    `).map((m) => m.name);
    expect(names).toEqual(['Pedido.constructor', 'Pedido.total', 'Pedido.id', 'calcular', 'default', '<anónima>']);
  });

  it('analiza JSX en archivos .tsx', () => {
    const [m] = metricsOf('export function Vista({ ok }) { return ok ? <div>sí</div> : <span>no</span>; }', 'vista.tsx');
    expect(m?.cognitive).toBe(1);
  });
});

describe('complexityAnalyzer', () => {
  it('reporta una función compleja con todas sus métricas como evidencia', () => {
    const code = `
      function procesar(a, b, c, d, e, f) {
        for (const x of a) {
          if (x) {
            if (b) {
              if (c) {
                if (d) {
                  while (e) { if (f) { break; } }
                }
              }
            }
          }
        }
      }`;
    const { findings } = complexityAnalyzer.analyze(fileInput('src/p.ts', code), resolveConfig());
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f?.ruleId).toBe('complexity/function');
    expect(f?.locations[0]).toMatchObject({ file: 'src/p.ts', startLine: 2, symbol: 'procesar' });
    const metrics = f?.evidence.map((e) => e.metric?.name);
    expect(metrics).toEqual(expect.arrayContaining(['cognitive', 'nesting', 'parameters']));
    expect(f?.effort.minutes).toBeGreaterThan(15);
    expect(f?.effort.rationale).toMatch(/min base/);
  });

  it('un switch largo y plano no es un hallazgo por sí solo', () => {
    const cases = Array.from({ length: 30 }, (_, i) => `case ${i}: return ${i};`).join('\n');
    const { findings } = complexityAnalyzer.analyze(fileInput('a.ts', `function f(x) { switch (x) { ${cases} } }`), resolveConfig());
    expect(findings).toEqual([]);
  });

  it('identificadores estables aunque haya funciones homónimas', () => {
    const body = 'if (a) { if (b) { if (c) { if (d) { if (e) { x(); } } } } }';
    const code = `const o1 = { run() { ${body} } };\nconst o2 = { run() { ${body} } };`;
    const config = resolveConfig({ thresholds: { cognitive: 5 } });
    const ids = complexityAnalyzer.analyze(fileInput('a.ts', code), config).findings.map((f) => f.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
