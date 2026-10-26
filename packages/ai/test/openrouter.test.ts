import { describe, expect, it } from 'vitest';
import { OpenRouterProvider } from '../src/providers/openrouter.js';
import { fakeFetch, json, noSleep, type FakeCall } from './helpers/fake-fetch.js';

const req = { model: 'proveedor/modelo', system: 's', messages: [{ role: 'user' as const, content: 'hola' }], maxOutputTokens: 300, jsonSchema: { name: 'x', schema: { type: 'object' } } };
const plain = { model: req.model, system: req.system, messages: req.messages, maxOutputTokens: req.maxOutputTokens };
const ok = (extra: object = {}) => json({ model: 'proveedor/modelo', choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10, cost: 0.00042 }, ...extra });
const body = (call: FakeCall | undefined) => JSON.parse(String(call?.init?.body)) as Record<string, unknown>;

describe('OpenRouterProvider', () => {
  it('usa la API compatible con OpenAI, no permite retención de datos y exige salida estructurada', async () => {
    const fetch = fakeFetch(() => ok());
    const p = new OpenRouterProvider({ apiKey: 'sk-or-prueba', fetch });
    const r = await p.complete(req);
    const call = fetch.calls[0];
    const headers = call?.init?.headers as Record<string, string>;
    expect(call?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(headers['authorization']).toBe('Bearer sk-or-prueba');
    expect(headers['X-Title']).toBe('Radar de Deuda Tecnica');
    expect(body(call)).toMatchObject({ model: 'proveedor/modelo', max_completion_tokens: 300, provider: { data_collection: 'deny', require_parameters: true }, response_format: { type: 'json_schema' } });
    expect(r).toMatchObject({ costUsd: 0.00042, usage: { inputTokens: 50, outputTokens: 10 } });
    expect(p.locality).toBe('cloud');
  });

  it('opcionalmente solo endpoints de retención cero, o permitiendo retención si el usuario lo acepta', async () => {
    const fetch = fakeFetch(() => ok());
    await new OpenRouterProvider({ apiKey: 'k', fetch, zeroDataRetention: true }).complete(req);
    await new OpenRouterProvider({ apiKey: 'k', fetch, allowDataCollection: true }).complete(plain);
    expect(body(fetch.calls[0])['provider']).toEqual({ data_collection: 'deny', zdr: true, require_parameters: true });
    expect(body(fetch.calls[1])['provider']).toEqual({ data_collection: 'allow' });
  });

  it('si ningún endpoint soporta salida estructurada, repite sin exigirla (manteniendo la privacidad)', async () => {
    let n = 0;
    const fetch = fakeFetch(() => (++n === 1 ? json({ error: { code: 404, message: 'No endpoints found that can handle the requested parameters.' } }, 404) : ok()));
    await new OpenRouterProvider({ apiKey: 'k', fetch }).complete(req);
    expect(fetch.calls).toHaveLength(2);
    const second = body(fetch.calls[1]);
    expect(second['response_format']).toBeUndefined();
    expect(second['provider']).toEqual({ data_collection: 'deny' });
  });

  it('explica cuando ningún proveedor cumple las restricciones de privacidad', async () => {
    const fetch = fakeFetch(() => json({ error: { code: 404, message: 'No endpoints found matching your data policy.' } }, 404));
    await expect(new OpenRouterProvider({ apiKey: 'k', fetch, retries: 0, sleep: noSleep }).complete(plain)).rejects.toThrow(/no guardar datos.*--ai-allow-data-collection/);
  });

  it('créditos insuficientes (402) se informan como cuota y sin la clave', async () => {
    const fetch = fakeFetch(() => json({ error: { code: 402, message: 'Insufficient credits' } }, 402));
    const err = await new OpenRouterProvider({ apiKey: 'sk-or-SECRETA', fetch, retries: 0 }).complete(req).then(() => null, (e: unknown) => e as Error & { kind: string });
    expect(err?.kind).toBe('quota');
    expect(err?.message).toMatch(/créditos insuficientes/);
    expect(err?.message).not.toContain('sk-or-SECRETA');
  });

  it('obtiene el precio publicado del modelo (USD por token → por millón) y lo reutiliza', async () => {
    const fetch = fakeFetch(() => json({ data: [{ id: 'proveedor/modelo', pricing: { prompt: '0.0000003', completion: '0.0000012' } }, { id: 'otro/gratis:free', pricing: { prompt: '0', completion: '0' } }] }));
    const p = new OpenRouterProvider({ apiKey: 'k', fetch });
    const price = await p.price('proveedor/modelo');
    expect(price?.inputPerMTok).toBeCloseTo(0.3);
    expect(price?.outputPerMTok).toBeCloseTo(1.2);
    expect(await p.price('otro/gratis:free')).toEqual({ inputPerMTok: 0, outputPerMTok: 0 });
    expect(await p.price('no/existe')).toBeNull();
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.url).toBe('https://openrouter.ai/api/v1/models');
  });

  it('valida el formato del id de modelo y exige la clave', () => {
    expect(OpenRouterProvider.isValidModelId('anthropic/claude-haiku-5.5')).toBe(true);
    expect(OpenRouterProvider.isValidModelId('qwen/qwen3-coder:free')).toBe(true);
    expect(OpenRouterProvider.isValidModelId('solo-un-nombre')).toBe(false);
    expect(OpenRouterProvider.isValidModelId('../../x')).toBe(false);
    expect(() => new OpenRouterProvider({ apiKey: '' })).toThrow(/RADAR_OPENROUTER_API_KEY/);
  });
});
