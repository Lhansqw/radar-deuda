import { describe, expect, it } from 'vitest';
import { configHash, DEFAULT_CONFIG, resolveConfig } from '../src/config.js';

describe('resolveConfig', () => {
  it('sin cambios devuelve los valores por defecto', () => {
    expect(resolveConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('añade exclusiones a las por defecto y mezcla umbrales parciales', () => {
    const c = resolveConfig({ exclude: ['generated/**'], thresholds: { cognitive: 20 } });
    expect(c.exclude).toContain('generated/**');
    expect(c.exclude).toContain('*.min.js');
    expect(c.thresholds.cognitive).toBe(20);
    expect(c.thresholds.cyclomatic).toBe(DEFAULT_CONFIG.thresholds.cyclomatic);
  });

  it.each([
    [{ concurrency: 0 }],
    [{ concurrency: 65 }],
    [{ concurrency: 1.5 }],
    [{ maxFileSizeBytes: -1 }],
    [{ maxFileSizeBytes: 10, hardMaxFileSizeBytes: 5 }],
    [{ thresholds: { cognitive: 0 } }],
  ])('rechaza valores inválidos: %j', (overrides) => {
    expect(() => resolveConfig(overrides)).toThrow(RangeError);
  });
});

describe('configHash', () => {
  it('cambia si cambia un umbral (invalida la caché)', () => {
    const a = configHash(resolveConfig());
    const b = configHash(resolveConfig({ thresholds: { fileLines: 501 } }));
    expect(a).not.toBe(b);
  });

  it('no cambia con la concurrencia (no afecta a los resultados)', () => {
    expect(configHash(resolveConfig({ concurrency: 2 }))).toBe(configHash(resolveConfig({ concurrency: 16 })));
  });
});
