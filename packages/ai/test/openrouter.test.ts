import { describe, expect, it } from 'vitest';
import { OpenRouterProvider } from '../src/providers/openrouter.js';
import { fakeFetch, json, noSleep, type FakeCall } from './helpers/fake-fetch.js';
import { FAKE_KEYS } from './helpers/keys.js';

const KEY = FAKE_KEYS.openrouter;

const req = { model: 'proveedor/modelo', system: 's', messages: [{ role: 'user' as const, content: 'hola' }], maxOutputTokens: 300, jsonSchema: { name: 'x', schema: { type: 'object' } } };
const plain = { model: req.model, system: req.system, messages: req.messages, maxOutputTokens: req.maxOutputTokens };
const ok = (extra: object = {}) => json({ model: 'proveedor/modelo', choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10, cost: 0.00042 }, ...extra });
const body = (call: FakeCall | undefined) => JSON.parse(String(call?.init?.body)) as Record<string, unknown>;
/** Responde al catálogo (/models) con `catalog` y a las consultas con `chat`. */
const route = (chat: () => Response, catalog: object[] = []) => (url: string) => (url.endsWith('/models') ? json({ data: catalog }) : chat());
const chats = (fetch: { calls: FakeCall[] }) => fetch.calls.filter((c) => c.url.endsWith('/chat/completions'));

describe('OpenRouterProvider', () => {
  it('usa la API compatible con OpenAI, no permite retención de datos y exige salida estructurada', async () => {
    const fetch = fakeFetch(route(() => ok()));
    const p = new OpenRouterProvider({ apiKey: KEY, fetch });
    const r = await p.complete(req);
    const call = chats(fetch)[0];
    const headers = call?.init?.headers as Record<string, string>;
    expect(call?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(headers['X-Title']).toBe('Radar de Deuda Tecnica');
    expect(body(call)).toMatchObject({ model: 'proveedor/modelo', max_completion_tokens: 300, provider: { data_collection: 'deny', require_parameters: true }, response_format: { type: 'json_schema' } });
    expect(r).toMatchObject({ costUsd: 0.00042, usage: { inputTokens: 50, outputTokens: 10 } });
    expect(p.locality).toBe('cloud');
  });

  it('informa de los tokens dedicados a razonar', async () => {
    const fetch = fakeFetch(() => ok({ usage: { prompt_tokens: 50, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 850 } } }));
    const r = await new OpenRouterProvider({ apiKey: KEY, fetch }).complete(req);
    expect(r.usage).toEqual({ inputTokens: 50, outputTokens: 900, reasoningTokens: 850 });
  });

  it('opcionalmente solo endpoints de retención cero, o permitiendo retención si el usuario lo acepta', async () => {
    const fetch = fakeFetch(route(() => ok()));
    await new OpenRouterProvider({ apiKey: KEY, fetch, zeroDataRetention: true }).complete(req);
    await new OpenRouterProvider({ apiKey: KEY, fetch, allowDataCollection: true }).complete(plain);
    expect(body(chats(fetch)[0])['provider']).toEqual({ data_collection: 'deny', zdr: true, require_parameters: true });
    expect(body(chats(fetch)[1])['provider']).toEqual({ data_collection: 'allow' });
  });

  it('si ningún endpoint soporta salida estructurada, repite sin exigirla (manteniendo la privacidad)', async () => {
    let n = 0;
    const fetch = fakeFetch(route(() => (++n === 1 ? json({ error: { code: 404, message: 'No endpoints found that can handle the requested parameters.' } }, 404) : ok())));
    await new OpenRouterProvider({ apiKey: KEY, fetch }).complete(req);
    expect(chats(fetch)).toHaveLength(2);
    const second = body(chats(fetch)[1]);
    expect(second['response_format']).toBeUndefined();
    expect(second['provider']).toEqual({ data_collection: 'deny' });
  });

  it('explica cuando ningún proveedor cumple las restricciones de privacidad', async () => {
    const fetch = fakeFetch(() => json({ error: { code: 404, message: 'No endpoints found matching your data policy.' } }, 404));
    await expect(new OpenRouterProvider({ apiKey: KEY, fetch, retries: 0, sleep: noSleep }).complete(plain)).rejects.toThrow(/no guardar datos.*--ai-allow-data-collection/);
  });

  it('créditos insuficientes (402) se informan como cuota y sin la clave', async () => {
    const fetch = fakeFetch(() => json({ error: { code: 402, message: 'Insufficient credits' } }, 402));
    const err = await new OpenRouterProvider({ apiKey: KEY, fetch, retries: 0 }).complete(req).then(() => null, (e: unknown) => e as Error & { kind: string });
    expect(err?.kind).toBe('quota');
    expect(err?.message).toMatch(/créditos insuficientes/);
    expect(err?.message).not.toContain(KEY);
  });

  it('obtiene el precio publicado del modelo (USD por token → por millón) y lo reutiliza', async () => {
    const fetch = fakeFetch(() => json({ data: [{ id: 'proveedor/modelo', pricing: { prompt: '0.0000003', completion: '0.0000012' } }, { id: 'otro/gratis:free', pricing: { prompt: '0', completion: '0' } }] }));
    const p = new OpenRouterProvider({ apiKey: KEY, fetch });
    const price = await p.price('proveedor/modelo');
    expect(price?.inputPerMTok).toBeCloseTo(0.3);
    expect(price?.outputPerMTok).toBeCloseTo(1.2);
    expect(await p.price('otro/gratis:free')).toEqual({ inputPerMTok: 0, outputPerMTok: 0 });
    expect(await p.price('no/existe')).toBeNull();
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.url).toBe('https://openrouter.ai/api/v1/models');
  });

  it('interpreta el catálogo: precio, gratuidad, salida estructurada y razonamiento', async () => {
    const fetch = fakeFetch(() =>
      json({
        data: [
          { id: 'a/razona', name: 'Razona', context_length: 128000, pricing: { prompt: '0', completion: '0' }, top_provider: { max_completion_tokens: 8192 }, supported_parameters: ['reasoning', 'structured_outputs'], reasoning: { mandatory: true, supported_efforts: ['high', 'low'] } },
          { id: 'b/simple', pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: ['temperature'] },
          { name: 'sin id' },
        ],
      }),
    );
    const p = new OpenRouterProvider({ apiKey: KEY, fetch });
    const [m1, m2] = await Promise.all([p.model('a/razona'), p.model('b/simple')]); // una sola descarga compartida
    expect(fetch.calls).toHaveLength(1);
    expect(m1).toMatchObject({ name: 'Razona', contextLength: 128000, maxCompletionTokens: 8192, free: true, structuredOutputs: true, reasoning: { mandatory: true, defaultEnabled: true, supportedEfforts: ['high', 'low'] } });
    expect(m2).toMatchObject({ name: 'b/simple', free: false, structuredOutputs: false, reasoning: null, maxCompletionTokens: null });
    expect(await p.models()).toHaveLength(2);
  });

  it('si el catálogo no se puede descargar, se vuelve a intentar en la siguiente consulta', async () => {
    let n = 0;
    const fetch = fakeFetch(() => (++n <= 2 ? json({ error: 'caído' }, 503) : json({ data: [{ id: 'a/b', pricing: { prompt: '0', completion: '0' } }] })));
    const p = new OpenRouterProvider({ apiKey: KEY, fetch, retries: 0, sleep: noSleep });
    await expect(p.models()).rejects.toMatchObject({ kind: 'unavailable' }); // con un reintento: 2 peticiones fallidas
    expect((await p.model('a/b'))?.free).toBe(true);
  });

  describe('modelos que razonan', () => {
    const base = { pricing: { prompt: '0', completion: '0' }, supported_parameters: ['reasoning', 'structured_outputs'] };
    const catalog = [
      { ...base, id: 'opcional/m', reasoning: { mandatory: false, supported_efforts: ['high', 'medium', 'low', 'minimal', 'none'] } },
      { ...base, id: 'obligatorio/m', top_provider: { max_completion_tokens: 2000 }, reasoning: { mandatory: true, supported_efforts: ['high', 'medium', 'low'] } },
      { ...base, id: 'sin-control/m', supported_parameters: ['structured_outputs'], reasoning: { mandatory: false, default_enabled: true } },
      { ...base, id: 'normal/m' },
    ];
    const send = async (model: string, reasoning?: 'auto' | 'none' | 'minimal' | 'low' | 'medium' | 'high') => {
      const fetch = fakeFetch(route(() => ok(), catalog));
      await new OpenRouterProvider({ apiKey: KEY, fetch, ...(reasoning ? { reasoning } : {}) }).complete({ ...req, model });
      return body(chats(fetch)[0]);
    };

    it('por defecto desactiva el razonamiento si el modelo lo permite', async () => {
      expect(await send('opcional/m')).toMatchObject({ reasoning: { effort: 'none' }, max_completion_tokens: 300 });
    });

    it('si es obligatorio, usa el esfuerzo mínimo admitido, deja margen y respeta el máximo publicado', async () => {
      const b = await send('obligatorio/m');
      expect(b['reasoning']).toEqual({ effort: 'low', exclude: true });
      expect(b['max_completion_tokens']).toBe(2000); // 300 + 2000 de margen, limitado a 2000
    });

    it('si no se puede controlar, no envía el parámetro pero deja margen', async () => {
      const b = await send('sin-control/m');
      expect(b['reasoning']).toBeUndefined();
      expect(b['max_completion_tokens']).toBe(4300);
    });

    it('a un modelo que no razona no le envía nada nuevo', async () => {
      const b = await send('normal/m');
      expect(b['reasoning']).toBeUndefined();
      expect(b['max_completion_tokens']).toBe(300);
    });

    it('respeta la preferencia del usuario dentro de lo que admite el modelo', async () => {
      expect((await send('opcional/m', 'medium'))['reasoning']).toEqual({ effort: 'medium', exclude: true });
      expect((await send('obligatorio/m', 'none'))['reasoning']).toEqual({ effort: 'low', exclude: true });
      expect((await send('obligatorio/m', 'minimal'))['reasoning']).toEqual({ effort: 'low', exclude: true });
      expect((await send('obligatorio/m', 'high'))['reasoning']).toEqual({ effort: 'high', exclude: true });
    });

    it('sin catálogo, la consulta sale tal cual', async () => {
      const fetch = fakeFetch((url) => (url.endsWith('/models') ? json({ error: 'caído' }, 503) : ok()));
      await new OpenRouterProvider({ apiKey: KEY, fetch, retries: 0, sleep: noSleep }).complete(req);
      expect(body(chats(fetch)[0])).toMatchObject({ max_completion_tokens: 300 });
      expect(body(chats(fetch)[0])['reasoning']).toBeUndefined();
    });
  });

  it('valida el formato del id de modelo y exige la clave', () => {
    expect(OpenRouterProvider.isValidModelId('anthropic/claude-haiku-5.5')).toBe(true);
    expect(OpenRouterProvider.isValidModelId('qwen/qwen3-coder:free')).toBe(true);
    expect(OpenRouterProvider.isValidModelId('solo-un-nombre')).toBe(false);
    expect(OpenRouterProvider.isValidModelId('../../x')).toBe(false);
    expect(() => new OpenRouterProvider({ apiKey: '' })).toThrow(/RADAR_OPENROUTER_API_KEY/);
  });

  it('rechaza claves mal pegadas antes de enviar nada, sin mostrarlas', () => {
    const fetch = fakeFetch(() => ok());
    const cases: Array<[string, RegExp]> = [
      ['abcd', /tiene 4 caracteres y debería empezar por "sk-or-"/],
      [KEY.slice(0, 30), /tiene 30 caracteres/],
      [`${KEY.slice(0, 20)} ${KEY.slice(20)}`, /espacios o caracteres invisibles/],
      [`${KEY}\u200b`, /espacios o caracteres invisibles/],
      [`clave-${KEY}`, /debería empezar por "sk-or-"/],
    ];
    for (const [bad, message] of cases) {
      const err = (() => {
        try {
          new OpenRouterProvider({ apiKey: bad, fetch });
          return null;
        } catch (e) {
          return e as Error & { kind: string };
        }
      })();
      expect(err?.kind).toBe('auth');
      expect(err?.message).toMatch(message);
      expect(err?.message).toMatch(/RADAR_OPENROUTER_API_KEY/);
      if (bad.length > 4) expect(err?.message).not.toContain(bad.slice(6, 20));
    }
    expect(fetch.calls).toHaveLength(0);
  });

  describe('comprobación previa de la clave', () => {
    const models = { data: [{ id: 'pago/modelo', pricing: { prompt: '0.000001', completion: '0.000002' } }, { id: 'gratis/modelo', pricing: { prompt: '0', completion: '0' } }] };
    const keyInfo = (data: object) => json({ data: { label: 'x', limit: null, limit_remaining: null, is_free_tier: true, free_model_daily_requests: { used: 0, limit: 50, remaining: 50 }, ...data } });
    const provider = (key: Response | (() => Response)) =>
      new OpenRouterProvider({ apiKey: KEY, retries: 0, sleep: noSleep, fetch: fakeFetch((url) => (url.endsWith('/models') ? json(models) : typeof key === 'function' ? key() : key.clone())) });

    it('una clave revocada da un único error claro', async () => {
      await expect(provider(json({ error: { code: 401, message: 'User not found.' } }, 401)).preflight({ models: ['pago/modelo'], requests: 9 })).rejects.toMatchObject({
        kind: 'auth',
        message: expect.stringMatching(/no es válida o fue revocada.*settings\/keys/) as unknown,
      });
    });

    it('detecta el límite de crédito agotado de la clave', async () => {
      await expect(provider(keyInfo({ limit: 1, limit_remaining: 0 })).preflight({ models: ['pago/modelo'], requests: 1 })).rejects.toMatchObject({ kind: 'quota' });
    });

    it('con modelos gratuitos, avisa si la cuota diaria no alcanza y para si está agotada', async () => {
      const low = keyInfo({ free_model_daily_requests: { used: 47, limit: 50, remaining: 3 } });
      expect(await provider(low).preflight({ models: ['otro/modelo:free'], requests: 9 })).toEqual([expect.stringMatching(/Quedan 3 peticiones gratuitas hoy.*prevé 9/)]);
      expect(await provider(low).preflight({ models: ['gratis/modelo'], requests: 9 })).toHaveLength(1); // precio 0 sin sufijo :free
      expect(await provider(low).preflight({ models: ['pago/modelo'], requests: 9 })).toEqual([]); // la cuota gratuita no afecta a modelos de pago
      const none = keyInfo({ free_model_daily_requests: { used: 50, limit: 50, remaining: 0 } });
      await expect(provider(none).preflight({ models: ['otro/modelo:free'], requests: 1 })).rejects.toMatchObject({ kind: 'rate-limit', message: expect.stringMatching(/\(50\).*00:00 UTC/) as unknown });
    });

    it('si el servicio no responde, no bloquea el análisis', async () => {
      expect(await provider(() => json({ error: 'caído' }, 503)).preflight({ models: ['pago/modelo'], requests: 3 })).toEqual([]);
    });
  });
});
