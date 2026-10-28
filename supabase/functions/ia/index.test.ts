import { describe, expect, it } from 'vitest';
import { createHandler, DEFAULT_MODEL, defaultModels, prepareRequest, type IaEnv } from './index.js';

const SUPABASE = 'https://prueba.supabase.co';
const env: IaEnv = { supabaseUrl: SUPABASE, publishableKey: 'sb_publishable_prueba', openrouterKey: 'clave-del-proyecto', dailyLimit: 3, models: [] };
const free = (id: string, context = 1000, structured = true) => ({ id, name: id, context_length: context, pricing: { prompt: '0', completion: '0' }, supported_parameters: structured ? ['structured_outputs'] : [] });
const paid = { id: 'openai/gpt-5', name: 'GPT', context_length: 400000, pricing: { prompt: '0.000001', completion: '0.00001' }, supported_parameters: ['structured_outputs'] };
const CATALOG = [free('qwen/qwen3-coder:free', 262000), free('meta/llama:free', 128000), free('sin/estructura:free', 999999, false), free('google/gemma:free', 8000), free('otro/mas:free', 4000), paid];
const messages = [{ role: 'user', content: 'hola' }];

/** OpenRouter y Supabase simulados; el usuario «ana» tiene sesión con el token «t-ana». */
function servers(options: { used?: number; openrouterStatus?: number } = {}) {
  let used = options.used ?? 0;
  const sent: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get('authorization');
    if (url === 'https://openrouter.ai/api/v1/models') return Response.json({ data: CATALOG });
    if (url === `${SUPABASE}/auth/v1/user`) return auth === 'Bearer t-ana' ? Response.json({ id: 'ana' }) : Response.json({ msg: 'invalid' }, { status: 401 });
    if (url === `${SUPABASE}/rest/v1/rpc/ai_count_request`) return Response.json(++used);
    if (url === `${SUPABASE}/rest/v1/rpc/ai_requests_today`) return Response.json(used);
    if (url === 'https://openrouter.ai/api/v1/chat/completions') {
      expect(auth).toBe('Bearer clave-del-proyecto');
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ choices: [{ message: { content: '{}' } }] }, { status: options.openrouterStatus ?? 200 });
    }
    throw new Error(`sin simular: ${url}`);
  }) as typeof fetch;
  return { fetchImpl, sent, used: () => used };
}

const post = (body: unknown, token = 't-ana') =>
  new Request(`${SUPABASE}/functions/v1/ia/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const get = (route: string, token = 't-ana') => new Request(`${SUPABASE}/functions/v1/ia${route}`, { headers: { authorization: `Bearer ${token}` } });
const errorOf = async (r: Response) => ((await r.json()) as { error: { message: string } }).error.message;

describe('función «ia»: reglas', () => {
  it('elige los gratuitos con salida estructurada y más contexto, o los configurados que sean gratuitos', () => {
    expect(defaultModels(CATALOG, [])).toEqual(['qwen/qwen3-coder:free', 'meta/llama:free', 'google/gemma:free']);
    expect(defaultModels(CATALOG, ['openai/gpt-5', 'google/gemma:free'])).toEqual(['google/gemma:free']);
  });

  it('solo reenvía modelos gratuitos y los campos conocidos, sin streaming y con salida acotada', () => {
    const defaults = defaultModels(CATALOG, []);
    expect(prepareRequest({ model: DEFAULT_MODEL, messages, max_completion_tokens: 999999, stream: true, user: 'x', tools: [] }, CATALOG, defaults)).toEqual({
      ok: true,
      body: { model: 'qwen/qwen3-coder:free', models: defaults, messages, max_completion_tokens: 16000, stream: false },
    });
    expect(prepareRequest({ model: 'google/gemma:free', messages }, CATALOG, defaults)).toEqual({ ok: true, body: { model: 'google/gemma:free', messages, stream: false } });
    expect(prepareRequest({ model: 'openai/gpt-5', messages }, CATALOG, defaults)).toMatchObject({ ok: false, status: 400, message: expect.stringMatching(/solo usa modelos gratuitos/) });
    expect(prepareRequest({ model: 'google/gemma:free', models: ['openai/gpt-5'], messages }, CATALOG, defaults)).toMatchObject({ ok: false, status: 400 });
    expect(prepareRequest({ model: DEFAULT_MODEL, messages: [] }, CATALOG, defaults)).toMatchObject({ ok: false, status: 400 });
    expect(prepareRequest({ messages }, CATALOG, [])).toMatchObject({ ok: false, status: 503 });
  });
});

describe('función «ia»: peticiones', () => {
  it('reenvía la consulta de un usuario con sesión con la clave del proyecto y cuenta su cupo', async () => {
    const s = servers();
    const handle = createHandler(env, s.fetchImpl);
    const r = await handle(post({ model: DEFAULT_MODEL, messages }));
    expect(r.status).toBe(200);
    expect(s.sent[0]).toMatchObject({ model: 'qwen/qwen3-coder:free', stream: false });
    expect(s.used()).toBe(1);
    const key = (await (await handle(get('/key'))).json()) as { data: { free_model_daily_requests: object } };
    expect(key.data.free_model_daily_requests).toEqual({ used: 1, limit: 3, remaining: 2 });
  });

  it('sin sesión válida, nada', async () => {
    const s = servers();
    const handle = createHandler(env, s.fetchImpl);
    const r = await handle(post({ messages }, 'robado'));
    expect(r.status).toBe(401);
    expect(await errorOf(r)).toBe('Inicia sesión para usar la IA incluida.');
    expect((await handle(get('/key', ''))).status).toBe(401);
    expect(s.sent).toEqual([]);
  });

  it('pasado el cupo diario responde 429 y no llama a OpenRouter', async () => {
    const s = servers({ used: 3 });
    const r = await createHandler(env, s.fetchImpl)(post({ messages }));
    expect(r.status).toBe(429);
    expect(await errorOf(r)).toMatch(/Usaste las 3 consultas/);
    expect(s.sent).toEqual([]);
  });

  it('un modelo de pago o una consulta mal formada no gastan cupo', async () => {
    const s = servers();
    const handle = createHandler(env, s.fetchImpl);
    expect((await handle(post({ model: 'openai/gpt-5', messages }))).status).toBe(400);
    expect((await handle(post('{no es json'))).status).toBe(400);
    expect((await handle(post({ messages: 'x'.repeat(1024 * 1024 + 1) }))).status).toBe(413);
    expect(s.used()).toBe(0);
  });

  it('un rechazo de la clave del proyecto no se confunde con la sesión del usuario', async () => {
    const s = servers({ openrouterStatus: 401 });
    const r = await createHandler(env, s.fetchImpl)(post({ messages }));
    expect(r.status).toBe(503);
    expect(await errorOf(r)).toMatch(/clave de OpenRouter del proyecto/);
  });

  it('sin la clave de OpenRouter configurada lo explica; el catálogo lleva el modelo predeterminado', async () => {
    const s = servers();
    const r = await createHandler({ ...env, openrouterKey: '' }, s.fetchImpl)(post({ messages }));
    expect(r.status).toBe(503);
    expect(await errorOf(r)).toMatch(/OPENROUTER_API_KEY/);
    const models = (await (await createHandler(env, s.fetchImpl)(get('/models', ''))).json()) as { data: Array<{ id: string; pricing: object }> };
    expect(models.data[0]).toMatchObject({ id: DEFAULT_MODEL, pricing: { prompt: '0', completion: '0' } });
    expect(models.data).toHaveLength(CATALOG.length + 1);
  });
});
