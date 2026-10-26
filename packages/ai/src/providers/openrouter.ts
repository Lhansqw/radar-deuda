import { HttpError, requestJson } from '@radar/sources';
import { checkApiKey, KEY_RULES, ProviderError, type ModelPrice, type PreflightPlan } from '../provider.js';
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
export interface OpenRouterOptions extends Omit<OpenAiCompatibleOptions, 'id' | 'label' | 'baseUrl' | 'apiKey' | 'locality'> {
  apiKey: string;
  baseUrl?: string;
  /** Permitir proveedores que guardan o entrenan con los datos (por defecto no). */
  allowDataCollection?: boolean;
  /** Solo endpoints de retención cero (Zero Data Retention). */
  zeroDataRetention?: boolean;
}

interface ModelsResponse {
  data?: Array<{ id?: string; pricing?: { prompt?: string; completion?: string } }>;
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
  private prices: Map<string, ModelPrice> | null = null;

  constructor(options: OpenRouterOptions) {
    const { apiKey, baseUrl = 'https://openrouter.ai/api/v1', allowDataCollection = false, zeroDataRetention = false, ...rest } = options;
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
  }

  static isValidModelId(model: string): boolean {
    return MODEL_ID.test(model);
  }

  protected override decorateBody(body: Record<string, unknown>, structured: boolean): void {
    body['provider'] = { ...this.routing, ...(structured ? { require_parameters: true } : {}) };
  }

  /** Precio publicado (la API lo da en USD por token, como texto; aquí, por millón de tokens). */
  async price(model: string, signal?: AbortSignal): Promise<ModelPrice | null> {
    if (!this.prices) {
      const { data } = await requestJson<ModelsResponse>(`${this.baseUrl}/models`, { headers: this.headers() }, { ...this.http, retries: 1, timeoutMs: 20_000, maxBytes: 64 * 1024 * 1024, ...(signal ? { signal } : {}) });
      this.prices = new Map();
      for (const m of data.data ?? []) {
        const input = Number(m.pricing?.prompt);
        const output = Number(m.pricing?.completion);
        if (m.id && Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0) {
          this.prices.set(m.id, { inputPerMTok: input * 1_000_000, outputPerMTok: output * 1_000_000 });
        }
      }
    }
    return this.prices.get(model) ?? null;
  }

  /** Un modelo es gratuito si es una variante ":free" o su precio publicado es cero. */
  async isFree(model: string, signal?: AbortSignal): Promise<boolean> {
    if (model.endsWith(':free')) return true;
    const p = await this.price(model, signal).catch(() => null);
    return p !== null && p.inputPerMTok === 0 && p.outputPerMTok === 0;
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
