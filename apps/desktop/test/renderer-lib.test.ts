import { describe, expect, it } from 'vitest';
import type { Finding, Severity, Category } from '@radar/engine';
import { countBySeverity, EMPTY_FILTER, filterFindings, sortFindings } from '../src/renderer/lib/findings.js';
import { diffStats, fixAvailability } from '../src/renderer/lib/fix.js';
import { parseAnswer, parseInline } from '../src/renderer/lib/answer.js';
import { formatEffort, formatPercent, formatRelative, fold } from '../src/renderer/lib/format.js';
import { layoutRadar, RADAR_RINGS } from '../src/renderer/lib/radar.js';
import { buildTree, flattenTree } from '../src/renderer/lib/tree.js';
import { visibleRange } from '../src/renderer/lib/virtual.js';

let n = 0;
function f(severity: Severity, file: string, extra: Partial<Finding> = {}): Finding {
  n++;
  return {
    id: `id${n}`,
    ruleId: 'complexity/cognitive',
    category: 'complexity',
    severity,
    confidence: 'high',
    title: `Hallazgo ${n}`,
    message: 'Función difícil de mantener',
    locations: [{ file, startLine: n, endLine: n + 2 }],
    evidence: [],
    impact: '',
    effort: { minutes: 10 * n, rationale: '' },
    ...extra,
  };
}

describe('formato', () => {
  it('esfuerzo, porcentajes y tiempo relativo en español', () => {
    expect(formatEffort(45)).toBe('45 min');
    expect(formatEffort(498)).toBe('8,3 h');
    expect(formatEffort(60 * 50)).toBe('6,3 d');
    expect(formatPercent(0.168)).toBe('16,8 %');
    const now = new Date('2026-10-26T12:00:00Z');
    expect(formatRelative('2026-10-26T11:59:40Z', now)).toBe('hace un momento');
    expect(formatRelative('2026-10-26T11:55:00Z', now)).toBe('hace 5 min');
    expect(formatRelative('2026-10-25T10:00:00Z', now)).toBe('ayer');
    expect(formatRelative('2026-10-22T10:00:00Z', now)).toBe('hace 4 días');
    expect(fold('Función CRÍTICA')).toBe('funcion critica');
  });
});

describe('hallazgos', () => {
  const list = [
    f('low', 'src/a.ts'),
    f('critical', 'src/clientes/registro.ts', { category: 'security', title: 'Posible secreto', ruleId: 'security/secret/generic' }),
    f('high', 'src/pedidos/procesarPedido.ts', { locations: [{ file: 'src/pedidos/procesarPedido.ts', startLine: 12, endLine: 46, symbol: 'procesarPedido' }] }),
    f('info', 'README.md'),
  ];

  it('filtra por severidad, categoría, carpeta y texto (sin tildes ni mayúsculas)', () => {
    expect(filterFindings(list, EMPTY_FILTER)).toHaveLength(4);
    expect(filterFindings(list, { ...EMPTY_FILTER, severities: new Set(['critical', 'high']) }).map((x) => x.severity)).toEqual(['critical', 'high']);
    expect(filterFindings(list, { ...EMPTY_FILTER, categories: new Set<Category>(['security']) })).toHaveLength(1);
    expect(filterFindings(list, { ...EMPTY_FILTER, path: 'src/clientes' })).toHaveLength(1);
    expect(filterFindings(list, { ...EMPTY_FILTER, path: 'src/a.ts' })).toHaveLength(1);
    expect(filterFindings(list, { ...EMPTY_FILTER, path: 'src/a' })).toHaveLength(0); // no confunde src/a con src/a.ts
    expect(filterFindings(list, { ...EMPTY_FILTER, text: 'PROCESARpedido' })).toHaveLength(1);
    expect(filterFindings(list, { ...EMPTY_FILTER, text: 'funcion dificil' })).toHaveLength(4);
  });

  it('ordena por severidad, esfuerzo o archivo', () => {
    expect(sortFindings(list, 'severity').map((x) => x.severity)).toEqual(['critical', 'high', 'low', 'info']);
    expect(sortFindings(list, 'effort')[0]?.effort.minutes).toBe(Math.max(...list.map((x) => x.effort.minutes)));
    expect(sortFindings(list, 'file').map((x) => x.locations[0]?.file)).toEqual(['README.md', 'src/a.ts', 'src/clientes/registro.ts', 'src/pedidos/procesarPedido.ts']);
    expect(countBySeverity(list)).toEqual({ critical: 1, high: 1, medium: 0, low: 1, info: 1 });
  });
});

describe('árbol de archivos', () => {
  it('acumula la deuda por carpeta, compacta carpetas de un solo hijo y ordena por esfuerzo', () => {
    const a = f('high', 'src/pedidos/x.ts');
    const b = f('low', 'src/pedidos/y.ts');
    const c = f('critical', 'lib/solo/profundo/z.ts');
    const root = buildTree([a, b, c]);
    expect(root.findings).toBe(3);
    expect(root.minutes).toBe(a.effort.minutes + b.effort.minutes + c.effort.minutes);
    // Compactadas, y primero la que acumula más esfuerzo (src/pedidos suma dos hallazgos).
    expect(root.children.map((x) => [x.name, x.minutes])).toEqual([
      ['src/pedidos', a.effort.minutes + b.effort.minutes],
      ['lib/solo/profundo', c.effort.minutes],
    ]);
    expect(root.children[1]).toMatchObject({ path: 'lib/solo/profundo', worst: 'critical', findings: 1 });
    expect(root.children[0]?.worst).toBe('high');
    const rows = flattenTree(root, new Set(['src/pedidos']));
    expect(rows.map((r) => [r.node.name, r.depth])).toEqual([
      ['src/pedidos', 0],
      ['y.ts', 1],
      ['x.ts', 1],
      ['lib/solo/profundo', 0],
    ]);
  });
});

describe('radar', () => {
  it('coloca cada hallazgo en su sector y anillo, de forma determinista, y no dibuja los informativos', () => {
    const list = [f('critical', 'a.ts', { category: 'security' }), f('low', 'b.ts', { category: 'testing' }), f('info', 'c.ts'), f('medium', 'd.ts')];
    const a = layoutRadar(list, 400);
    const b = layoutRadar([...list].reverse(), 400);
    expect(a.blips).toHaveLength(3);
    expect(a.info).toBe(1);
    expect(a.blips.map((x) => [x.findingId, x.x, x.y]).sort()).toEqual(b.blips.map((x) => [x.findingId, x.x, x.y]).sort());
    for (const blip of a.blips) {
      const dist = Math.hypot(blip.x - a.center, blip.y - a.center);
      const ring = a.rings.find((r) => r.severity === blip.severity);
      expect(dist).toBeGreaterThanOrEqual(ring?.inner ?? 0);
      expect(dist).toBeLessThanOrEqual(ring?.outer ?? 0);
      const angle = (Math.atan2(blip.x - a.center, a.center - blip.y) + 2 * Math.PI) % (2 * Math.PI);
      const sector = a.sectors.find((s) => s.category === blip.category);
      expect(angle).toBeGreaterThanOrEqual(sector?.start ?? 0);
      expect(angle).toBeLessThanOrEqual(sector?.end ?? 0);
    }
    expect(a.rings.map((r) => r.severity)).toEqual([...RADAR_RINGS]);
    expect(a.sectors.find((s) => s.category === 'security')?.count).toBe(1);
  });

  it('agrupa lo que no cabe en una celda y los puntos no se superponen', () => {
    const many = Array.from({ length: 14 }, () => f('low', 'x.ts'));
    const r = layoutRadar(many, 420, 10);
    expect(r.blips).toHaveLength(10);
    expect(r.overflow).toEqual([expect.objectContaining({ category: 'complexity', severity: 'low', extra: 4 })]);
    const minDist = Math.min(...r.blips.flatMap((p, i) => r.blips.slice(i + 1).map((q) => Math.hypot(p.x - q.x, p.y - q.y))));
    expect(minDist).toBeGreaterThan(8);
  });
});

describe('lista virtual', () => {
  it('calcula las filas visibles con margen', () => {
    expect(visibleRange(0, 300, 30, 1000)).toEqual({ start: 0, end: 16, offsetTop: 0, totalHeight: 30000 });
    expect(visibleRange(3000, 300, 30, 1000, 2)).toEqual({ start: 98, end: 112, offsetTop: 2940, totalHeight: 30000 });
    expect(visibleRange(0, 300, 30, 3)).toEqual({ start: 0, end: 3, offsetTop: 0, totalHeight: 90 });
  });
});

describe('propuestas de corrección', () => {
  it('solo se ofrecen para hallazgos con líneas de código y nunca para secretos', () => {
    expect(fixAvailability(f('high', 'src/a.ts'))).toBe('available');
    expect(fixAvailability(f('high', 'src/a.ts', { category: 'security' }))).toBe('secret');
    expect(fixAvailability(f('medium', '.', { locations: [{ file: '.', startLine: 0, endLine: 0 }] }))).toBe('no-code');
  });

  it('cuenta líneas añadidas, eliminadas y archivos', () => {
    const line = (kind: 'context' | 'removed' | 'added') => ({ kind, text: '', oldLine: null, newLine: null });
    const hunk = (file: string, kinds: Array<'context' | 'removed' | 'added'>) => ({ file, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: kinds.map(line) });
    expect(diffStats([hunk('a.ts', ['context', 'removed', 'removed', 'added']), hunk('a.ts', ['added']), hunk('b.ts', ['removed'])])).toEqual({ added: 2, removed: 3, files: 2 });
  });
});

describe('respuestas de la IA', () => {
  it('párrafos, listas con guiones o numeradas, negrita y referencias', () => {
    expect(parseInline('Empieza por [H2] y **luego** [H1, H5]; [nota] no es referencia.')).toEqual([
      { kind: 'text', text: 'Empieza por ' },
      { kind: 'ref', alias: 'H2' },
      { kind: 'text', text: ' y ' },
      { kind: 'strong', text: 'luego' },
      { kind: 'text', text: ' ' },
      { kind: 'ref', alias: 'H1' },
      { kind: 'ref', alias: 'H5' },
      { kind: 'text', text: '; ' },
      { kind: 'text', text: '[nota]' },
      { kind: 'text', text: ' no es referencia.' },
    ]);
    const blocks = parseAnswer('Primero esto.\nY esto.\n\n- uno\n* dos\n\n1. a\n2) b\n\n\n');
    expect(blocks.map((b) => b.kind)).toEqual(['p', 'ul', 'ol']);
    expect(blocks[0]).toEqual({ kind: 'p', lines: [[{ kind: 'text', text: 'Primero esto.' }], [{ kind: 'text', text: 'Y esto.' }]] });
    expect(blocks[1]).toEqual({ kind: 'ul', items: [[{ kind: 'text', text: 'uno' }], [{ kind: 'text', text: 'dos' }]] });
    // El texto nunca se interpreta como HTML: llega tal cual a React, que lo escapa.
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([{ kind: 'text', text: '<img src=x onerror=alert(1)>' }]);
  });
});
