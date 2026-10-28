/**
 * Función «ia» de Supabase (fase 14): la IA incluida de Radar de Deuda Técnica.
 *
 * La aplicación no lleva ninguna clave de OpenRouter: la guarda el proyecto
 * como secreto (OPENROUTER_API_KEY) y esta función reenvía las consultas a
 * OpenRouter después de comprobar que:
 *   1. vienen de un usuario con la sesión iniciada (su token de Supabase);
 *   2. solo piden modelos gratuitos;
 *   3. el usuario no pasó de su cupo diario (RADAR_IA_LIMITE_DIARIO, 30 por
 *      defecto; se cuenta en la base de datos, migración ia_incluida).
 *
 * Habla la misma API que OpenRouter: POST /chat/completions, GET /models (con
 * el modelo «radar/predeterminado», que son los gratuitos elegidos aquí) y
 * GET /key (el cupo del usuario, con la forma de la respuesta de OpenRouter).
 *
 * No importa nada de fuera: se despliega tal cual desde la CLI de Supabase
 * (supabase functions deploy ia --no-verify-jwt) o pegándola en el editor de
 * funciones del panel. Ver docs/IA-INCLUIDA.md.
 */

export const DEFAULT_MODEL = 'radar/predeterminado';
/** OpenRouter admite hasta 3 modelos en una cadena de respaldo. */
const MAX_CHAIN = 3;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_OUTPUT_TOKENS = 16_000;
const CATALOG_TTL_MS = 10 * 60_000;
const OPENROUTER = 'https://openrouter.ai/api/v1';
/** Lo único que se reenvía de una consulta. */
const ALLOWED_FIELDS = ['model', 'models', 'messages', 'response_format', 'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'provider', 'reasoning'];

export interface IaEnv {
  supabaseUrl: string;
  /** Clave publicable (o la antigua «anon») del proyecto. */
  publishableKey: string;
  openrouterKey: string;
  dailyLimit: number;
  /** Modelos gratuitos elegidos por el dueño del proyecto (vacío: se eligen del catálogo). */
  models: string[];
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
 * Los modelos de «radar/predeterminado»: los configurados que sean gratuitos o,
 * si no hay, los gratuitos del catálogo con salida estructurada y más contexto.
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

export type Prepared = { ok: true; body: Record<string, unknown> } | { ok: false; status: number; message: string };

/** Comprueba y limpia una consulta antes de reenviarla. */
export function prepareRequest(input: unknown, catalog: CatalogModel[], defaults: string[]): Prepared {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, status: 400, message: 'Consulta no válida.' };
  const req = input as Record<string, unknown>;
  if (!Array.isArray(req['messages']) || req['messages'].length === 0) return { ok: false, status: 400, message: 'La consulta no tiene mensajes.' };
  const byId = new Map(catalog.map((m) => [m.id, m]));
  const asked = typeof req['model'] === 'string' ? req['model'] : DEFAULT_MODEL;
  const extra = Array.isArray(req['models']) ? req['models'].filter((m): m is string => typeof m === 'string') : [];
  const chain = asked === DEFAULT_MODEL ? defaults : [...new Set([asked, ...extra.filter((m) => m !== DEFAULT_MODEL)])].slice(0, MAX_CHAIN);
  if (chain.length === 0) return { ok: false, status: 503, message: 'Ahora mismo no hay modelos gratuitos disponibles para la IA incluida. Inténtalo más tarde.' };
  if (!chain.every((id) => isFree(byId.get(id), id))) return { ok: false, status: 400, message: 'La IA incluida solo usa modelos gratuitos. Para otros modelos, configura tu propia clave en Configuración → Inteligencia artificial.' };
  const body: Record<string, unknown> = {};
  for (const k of ALLOWED_FIELDS) if (req[k] !== undefined) body[k] = req[k];
  body['model'] = chain[0];
  if (chain.length > 1) body['models'] = chain;
  else delete body['models'];
  for (const k of ['max_tokens', 'max_completion_tokens']) {
    const v = body[k];
    if (typeof v === 'number') body[k] = Math.min(Math.max(1, Math.floor(v)), MAX_OUTPUT_TOKENS);
  }
  body['stream'] = false;
  return { ok: true, body };
}

export function quotaMessage(limit: number): string {
  return `Usaste las ${limit} consultas de IA incluida de hoy. Se renuevan a las 00:00 UTC (las 7 de la tarde en Colombia). Si necesitas más, puedes usar tu propia clave en Configuración → Inteligencia artificial.`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function fail(status: number, message: string): Response {
  return json({ error: { message, code: status } }, status);
}

/** Crea el manejador de peticiones (las pruebas le pasan su propio fetch y su entorno). */
export function createHandler(env: IaEnv, fetchImpl: typeof fetch = fetch): (req: Request) => Promise<Response> {
  let catalog: { at: number; models: CatalogModel[] } | null = null;

  async function loadCatalog(): Promise<CatalogModel[]> {
    if (catalog && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.models;
    const r = await fetchImpl(`${OPENROUTER}/models`, { headers: { 'user-agent': 'radar-deuda' } });
    if (!r.ok) throw new Error(`catálogo HTTP ${r.status}`);
    const models = (((await r.json()) as { data?: CatalogModel[] }).data ?? []).filter((m) => typeof m.id === 'string');
    catalog = { at: Date.now(), models };
    return models;
  }

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

  async function catalogWithDefault(): Promise<Response> {
    const models = await loadCatalog();
    const defaults = defaultModels(models, env.models);
    const first = models.find((m) => m.id === defaults[0]);
    const synthetic = first ? [{ ...first, id: DEFAULT_MODEL, name: 'Modelos gratuitos de la aplicación' }] : [];
    return json({ data: [...synthetic, ...models] });
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
    const models = await loadCatalog();
    const prepared = prepareRequest(input, models, defaultModels(models, env.models));
    if (!prepared.ok) return fail(prepared.status, prepared.message);
    // Se cuenta antes de enviar: también cuentan las consultas que fallan.
    if ((await rpc(token, 'ai_count_request')) > env.dailyLimit) return fail(429, quotaMessage(env.dailyLimit));
    const r = await fetchImpl(`${OPENROUTER}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.openrouterKey}`, 'content-type': 'application/json', 'X-Title': 'Radar de Deuda Tecnica' },
      body: JSON.stringify(prepared.body),
      signal: AbortSignal.timeout(120_000),
    });
    // Un 401 de OpenRouter es de la clave del proyecto, no de la sesión del usuario.
    if (r.status === 401 || r.status === 402) return fail(503, 'La IA incluida no está disponible ahora: la clave de OpenRouter del proyecto no es válida o se quedó sin crédito.');
    return new Response(await r.text(), { status: r.status, headers: { 'content-type': r.headers.get('content-type') ?? 'application/json' } });
  }

  return async (req: Request): Promise<Response> => {
    const route = new URL(req.url).pathname.replace(/^.*?\/ia(?=\/|$)/, '');
    try {
      if (req.method === 'GET' && route === '/models') return await catalogWithDefault();
      if (!env.openrouterKey) return fail(503, 'La IA incluida no está configurada en el proyecto de Supabase (falta el secreto OPENROUTER_API_KEY).');
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
      openrouterKey: get('OPENROUTER_API_KEY'),
      dailyLimit: Number(get('RADAR_IA_LIMITE_DIARIO')) || 30,
      models: get('RADAR_IA_MODELOS')
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean),
    }),
  );
}
