import { describe, expect, it } from 'vitest';
import { findFindingByRef, findingRefs } from '../src/refs.js';
import type { Finding, Severity } from '../src/types.js';

const f = (id: string, severity: Severity, minutes: number): Finding =>
  ({ id, severity, effort: { minutes, rationale: '' }, locations: [], evidence: [], title: id }) as unknown as Finding;

describe('referencias de hallazgos', () => {
  const list = [f('aaaa1111', 'low', 5), f('bbbb2222', 'high', 10), f('cccc3333', 'high', 60), f('cccc4444', 'medium', 5)];

  it('H1 es el más grave; a igual severidad, el de más esfuerzo; estables', () => {
    expect([...findingRefs(list)]).toEqual([
      ['cccc3333', 'H1'],
      ['bbbb2222', 'H2'],
      ['cccc4444', 'H3'],
      ['aaaa1111', 'H4'],
    ]);
    expect([...findingRefs([...list].reverse())]).toEqual([...findingRefs(list)]);
  });

  it('por referencia, por identificador o por un prefijo no ambiguo de 6 caracteres o más', () => {
    expect(findFindingByRef(list, 'h2')?.id).toBe('bbbb2222');
    expect(findFindingByRef(list, ' H4 ')?.id).toBe('aaaa1111');
    expect(findFindingByRef(list, 'H9')).toBeNull();
    expect(findFindingByRef(list, 'cccc4444')?.id).toBe('cccc4444');
    expect(findFindingByRef(list, 'bbbb22')?.id).toBe('bbbb2222');
    expect(findFindingByRef(list, 'cccc')).toBeNull();
    expect(findFindingByRef(list, 'cccc33')?.id).toBe('cccc3333');
    expect(findFindingByRef(list, 'cccc3')).toBeNull();
  });
});
