/**
 * Función «ia» de Supabase (fase 14): la IA incluida de Radar de Deuda Técnica.
 *
 * La aplicación no lleva ninguna clave de IA: las guarda el proyecto como
 * secretos y esta función reenvía las consultas después de comprobar que:
 *   1. vienen de un usuario con la sesión iniciada (su token de Supabase);
 *   2. piden el modelo de la aplicación («radar/predeterminado»);
 *   3. al usuario le quedan consultas hoy (RADAR_IA_LIMITE_DIARIO, 30 por
 *      defecto; se cuenta en la base de datos, migración ia_incluida).
 *
 * Modelo: el de Groq (GROQ_API_KEY y RADAR_IA_MODELO, por defecto
 * openai/gpt-oss-120b). Si Groq está ocupado (límites por minuto) o no está
 * configurado, y hay OPENROUTER_API_KEY, se usan los modelos gratuitos de
 * OpenRouter como respaldo.
 *
 * Habla la API de OpenRouter, que es lo que espera la aplicación:
 * POST /chat/completions, GET /models (solo «radar/predeterminado») y GET /key
 * (el cupo del usuario, con la forma de la respuesta de OpenRouter).
 *
 * No importa nada de fuera: se despliega tal cual desde la CLI de Supabase
 * (supabase functions deploy ia --no-verify-jwt) o pegándola en el editor de
 * funciones del panel. Ver docs/IA-INCLUIDA.md.
 */

export const DEFAULT_MODEL = 'radar/predeterminado';
export const GROQ_DEFAULT_MODEL = 'openai/gpt-oss-120b';
const GROQ = 'https://api.groq.com/openai/v1';
const OPENROUTER = 'https://openrouter.ai/api/v1';
/** OpenRouter admite hasta 3 modelos en una cadena de respaldo. */
const MAX_CHAIN = 3;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_OUTPUT_TOKENS = 16_000;
const CATALOG_TTL_MS = 10 * 60_000;
/** Lo más que se espera por los límites por minuto de Groq en una consulta. */
const DEFAULT_MAX_WAIT_MS = 45_000;
const UPSTREAM_TIMEOUT_MS = 100_000;

export interface IaEnv {
  supabaseUrl: string;
  /** Clave publicable (o la antigua «anon») del proyecto. */
  publishableKey: string;
  /** Groq: el modelo principal (vacío: sin Groq). */
  groqKey: string;
  groqModel: string;
  /** OpenRouter: respaldo con modelos gratuitos (vacío: sin respaldo). */
  openrouterKey: string;
  /** Modelos gratuitos de OpenRouter elegidos por el dueño del proyecto (vacío: se eligen del catálogo). */
  openrouterModels: string[];
  dailyLimit: number;
  /** Para las pruebas. */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface CatalogModel {
  id: string;
  name?: string;
  context_length?: number | null;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
  [k: string]: unknown;
}

export function isFree(m: CatalogModel | undefined, id: string): boolean {
  if (id.endsWith(':free')) return true;
  return m !== undefined && Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0;
}

/**
 * Respaldo de OpenRouter: los modelos configurados que sean gratuitos o, si no
 * hay, los gratuitos del catálogo con salida estructurada y más contexto.
 */
export function defaultModels(catalog: CatalogModel[], configured: string[]): string[] {
  const byId = new Map(catalog.map((m) => [m.id, m]));
  if (configured.length > 0) return configured.filter((id) => isFree(byId.get(id), id)).slice(0, MAX_CHAIN);
  return catalog
    .filter((m) => isFree(m, m.id) && (m.supported_parameters ?? []).includes('structured_outputs'))
    .sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0) || a.id.localeCompare(b.id))
    .slice(0, MAX_CHAIN)
    .map((m) => m.id);
}

/** Lo que se reenvía de una consulta, sea cual sea el proveedor. */
export interface Consulta {
  messages: unknown[];
  response_format?: unknown;
  temperature?: number;
  top_p?: number;
  maxTokens?: number;
  /** Esfuerzo de razonamiento pedido por la aplicación (none, minimal, low, medium, high…). */
  effort?: string;
}

export type Prepared = { ok: true; consulta: Consulta } | { ok: false; status: number; message: string };

/** Comprueba y limpia una consulta antes de reenviarla. */
export function prepareRequest(input: unknown): Prepared {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, status: 400, message: 'Consulta no válida.' };
  const req = input as Record<string, unknown>;
  if (!Array.isArray(req['messages']) || req['messages'].length === 0) return { ok: false, status: 400, message: 'La consulta no tiene mensajes.' };
  const model = req['model'] ?? DEFAULT_MODEL;
  if (model !== DEFAULT_MODEL) {
    return { ok: false, status: 400, message: 'La IA incluida usa el modelo de la aplicación. Para elegir otro modelo, configura tu propio proveedor en Configuración → Inteligencia artificial.' };
  }
  const consulta: Consulta = { messages: req['messages'] };
  if (req['response_format'] !== undefined) consulta.response_format = req['response_format'];
  for (const k of ['temperature', 'top_p'] as const) if (typeof req[k] === 'number') consulta[k] = req[k];
  const tokens = req['max_completion_tokens'] ?? req['max_tokens'];
  if (typeof tokens === 'number') consulta.maxTokens = Math.min(Math.max(1, Math.floor(tokens)), MAX_OUTPUT_TOKENS);
  const effort = (req['reasoning'] as { effort?: unknown } | undefined)?.effort;
  if (typeof effort === 'string') consulta.effort = effort;
  return { ok: true, consulta };
}

/** gpt-oss en Groq: razonamiento low, medium o high (no se puede desactivar). */
function groqEffort(effort: string | undefined): string {
  if (effort === 'medium') return 'medium';
  if (effort === 'high' || effort === 'xhigh' || effort === 'max') return 'high';
  return 'low';
}

export function groqBody(c: Consulta, model: string): Record<string, unknown> {
  return {
    model,
    messages: c.messages,
    ...(c.response_format !== undefined ? { response_format: c.response_format } : {}),
    ...(c.temperature !== undefined ? { temperature: c.temperature } : {}),
    ...(c.top_p !== undefined ? { top_p: c.top_p } : {}),
    ...(c.maxTokens !== undefined ? { max_completion_tokens: c.maxTokens } : {}),
    reasoning_effort: groqEffort(c.effort),
    include_reasoning: false,
    stream: false,
  };
}

export function openrouterBody(c: Consulta, models: string[]): Record<string, unknown> {
  return {
    model: models[0],
    ...(models.length > 1 ? { models } : {}),
    messages: c.messages,
    ...(c.response_format !== undefined ? { response_format: c.response_format } : {}),
    ...(c.temperature !== undefined ? { temperature: c.temperature } : {}),
    ...(c.top_p !== undefined ? { top_p: c.top_p } : {}),
    ...(c.maxTokens !== undefined ? { max_completion_tokens: c.maxTokens } : {}),
    // Los proveedores de los modelos gratuitos suelen guardar los datos: hay que permitirlo.
    provider: { data_collection: 'allow', ...(c.response_format !== undefined ? { require_parameters: true } : {}) },
    stream: false,
  };
}

export function quotaMessage(limit: number): string {
  return `Usaste las ${limit} consultas de IA incluida de hoy. Se renuevan a las 00:00 UTC (las 7 de la tarde en Colombia). Si necesitas más, puedes usar tu propio proveedor en Configuración → Inteligencia artificial.`;
}

const BUSY = 'La IA incluida está ocupada ahora mismo (límite de consultas por minuto del modelo). Inténtalo de nuevo en un minuto.';
const TOO_LARGE = 'La consulta es demasiado grande para el límite de tokens por minuto del modelo de la IA incluida. Prueba con menos hallazgos o con la privacidad «solo metadatos».';
const BAD_KEY = 'La IA incluida no está disponible ahora: la clave del proyecto no es válida o se quedó sin crédito.';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function fail(status: number, message: string): Response {
  return json({ error: { message, code: status } }, status);
}

/** Un proveedor al que se puede reenviar la consulta. */
interface Backend {
  name: string;
  url: string;
  key: string;
  body: (c: Consulta) => Promise<Record<string, unknown>>;
}

type Attempt = { kind: 'ok'; response: Response } | { kind: 'busy' } | { kind: 'key' } | { kind: 'too-large' } | { kind: 'rejected'; response: Response };

/** Crea el manejador de peticiones (las pruebas le pasan su propio fetch y su entorno). */
export function createHandler(env: IaEnv, fetchImpl: typeof fetch = fetch): (req: Request) => Promise<Response> {
  let catalog: { at: number; models: CatalogModel[] } | null = null;
  const sleep = env.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxWaitMs = env.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

  async function loadCatalog(): Promise<CatalogModel[]> {
    if (catalog && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.models;
    const r = await fetchImpl(`${OPENROUTER}/models`, { headers: { 'user-agent': 'radar-deuda' } });
    if (!r.ok) throw new Error(`catálogo HTTP ${r.status}`);
    const models = (((await r.json()) as { data?: CatalogModel[] }).data ?? []).filter((m) => typeof m.id === 'string');
    catalog = { at: Date.now(), models };
    return models;
  }

  const backends: Backend[] = [
    ...(env.groqKey ? [{ name: 'groq', url: `${GROQ}/chat/completions`, key: env.groqKey, body: async (c: Consulta) => groqBody(c, env.groqModel) }] : []),
    ...(env.openrouterKey
      ? [
          {
            name: 'openrouter',
            url: `${OPENROUTER}/chat/completions`,
            key: env.openrouterKey,
            body: async (c: Consulta) => {
              const models = defaultModels(await loadCatalog(), env.openrouterModels);
              if (models.length === 0) throw new Error('no hay modelos gratuitos en OpenRouter');
              return openrouterBody(c, models);
            },
          },
        ]
      : []),
  ];

  /** Llama a la base de datos del proyecto como el usuario (sus políticas se aplican). */
  async function rpc(token: string, name: string): Promise<number> {
    const r = await fetchImpl(`${env.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: env.publishableKey, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    return Number(await r.json());
  }

  /** El usuario del token, o null si no es una sesión válida. */
  async function user(token: string): Promise<string | null> {
    if (!token) return null;
    const r = await fetchImpl(`${env.supabaseUrl}/auth/v1/user`, { headers: { apikey: env.publishableKey, authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const u = (await r.json()) as { id?: unknown };
    return typeof u.id === 'string' ? u.id : null;
  }

  /** El catálogo que ve la aplicación: solo el modelo de la aplicación. */
  async function models(): Promise<Response> {
    const free = { prompt: '0', completion: '0' };
    if (env.groqKey) {
      return json({
        data: [
          {
            id: DEFAULT_MODEL,
            name: `IA incluida (${env.groqModel})`,
            context_length: 131_072,
            pricing: free,
            supported_parameters: ['structured_outputs', 'response_format', 'reasoning', 'max_tokens', 'temperature'],
            // gpt-oss siempre razona: la aplicación pide el esfuerzo más bajo y deja margen.
            reasoning: { mandatory: true, default_enabled: true, supported_efforts: ['high', 'medium', 'low'] },
            top_provider: { max_completion_tokens: MAX_OUTPUT_TOKENS },
          },
        ],
      });
    }
    const all = await loadCatalog();
    const first = all.find((m) => m.id === defaultModels(all, env.openrouterModels)[0]);
    return json({ data: first ? [{ ...first, id: DEFAULT_MODEL, name: 'IA incluida (modelos gratuitos)', pricing: free }] : [] });
  }

  /** Una consulta a un proveedor, esperando lo que pida su límite por minuto (dentro de un máximo). */
  async function attempt(b: Backend, c: Consulta): Promise<Attempt> {
    let body: Record<string, unknown>;
    try {
      body = await b.body(c);
    } catch {
      return { kind: 'busy' };
    }
    let waited = 0;
    let revalidated = false;
    for (;;) {
      let r: Response;
      try {
        r = await fetchImpl(b.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${b.key}`, 'content-type': 'application/json', 'X-Title': 'Radar de Deuda Tecnica' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
      } catch {
        return { kind: 'busy' };
      }
      if (r.ok) return { kind: 'ok', response: r };
      if (r.status === 401 || r.status === 402 || r.status === 403) return { kind: 'key' };
      if (r.status === 429) {
        const wait = Math.max(1, Number(r.headers.get('retry-after')) || 5) * 1000;
        if (waited + wait > maxWaitMs) return { kind: 'busy' };
        waited += wait;
        await sleep(wait);
        continue;
      }
      if (r.status >= 500) return { kind: 'busy' };
      // Groq: una consulta que por sí sola pasa del límite de tokens por minuto nunca entrará esperando.
      if (r.status === 413) return { kind: 'too-large' };
      const text = await r.text();
      // La salida estructurada de Groq a veces no valida a la primera: se repite una vez.
      if (r.status === 400 && /json_validate_failed|does not match the expected schema/i.test(text) && !revalidated) {
        revalidated = true;
        continue;
      }
      return { kind: 'rejected', response: new Response(text, { status: r.status, headers: { 'content-type': 'application/json' } }) };
    }
  }

  async function chat(req: Request, token: string): Promise<Response> {
    const text = await req.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return fail(413, 'La consulta es demasiado grande.');
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      return fail(400, 'Consulta no válida.');
    }
    const prepared = prepareRequest(input);
    if (!prepared.ok) return fail(prepared.status, prepared.message);
    if ((await rpc(token, 'ai_requests_today')) >= env.dailyLimit) return fail(429, quotaMessage(env.dailyLimit));
    let keyProblem = false;
    let tooLarge = false;
    for (const b of backends) {
      const a = await attempt(b, prepared.consulta);
      if (a.kind === 'ok') {
        // Solo cuentan las consultas que responden: los reintentos y los fallos no gastan el cupo.
        await rpc(token, 'ai_count_request');
        return new Response(await a.response.text(), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (a.kind === 'rejected') return a.response;
      if (a.kind === 'key') keyProblem = true;
      if (a.kind === 'too-large') tooLarge = true;
    }
    return fail(503, keyProblem ? BAD_KEY : tooLarge ? TOO_LARGE : BUSY);
  }

  return async (req: Request): Promise<Response> => {
    const route = new URL(req.url).pathname.replace(/^.*?\/ia(?=\/|$)/, '');
    try {
      if (backends.length === 0) return fail(503, 'La IA incluida no está configurada en el proyecto de Supabase (falta el secreto GROQ_API_KEY).');
      if (req.method === 'GET' && route === '/models') return await models();
      const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
      if (!(await user(token))) return fail(401, 'Inicia sesión para usar la IA incluida.');
      if (req.method === 'GET' && route === '/key') {
        const used = await rpc(token, 'ai_requests_today');
        return json({ data: { limit: null, limit_remaining: null, usage: 0, is_free_tier: true, free_model_daily_requests: { used, limit: env.dailyLimit, remaining: Math.max(0, env.dailyLimit - used) } } });
      }
      if (req.method === 'POST' && route === '/chat/completions') return await chat(req, token);
      return fail(404, `Ruta no encontrada: ${req.method} ${route}`);
    } catch (err) {
      return fail(503, `La IA incluida no está disponible ahora (${err instanceof Error ? err.message : String(err)}). Inténtalo más tarde.`);
    }
  };
}

// ── En Supabase (Deno) ───────────────────────────────────────────────────

declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (req: Request) => Promise<Response>): unknown } | undefined;

if (typeof Deno !== 'undefined') {
  const get = (name: string): string => (Deno.env.get(name) ?? '').trim();
  Deno.serve(
    createHandler({
      supabaseUrl: get('SUPABASE_URL'),
      publishableKey: get('SUPABASE_PUBLISHABLE_KEY') || get('SUPABASE_ANON_KEY'),
      groqKey: get('GROQ_API_KEY'),
      groqModel: get('RADAR_IA_MODELO') || GROQ_DEFAULT_MODEL,
      openrouterKey: get('OPENROUTER_API_KEY'),
      openrouterModels: get('RADAR_IA_MODELOS')
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean),
      dailyLimit: Number(get('RADAR_IA_LIMITE_DIARIO')) || 30,
    }),
  );
}
