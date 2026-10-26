import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AiResponseCache } from '../src/cache.js';
import { BudgetExceededError, costOf, createLimiter, estimateTokens, priceFor, UsageTracker } from '../src/usage.js';

const haiku = { providerId: 'anthropic', locality: 'cloud' as const, model: 'claude-haiku-5-5' };
const local = { providerId: 'lmstudio', locality: 'local' as const, model: 'qwen' };
const unknown = { providerId: 'openai', locality: 'cloud' as const, model: 'x' };

describe('precios', () => {
  it('local cuesta 0, Anthropic según la tabla, otros desconocido', () => {
    expect(priceFor('lmstudio', 'local', 'x')).toEqual({ inputPerMTok: 0, outputPerMTok: 0 });
    expect(priceFor('anthropic', 'cloud', 'claude-sonnet-5-5')).toEqual({ inputPerMTok: 2, outputPerMTok: 10 });
    expect(priceFor('openai', 'cloud', 'cualquiera')).toBeNull();
  });

  it('aplica el tramo de prompt largo de Haiku 5.5', () => {
    const p = priceFor('anthropic', 'cloud', 'claude-haiku-5-5');
    if (!p) throw new Error('sin precio');
    expect(costOf(p, 1_000_000, 0)).toBeCloseTo(0.5); // > 100 K: 0,50 USD/MTok
    expect(costOf(p, 100_000, 1_000_000)).toBeCloseTo(0.01 + 0.5);
  });

  it('estimateTokens es conservadora', () => {
    expect(estimateTokens('a'.repeat(300))).toBe(100);
  });
});

describe('UsageTracker', () => {
  it('rechaza ANTES de enviar si el peor caso supera el presupuesto', () => {
    const t = new UsageTracker({ maxOutputTokens: 1000 });
    const release = t.reserve(local, 100, 800);
    expect(() => t.reserve(local, 100, 300)).toThrow(BudgetExceededError); // 800 reservados + 300 > 1000
    release();
    expect(() => t.reserve(local, 100, 300)).not.toThrow();
  });

  it('limita el coste solo cuando el precio es conocido', () => {
    const t = new UsageTracker({ maxCostUsd: 0.001 });
    expect(() => t.reserve(haiku, 5_000, 1_000)).not.toThrow(); // 0,0005 + 0,0005 = 0,001
    expect(() => t.reserve(haiku, 5_000, 1_000)).toThrow(/0.00 USD|presupuesto/);
    expect(() => t.reserve(unknown, 1_000_000, 1_000_000)).not.toThrow();
  });

  it('usa el coste informado por el proveedor y los precios dinámicos para el presupuesto', () => {
    const t = new UsageTracker({ maxCostUsd: 0.01 });
    const ref = { providerId: 'openrouter', locality: 'cloud' as const, model: 'x/y' };
    t.setPrice(ref, { inputPerMTok: 1000, outputPerMTok: 1000 }); // muy caro: 0,001 USD por token
    expect(() => t.reserve(ref, 100, 100)).toThrow(BudgetExceededError); // 0,2 USD > 0,01
    t.record(ref, { inputTokens: 10, outputTokens: 10 }, 10, 1, 0.0042);
    expect(t.summary().costUsd).toBe(0.0042); // el informado, no el calculado (0,02)
  });

  it('limita el número de peticiones', () => {
    const t = new UsageTracker({ maxRequests: 1 });
    t.reserve(local, 1, 1);
    expect(() => t.reserve(local, 1, 1)).toThrow(/1 peticiones/);
  });

  it('resume consumo real, coste y latencias; coste null si algún proveedor no tiene precio', () => {
    const t = new UsageTracker();
    t.record(haiku, { inputTokens: 10_000, outputTokens: 2_000 }, 9_000, 800);
    t.record(local, null, 500, 3_000);
    t.recordCacheHit();
    expect(t.summary()).toEqual({ requests: 2, cacheHits: 1, inputTokens: 10_500, outputTokens: 2_000, costUsd: 0.002, latencyMsTotal: 3800, latencyMsMax: 3000 });
    t.record(unknown, { inputTokens: 1, outputTokens: 1 }, 1, 1);
    expect(t.summary().costUsd).toBeNull();
  });
});

describe('createLimiter', () => {
  it('nunca ejecuta más tareas simultáneas que el límite', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });
});

describe('AiResponseCache', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('guarda y recupera por clave de contenido; la clave cambia con cualquier parte', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'radar-ai-cache-'));
    dirs.push(dir);
    const cache = new AiResponseCache(dir);
    const k = AiResponseCache.key(['v1', 'lmstudio', 'qwen', 'contexto']);
    expect(AiResponseCache.key(['v1', 'lmstudio', 'qwen', 'contexto modificado'])).not.toBe(k);
    expect(await cache.get(k)).toBeUndefined();
    await cache.set(k, { resumen: 'x' });
    expect(await new AiResponseCache(dir).get(k)).toEqual({ resumen: 'x' });
    expect(await new AiResponseCache(null).get(k)).toBeUndefined();
    expect(await cache.get('../../etc/passwd')).toBeUndefined();
  });
});
