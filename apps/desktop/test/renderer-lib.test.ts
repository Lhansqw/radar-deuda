import { describe, expect, it } from 'vitest';
import type { Finding, Severity, Category } from '@radar/engine';
import { countBySeverity, EMPTY_FILTER, filterFindings, sortFindings } from '../src/renderer/lib/findings.js';
import { diffStats, fixAvailability } from '../src/renderer/lib/fix.js';
import { parseAnswer, parseInline } from '../src/renderer/lib/answer.js';
import { formatBytes, formatEffort, formatPercent, formatRelative, fold } from '../src/renderer/lib/format.js';
import { fallbackBlocked, filterCatalog, modelContext, modelPrice } from '../src/renderer/lib/catalog.js';
import { dataCollectionChange, providerChange } from '../src/renderer/lib/settings.js';
import type { CatalogModel } from '../src/shared/model.js';
import { DEFAULT_SETTINGS } from '../src/shared/settings.js';
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

  it('tamaños en disco', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1,5 KB');
    expect(formatBytes(12.34 * 1024 * 1024)).toBe('12,3 MB');
    expect(formatBytes(1.25 * 1024 ** 3)).toBe('1,25 GB');
  });
});

describe('catálogo de modelos', () => {
  const model = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({
    id,
    name: id,
    free: false,
    inputPerMTok: 0.2,
    outputPerMTok: 0.6,
    contextLength: 131072,
    structuredOutputs: true,
    reasoning: 'no',
    ...extra,
  });
  const catalog = [
    model('qwen/qwen3-coder:free', { free: true, inputPerMTok: 0, outputPerMTok: 0 }),
    model('nvidia/nemotron-nano', { name: 'NVIDIA: Nemotrón Nano', reasoning: 'obligatorio' }),
    model('meta/llama-4', { structuredOutputs: false }),
    model('openai/gpt-x', { inputPerMTok: null }),
  ];

  it('solo modelos con salida estructurada, con los filtros', () => {
    const ids = (f: Parameters<typeof filterCatalog>[1]): string[] => filterCatalog(catalog, f).map((m) => m.id);
    expect(ids({ query: '', onlyFree: false, hideMandatory: false })).toEqual(['qwen/qwen3-coder:free', 'nvidia/nemotron-nano', 'openai/gpt-x']);
    expect(ids({ query: '', onlyFree: false, hideMandatory: true })).toEqual(['qwen/qwen3-coder:free', 'openai/gpt-x']);
    expect(ids({ query: '', onlyFree: true, hideMandatory: false })).toEqual(['qwen/qwen3-coder:free']);
    // Busca en el id y en el nombre, sin tildes ni mayúsculas.
    expect(ids({ query: ' NEMOTRON ', onlyFree: false, hideMandatory: false })).toEqual(['nvidia/nemotron-nano']);
  });

  it('precio, contexto y respaldos', () => {
    expect(modelPrice(catalog[0]!)).toBe('Gratis');
    expect(modelPrice(catalog[1]!)).toBe('0,2 / 0,6');
    expect(modelPrice(catalog[3]!)).toBe('—');
    expect(modelContext(catalog[0]!)).toBe('131k');
    expect(modelContext(model('x/y', { contextLength: null }))).toBe('—');
    expect(fallbackBlocked('a/b', 'a/b', [])).toBe('Es el modelo elegido');
    expect(fallbackBlocked('c/d', 'a/b', ['c/d'])).toBe('Ya es un respaldo');
    expect(fallbackBlocked('e/f', 'a/b', ['1/1', '2/2', '3/3'])).toBe('Como mucho 3 respaldos');
    expect(fallbackBlocked('e/f', 'a/b', ['1/1'])).toBeNull();
  });
});

describe('ajustes de la IA', () => {
  const ai = { ...DEFAULT_SETTINGS.ai, model: 'qwen/qwen3-coder:free', fallbackModels: ['x/y'] };

  it('cambiar de proveedor olvida el modelo y deja «solo en este equipo» si ya no es local', () => {
    expect(providerChange(ai, 'anthropic')).toEqual({ provider: 'anthropic', model: '', fallbackModels: [] });
    expect(providerChange({ ...ai, provider: 'ollama', privacy: 'local' }, 'openrouter')).toEqual({ provider: 'openrouter', model: '', fallbackModels: [], privacy: 'auto' });
    expect(providerChange({ ...ai, provider: 'ollama', privacy: 'local' }, 'lmstudio')).toEqual({ provider: 'lmstudio', model: '', fallbackModels: [] });
  });

  it('permitir que guarden datos desactiva la retención cero', () => {
    expect(dataCollectionChange(true)).toEqual({ allowDataCollection: true, zeroDataRetention: false });
    expect(dataCollectionChange(false)).toEqual({ allowDataCollection: false });
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
    // Solo la deuda nueva; sin análisis anterior, el filtro no oculta nada.
    const nuevo = list[1]?.id ?? '';
    expect(filterFindings(list, { ...EMPTY_FILTER, onlyNew: true }, new Set([nuevo])).map((x) => x.id)).toEqual([nuevo]);
    expect(filterFindings(list, { ...EMPTY_FILTER, onlyNew: true })).toHaveLength(4);
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
