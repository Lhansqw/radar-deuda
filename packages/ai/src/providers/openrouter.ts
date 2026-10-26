import { HttpError, requestJson } from '@radar/sources';
import { checkApiKey, KEY_RULES, ProviderError, type ModelPrice } from '../provider.js';
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
