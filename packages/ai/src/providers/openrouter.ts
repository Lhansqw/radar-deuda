import { HttpError, requestJson } from '@radar/sources';
import { checkApiKey, KEY_RULES, ProviderError, type CompletionRequest, type CompletionResult, type ModelPrice, type PreflightPlan } from '../provider.js';
import { OpenAiCompatibleProvider, type OpenAiCompatibleOptions } from './openai-compatible.js';

/**
 * OpenRouter (https://openrouter.ai): una sola clave da acceso a modelos de
 * muchos proveedores mediante la API compatible con OpenAI.
 * Referencias: /docs/api/api-reference/chat/send-chat-completion-request,
 * /docs/guides/routing/provider-selection, /docs/guides/features/structured-outputs.
 *
 * Privacidad: por defecto solo se enruta a proveedores que NO guardan ni
 * entrenan con los datos (provider.data_collection = "deny"); opcionalmente,
 * solo a endpoints de retención cero (zdr). Con salida estructurada se exige
 * que el endpoint soporte response_format (require_parameters), para que no
 * caiga en uno que lo ignore.
 */
/**
 * Cuánto debe razonar un modelo que razona. "auto" lo desactiva cuando el
 * modelo lo permite (explicar un hallazgo no necesita razonamiento largo y así
 * la respuesta cabe y llega antes) o, si no, usa el esfuerzo mínimo admitido.
 */
export type ReasoningPreference = 'auto' | 'none' | 'minimal' | 'low' | 'medium' | 'high';
export const REASONING_PREFERENCES: readonly ReasoningPreference[] = ['auto', 'none', 'minimal', 'low', 'medium', 'high'];

/** Tokens adicionales de salida que se reservan para el razonamiento según el esfuerzo. */
const REASONING_HEADROOM: Record<string, number> = { none: 0, minimal: 1000, low: 2000, medium: 4000, high: 8000, xhigh: 16000, max: 16000 };

export interface ReasoningPlan {
  /** Parámetro reasoning a enviar, o undefined si no se envía (el modelo no lo admite o no razona). */
  reasoning?: { effort: string; exclude?: boolean };
  /** Esfuerzo que se espera que use el modelo ("none" si no razonará). */
  effort: string;
  /** Tokens de salida adicionales para que el razonamiento no deje sin espacio a la respuesta. */
  headroom: number;
}

/**
 * Decide el razonamiento de una consulta a partir del catálogo.
 * Referencia: /docs/guides/best-practices/reasoning-tokens (el límite de tokens
 * incluye razonamiento y respuesta; effort "none" lo desactiva salvo en los
 * modelos con razonamiento obligatorio, que lo rechazan).
 */
export function planReasoning(model: OpenRouterModel | null, preference: ReasoningPreference): ReasoningPlan {
  const r = model?.reasoning;
  if (!model || !r) return { effort: 'none', headroom: 0 };
  const controllable = model.supportedParameters.includes('reasoning');
  if (!controllable) {
    // No se puede ajustar: si razona por defecto, al menos se deja margen.
    return r.mandatory || r.defaultEnabled ? { effort: 'desconocido', headroom: REASONING_HEADROOM['medium'] as number } : { effort: 'none', headroom: 0 };
  }
  const allowed = (r.supportedEfforts ?? ['high', 'medium', 'low', 'minimal', 'none']).filter((e) => e !== 'none' || !r.mandatory);
  const lowest = [...allowed].reverse().find((e) => e !== 'none') ?? 'low';
  let effort: string = preference === 'auto' ? 'none' : preference;
  if (!allowed.includes(effort)) effort = effort === 'none' ? lowest : (allowed.find((e) => (REASONING_HEADROOM[e] ?? 0) <= (REASONING_HEADROOM[effort] ?? 0) && e !== 'none') ?? lowest);
  if (effort === 'none') return { reasoning: { effort: 'none' }, effort, headroom: 0 };
  // El texto del razonamiento no se usa: exclude evita recibirlo (se sigue cobrando como salida).
  return { reasoning: { effort, exclude: true }, effort, headroom: REASONING_HEADROOM[effort] ?? REASONING_HEADROOM['medium'] as number };
}

export interface OpenRouterOptions extends Omit<OpenAiCompatibleOptions, 'id' | 'label' | 'baseUrl' | 'apiKey' | 'locality'> {
  apiKey: string;
  baseUrl?: string;
  /** Razonamiento de los modelos que razonan (por defecto "auto"). */
  reasoning?: ReasoningPreference;
  /** Permitir proveedores que guardan o entrenan con los datos (por defecto no). */
  allowDataCollection?: boolean;
  /** Solo endpoints de retención cero (Zero Data Retention). */
  zeroDataRetention?: boolean;
}

interface ModelsResponse {
  data?: Array<{
    id?: string;
    name?: string;
    context_length?: number | null;
    pricing?: { prompt?: string; completion?: string };
    top_provider?: { max_completion_tokens?: number | null } | null;
    supported_parameters?: string[];
    reasoning?: { mandatory?: boolean; default_enabled?: boolean; supported_efforts?: string[] | null } | null;
  }>;
}

/** Lo que la aplicación necesita saber de cada modelo del catálogo de OpenRouter. */
export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength: number | null;
  /** Máximo de tokens de salida del proveedor principal, si se publica. */
  maxCompletionTokens: number | null;
  price: ModelPrice | null;
  free: boolean;
  supportedParameters: string[];
  structuredOutputs: boolean;
  /** null si el modelo no razona. */
  reasoning: {
    /** No se puede desactivar. */
    mandatory: boolean;
    /** Razona por defecto si no se indica nada. */
    defaultEnabled: boolean;
    /** Esfuerzos admitidos de mayor a menor; null si no hay lista. */
    supportedEfforts: string[] | null;
  } | null;
}

function toModel(m: NonNullable<ModelsResponse['data']>[number]): OpenRouterModel | null {
  if (!m.id) return null;
  const input = Number(m.pricing?.prompt);
  const output = Number(m.pricing?.completion);
  const price = Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0 ? { inputPerMTok: input * 1_000_000, outputPerMTok: output * 1_000_000 } : null;
  const params = Array.isArray(m.supported_parameters) ? m.supported_parameters.filter((p): p is string => typeof p === 'string') : [];
  return {
    id: m.id,
    name: m.name ?? m.id,
    contextLength: typeof m.context_length === 'number' ? m.context_length : null,
    maxCompletionTokens: typeof m.top_provider?.max_completion_tokens === 'number' ? m.top_provider.max_completion_tokens : null,
    price,
    free: m.id.endsWith(':free') || (price !== null && price.inputPerMTok === 0 && price.outputPerMTok === 0),
    supportedParameters: params,
    structuredOutputs: params.includes('structured_outputs'),
    reasoning: m.reasoning
      ? {
          mandatory: m.reasoning.mandatory === true,
          defaultEnabled: m.reasoning.default_enabled !== false,
          supportedEfforts: Array.isArray(m.reasoning.supported_efforts) ? m.reasoning.supported_efforts : null,
        }
      : null,
  };
}

/** Respuesta de GET /api/v1/key (solo los campos que se usan). */
interface KeyResponse {
  data?: {
    limit_remaining?: number | null;
    is_free_tier?: boolean;
    free_model_daily_requests?: { used?: number; limit?: number; remaining?: number } | null;
  };
}

/** Ids de OpenRouter: "proveedor/modelo", opcionalmente con variante (":free"). */
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

export class OpenRouterProvider extends OpenAiCompatibleProvider {
  private readonly routing: Record<string, unknown>;
  private readonly reasoningPreference: ReasoningPreference;
  private catalog: Promise<Map<string, OpenRouterModel>> | null = null;

  constructor(options: OpenRouterOptions) {
    const { apiKey, baseUrl = 'https://openrouter.ai/api/v1', allowDataCollection = false, zeroDataRetention = false, reasoning = 'auto', ...rest } = options;
    checkApiKey(apiKey, KEY_RULES.openrouter, 'openrouter');
    super({
      ...rest,
      id: 'openrouter',
      label: 'OpenRouter',
      baseUrl,
      apiKey,
      locality: 'cloud',
      maxTokensParam: 'max_completion_tokens',
      extraHeaders: { 'X-Title': 'Radar de Deuda Tecnica' },
    });
    this.routing = { data_collection: allowDataCollection ? 'allow' : 'deny', ...(zeroDataRetention ? { zdr: true } : {}) };
    this.reasoningPreference = reasoning;
  }

  /**
   * Ajusta cada consulta al modelo: controla su razonamiento y amplía el límite
   * de salida con el margen que este necesita (sin pasar del máximo publicado).
   * Sin catálogo, la consulta se envía tal cual.
   */
  override async complete(req: CompletionRequest): Promise<CompletionResult> {
    const info = await this.model(req.model, req.signal).catch((err: unknown) => {
      if (req.signal?.aborted) throw err;
      return null;
    });
    const plan = planReasoning(info, this.reasoningPreference);
    let maxOutputTokens = req.maxOutputTokens + plan.headroom;
    if (info?.maxCompletionTokens) maxOutputTokens = Math.min(maxOutputTokens, info.maxCompletionTokens);
    return this.send({ ...req, maxOutputTokens }, plan.reasoning ? { reasoning: plan.reasoning } : {});
  }

  static isValidModelId(model: string): boolean {
    return MODEL_ID.test(model);
  }

  protected override decorateBody(body: Record<string, unknown>, structured: boolean): void {
    body['provider'] = { ...this.routing, ...(structured ? { require_parameters: true } : {}) };
  }

  /**
   * Catálogo de modelos (GET /api/v1/models), descargado una vez por instancia.
   * Las peticiones simultáneas comparten la misma descarga; si falla, el
   * siguiente intento vuelve a pedirlo.
   * Referencia: /docs/api/api-reference/models/list-all-models-and-their-properties
   */
  async models(signal?: AbortSignal): Promise<OpenRouterModel[]> {
    return [...(await this.loadCatalog(signal)).values()];
  }

  async model(id: string, signal?: AbortSignal): Promise<OpenRouterModel | null> {
    return (await this.loadCatalog(signal)).get(id) ?? null;
  }

  private loadCatalog(signal?: AbortSignal): Promise<Map<string, OpenRouterModel>> {
    this.catalog ??= requestJson<ModelsResponse>(`${this.baseUrl}/models`, { headers: this.headers() }, { ...this.http, retries: 1, timeoutMs: 20_000, maxBytes: 64 * 1024 * 1024, ...(signal ? { signal } : {}) })
      .then(({ data }) => new Map((data.data ?? []).map(toModel).filter((m): m is OpenRouterModel => m !== null).map((m) => [m.id, m])))
      .catch((err: unknown) => {
        this.catalog = null;
        throw this.explain(err);
      });
    return this.catalog;
  }

  /** Precio publicado (la API lo da en USD por token, como texto; aquí, por millón de tokens). */
  async price(model: string, signal?: AbortSignal): Promise<ModelPrice | null> {
    return (await this.model(model, signal))?.price ?? null;
  }

  /** Un modelo es gratuito si es una variante ":free" o su precio publicado es cero. */
  async isFree(model: string, signal?: AbortSignal): Promise<boolean> {
    if (model.endsWith(':free')) return true;
    return (await this.model(model, signal).catch(() => null))?.free ?? false;
  }

  /**
   * Consulta GET /api/v1/key antes del análisis: una clave revocada se detecta
   * con una sola petición (y un solo mensaje), y se avisa si el saldo o la cuota
   * diaria de modelos gratuitos no alcanzan para lo previsto.
   * Referencia: /docs/api/api-reference/api-keys/get-current-api-key, /docs/api_reference/limits.
   */
  async preflight(plan: PreflightPlan, signal?: AbortSignal): Promise<string[]> {
    let data: KeyResponse['data'];
    try {
      ({ data: { data } } = await requestJson<KeyResponse>(`${this.baseUrl}/key`, { headers: this.headers() }, { ...this.http, retries: 1, timeoutMs: 15_000, ...(signal ? { signal } : {}) }));
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        throw new ProviderError('OpenRouter rechazó la clave: no es válida o fue revocada. Crea una nueva en https://openrouter.ai/settings/keys.', 'auth', this.id, { cause: err });
      }
      if (signal?.aborted) throw err;
      return []; // Comprobación opcional: si no responde, las peticiones informarán del problema.
    }
    const notes: string[] = [];
    if (typeof data?.limit_remaining === 'number' && data.limit_remaining <= 0) {
      throw new ProviderError('La clave de OpenRouter agotó su límite de crédito. Amplíalo en https://openrouter.ai/settings/keys o usa otra clave.', 'quota', this.id);
    }
    const free = await Promise.all(plan.models.map((m) => this.isFree(m, signal)));
    const daily = data?.free_model_daily_requests;
    if (free.some(Boolean) && typeof daily?.remaining === 'number') {
      if (daily.remaining <= 0) {
        const total = typeof daily.limit === 'number' ? ` (${daily.limit})` : '';
        throw new ProviderError(
          `Agotaste las peticiones diarias a modelos gratuitos de OpenRouter${total}. Se renuevan cada día a las 00:00 UTC; con 10 USD o más de crédito comprado el límite sube.`,
          'rate-limit',
          this.id,
        );
      }
      if (daily.remaining < plan.requests) {
        notes.push(`Quedan ${daily.remaining} peticiones gratuitas hoy y este análisis prevé ${plan.requests} (más los reintentos): puede quedar incompleto. Explica menos hallazgos (--ai-limit en la CLI) o espera a mañana.`);
      }
    }
    return notes;
  }

  protected override explain(err: unknown): ProviderError {
    if (err instanceof HttpError && err.status === 404 && /endpoint|provider|parameters/i.test(err.body)) {
      return new ProviderError(
        'OpenRouter: ningún proveedor de este modelo cumple las restricciones (no guardar datos y salida estructurada). Prueba otro modelo o, si lo aceptas, --ai-allow-data-collection.',
        'invalid-request',
        this.id,
        { cause: err },
      );
    }
    return super.explain(err);
  }
}
