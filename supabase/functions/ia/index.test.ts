import { describe, expect, it } from 'vitest';
import { createHandler, DEFAULT_MODEL, defaultModels, groqBody, prepareRequest, type IaEnv } from './index.js';

const SUPABASE = 'https://prueba.supabase.co';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const env: IaEnv = {
  supabaseUrl: SUPABASE,
  publishableKey: 'sb_publishable_prueba',
  groqKey: 'clave-groq',
  groqModel: 'openai/gpt-oss-120b',
  openrouterKey: '',
  openrouterModels: [],
  dailyLimit: 3,
  maxWaitMs: 20_000,
  sleep: async () => undefined,
};
const free = (id: string, context = 1000, structured = true) => ({ id, name: id, context_length: context, pricing: { prompt: '0', completion: '0' }, supported_parameters: structured ? ['structured_outputs'] : [] });
const paid = { id: 'openai/gpt-5', name: 'GPT', context_length: 400000, pricing: { prompt: '0.000001', completion: '0.00001' }, supported_parameters: ['structured_outputs'] };
const CATALOG = [free('qwen/qwen3-coder:free', 262000), free('meta/llama:free', 128000), free('sin/estructura:free', 999999, false), free('google/gemma:free', 8000), free('otro/mas:free', 4000), paid];
const messages = [{ role: 'user', content: 'hola' }];
const schema = { type: 'json_schema', json_schema: { name: 'explicacion', strict: true, schema: { type: 'object' } } };
const ok = () => Response.json({ model: 'openai/gpt-oss-120b', choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

type Reply = Response | (() => Response);

/** Groq, OpenRouter y Supabase simulados; el usuario «ana» tiene sesión con el token «t-ana». */
function servers(options: { used?: number; groq?: Reply[]; openrouter?: Reply[] } = {}) {
  let used = options.used ?? 0;
  const sent: Array<{ to: string; body: Record<string, unknown> }> = [];
  const groq = [...(options.groq ?? [])];
  const openrouter = [...(options.openrouter ?? [])];
  const next = (queue: Reply[]): Response => {
    const r = queue.shift() ?? ok;
    return typeof r === 'function' ? r() : r;
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get('authorization');
    if (url === 'https://openrouter.ai/api/v1/models') return Response.json({ data: CATALOG });
    if (url === `${SUPABASE}/auth/v1/user`) return auth === 'Bearer t-ana' ? Response.json({ id: 'ana' }) : Response.json({ msg: 'invalid' }, { status: 401 });
    if (url === `${SUPABASE}/rest/v1/rpc/ai_count_request`) return Response.json(++used);
    if (url === `${SUPABASE}/rest/v1/rpc/ai_requests_today`) return Response.json(used);
    if (url === GROQ_URL) {
      expect(auth).toBe('Bearer clave-groq');
      sent.push({ to: 'groq', body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return next(groq);
    }
    if (url === OPENROUTER_URL) {
      expect(auth).toBe('Bearer clave-openrouter');
      sent.push({ to: 'openrouter', body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return next(openrouter);
    }
    throw new Error(`sin simular: ${url}`);
  }) as typeof fetch;
  return { fetchImpl, sent, used: () => used };
}

const post = (body: unknown, token = 't-ana') =>
  new Request(`${SUPABASE}/functions/v1/ia/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const get = (route: string, token = 't-ana') => new Request(`${SUPABASE}/functions/v1/ia${route}`, { headers: { authorization: `Bearer ${token}` } });
const errorOf = async (r: Response) => ((await r.json()) as { error: { message: string } }).error.message;
const busy = () => new Response('{"error":{"message":"Rate limit reached"}}', { status: 429, headers: { 'retry-after': '7' } });

describe('función «ia»: reglas', () => {
  it('respaldo de OpenRouter: gratuitos con salida estructurada y más contexto, o los configurados que sean gratuitos', () => {
    expect(defaultModels(CATALOG, [])).toEqual(['qwen/qwen3-coder:free', 'meta/llama:free', 'google/gemma:free']);
    expect(defaultModels(CATALOG, ['openai/gpt-5', 'google/gemma:free'])).toEqual(['google/gemma:free']);
  });

  it('solo el modelo de la aplicación y los campos conocidos, con la salida acotada', () => {
    const r = prepareRequest({ model: DEFAULT_MODEL, messages, response_format: schema, max_completion_tokens: 999999, stream: true, user: 'x', tools: [], provider: { x: 1 }, reasoning: { effort: 'minimal', exclude: true } });
    expect(r).toEqual({ ok: true, consulta: { messages, response_format: schema, maxTokens: 16000, effort: 'minimal' } });
    expect(prepareRequest({ model: 'openai/gpt-5', messages })).toMatchObject({ ok: false, status: 400, message: expect.stringMatching(/usa el modelo de la aplicación/) });
    expect(prepareRequest({ model: DEFAULT_MODEL, messages: [] })).toMatchObject({ ok: false, status: 400 });
    expect(prepareRequest('x')).toMatchObject({ ok: false, status: 400 });
  });

  it('Groq: gpt-oss con el razonamiento más bajo que admite y sin devolverlo', () => {
    expect(groqBody({ messages, response_format: schema, maxTokens: 3000, effort: 'none' }, 'openai/gpt-oss-120b')).toEqual({
      model: 'openai/gpt-oss-120b',
      messages,
      response_format: schema,
      max_completion_tokens: 3000,
      reasoning_effort: 'low',
      include_reasoning: false,
      stream: false,
    });
    expect(groqBody({ messages, effort: 'high' }, 'm').reasoning_effort).toBe('high');
  });
});

describe('función «ia»: peticiones', () => {
  it('reenvía a Groq la consulta de un usuario con sesión y cuenta su cupo', async () => {
    const s = servers();
    const handle = createHandler(env, s.fetchImpl);
    const r = await handle(post({ model: DEFAULT_MODEL, messages, response_format: schema, reasoning: { effort: 'low', exclude: true } }));
    expect(r.status).toBe(200);
    expect(s.sent).toEqual([{ to: 'groq', body: expect.objectContaining({ model: 'openai/gpt-oss-120b', reasoning_effort: 'low', response_format: schema }) as unknown }]);
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

  it('pasado el cupo diario responde 429 y no llama al modelo', async () => {
    const s = servers({ used: 3 });
    const r = await createHandler(env, s.fetchImpl)(post({ messages }));
    expect(r.status).toBe(429);
    expect(await errorOf(r)).toMatch(/Usaste las 3 consultas/);
    expect(s.sent).toEqual([]);
  });

  it('otro modelo, una consulta mal formada o un fallo del modelo no gastan cupo', async () => {
    const s = servers({ groq: [new Response('{}', { status: 500 })] });
    const handle = createHandler(env, s.fetchImpl);
    expect((await handle(post({ model: 'openai/gpt-5', messages }))).status).toBe(400);
    expect((await handle(post('{no es json'))).status).toBe(400);
    expect((await handle(post({ messages: 'x'.repeat(1024 * 1024 + 1) }))).status).toBe(413);
    expect((await handle(post({ messages }))).status).toBe(503);
    expect(s.used()).toBe(0);
  });

  it('con el límite por minuto de Groq espera lo que pide y repite; si es demasiado, lo dice', async () => {
    const waits: number[] = [];
    const s = servers({ groq: [busy, busy] });
    const r = await createHandler({ ...env, sleep: async (ms) => void waits.push(ms) }, s.fetchImpl)(post({ messages }));
    expect(r.status).toBe(200);
    expect(waits).toEqual([7000, 7000]);
    expect(s.used()).toBe(1);
    const lleno = servers({ groq: [busy, busy, busy, busy] });
    const r2 = await createHandler(env, lleno.fetchImpl)(post({ messages }));
    expect(r2.status).toBe(503);
    expect(await errorOf(r2)).toMatch(/ocupada/);
    expect(lleno.used()).toBe(0);
  });

  it('si Groq no responde, usa los modelos gratuitos de OpenRouter como respaldo', async () => {
    const s = servers({ groq: [busy, busy, busy, busy] });
    const r = await createHandler({ ...env, openrouterKey: 'clave-openrouter' }, s.fetchImpl)(post({ messages, response_format: schema }));
    expect(r.status).toBe(200);
    expect(s.sent.at(-1)).toEqual({
      to: 'openrouter',
      body: expect.objectContaining({ model: 'qwen/qwen3-coder:free', models: defaultModels(CATALOG, []), provider: { data_collection: 'allow', require_parameters: true } }) as unknown,
    });
    expect(s.used()).toBe(1);
  });

  it('repite una vez si la salida estructurada no valida; los demás rechazos se devuelven', async () => {
    const invalid = () => Response.json({ error: { message: 'Generated JSON does not match the expected schema', code: 'json_validate_failed' } }, { status: 400 });
    const s = servers({ groq: [invalid] });
    expect((await createHandler(env, s.fetchImpl)(post({ messages }))).status).toBe(200);
    const t = servers({ groq: [invalid, invalid] });
    expect((await createHandler(env, t.fetchImpl)(post({ messages }))).status).toBe(400);
    const grande = servers({ groq: [() => Response.json({ error: { message: 'Request too large' } }, { status: 413 })] });
    const r = await createHandler(env, grande.fetchImpl)(post({ messages }));
    expect(r.status).toBe(503);
    expect(await errorOf(r)).toMatch(/demasiado grande/);
  });

  it('un rechazo de la clave del proyecto no se confunde con la sesión del usuario', async () => {
    const s = servers({ groq: [() => Response.json({ error: { message: 'Invalid API Key' } }, { status: 401 })] });
    const r = await createHandler(env, s.fetchImpl)(post({ messages }));
    expect(r.status).toBe(503);
    expect(await errorOf(r)).toMatch(/clave del proyecto/);
  });

  it('sin claves configuradas lo explica; el catálogo solo tiene el modelo de la aplicación', async () => {
    const s = servers();
    const r = await createHandler({ ...env, groqKey: '' }, s.fetchImpl)(post({ messages }));
    expect(r.status).toBe(503);
    expect(await errorOf(r)).toMatch(/GROQ_API_KEY/);
    const models = (await (await createHandler(env, s.fetchImpl)(get('/models', ''))).json()) as { data: Array<Record<string, unknown>> };
    expect(models.data).toEqual([
      expect.objectContaining({ id: DEFAULT_MODEL, name: 'IA incluida (openai/gpt-oss-120b)', pricing: { prompt: '0', completion: '0' }, reasoning: expect.objectContaining({ mandatory: true }) as unknown }),
    ]);
    const soloOpenRouter = (await (await createHandler({ ...env, groqKey: '', openrouterKey: 'clave-openrouter' }, s.fetchImpl)(get('/models', ''))).json()) as { data: Array<{ id: string }> };
    expect(soloOpenRouter.data.map((m) => m.id)).toEqual([DEFAULT_MODEL]);
  });
});
