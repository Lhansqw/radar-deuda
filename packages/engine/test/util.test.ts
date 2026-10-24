import { describe, expect, it } from 'vitest';
import type { Finding } from '../src/types.js';
import { computeLineStarts, countNonBlankLines, findingId, lineAt, mapWithConcurrency, sortFindings, splitLines, toPosix } from '../src/util.js';

describe('líneas', () => {
  it('splitLines acepta \\n, \\r\\n y \\r', () => {
    expect(splitLines('a\nb\r\nc\rd')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('countNonBlankLines ignora líneas vacías o solo con espacios', () => {
    expect(countNonBlankLines(['x', '', '   ', '\t', 'y'])).toBe(2);
  });

  it('lineAt devuelve la línea (base 1) de cada posición', () => {
    const text = 'ab\r\ncd\nef';
    const starts = computeLineStarts(text);
    expect(starts).toEqual([0, 4, 7]);
    expect(lineAt(starts, 0)).toBe(1);
    expect(lineAt(starts, 3)).toBe(1);
    expect(lineAt(starts, 4)).toBe(2);
    expect(lineAt(starts, 8)).toBe(3);
  });
});

describe('findingId', () => {
  it('es estable y depende de regla, archivo y ancla', () => {
    expect(findingId('r', 'a.ts', 'x')).toBe(findingId('r', 'a.ts', 'x'));
    expect(findingId('r', 'a.ts', 'x')).not.toBe(findingId('r', 'a.ts', 'y'));
    expect(findingId('r', 'a.ts', 'x')).toHaveLength(16);
  });
});

describe('toPosix', () => {
  it('convierte separadores de Windows', () => {
    expect(toPosix('src\\a\\b.ts')).toBe('src/a/b.ts');
  });
});

describe('mapWithConcurrency', () => {
  it('nunca supera el límite de tareas simultáneas y procesa todo', async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      seen.push(n);
      active--;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('se detiene al cancelar', async () => {
    const controller = new AbortController();
    let processed = 0;
    const run = mapWithConcurrency(
      Array.from({ length: 100 }, (_, i) => i),
      2,
      async () => {
        processed++;
        if (processed === 4) controller.abort();
        await new Promise((r) => setTimeout(r, 1));
      },
      controller.signal,
    );
    await expect(run).rejects.toThrow();
    expect(processed).toBeLessThan(100);
  });
});

describe('sortFindings', () => {
  const make = (severity: Finding['severity'], file: string, line: number): Finding => ({
    id: `${file}${line}`,
    ruleId: 'r',
    category: 'size',
    severity,
    confidence: 'high',
    title: '',
    message: '',
    locations: [{ file, startLine: line, endLine: line }],
    evidence: [],
    impact: '',
    effort: { minutes: 1, rationale: '' },
  });

  it('ordena por severidad, archivo y línea', () => {
    const sorted = sortFindings([make('low', 'a.ts', 1), make('high', 'b.ts', 9), make('high', 'b.ts', 2), make('critical', 'z.ts', 1)]);
    expect(sorted.map((f) => `${f.severity}:${f.locations[0]?.file}:${f.locations[0]?.startLine}`)).toEqual([
      'critical:z.ts:1',
      'high:b.ts:2',
      'high:b.ts:9',
      'low:a.ts:1',
    ]);
  });
});
