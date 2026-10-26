import { HttpError, requestJson, type HttpOptions } from '@radar/sources';
import { checkApiKey, KEY_RULES, ProviderError, type CompletionRequest, type CompletionResult, type FinishReason, type LlmProvider } from '../provider.js';

/**
 * Adaptador para la API de Messages de Anthropic (Claude).
 * Referencia: https://platform.claude.com/docs/en/api/messages/create
 *
 * - Versión de la API fijada explícitamente, para que el comportamiento no
 *   cambie si cambia la versión por defecto. Con 2026-10-21, temperature,
 *   top_p y top_k ya no se aceptan, así que no se envían.
 * - Salida estructurada con output_config.format (json_schema).
 * - 429 con Retry-After y 5xx/529 (sobrecarga) se reintentan; un 429 sin
 *   Retry-After indica tope de gasto y reintentar no sirve.
 */
export const ANTHROPIC_API_VERSION = '2026-10-21';

/** Modelos actuales (octubre de 2026) según https://platform.claude.com/docs/en/about-claude/models/overview */
export const ANTHROPIC_MODELS = {
  /** El más rápido y económico: adecuado para explicar hallazgos uno a uno. */
  fast: 'claude-haiku-5-5',
  /** Equilibrio entre capacidad y coste: adecuado para el plan de reducción. */
  balanced: 'claude-sonnet-5-5',
} as const;

export interface AnthropicOptions extends HttpOptions {
  apiKey: string;
  baseUrl?: string;
}

interface MessagesResponse {
  model?: string;
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

interface ErrorBody {
  error?: { type?: string; message?: string };
  request_id?: string;
}

const FINISH: Record<string, FinishReason> = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', refusal: 'refusal' };

export const anthropicRetryable = (status: number, headers: Headers): boolean =>
  (status === 429 && headers.has('retry-after')) || status === 500 || status === 529 || status === 503;

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic';
  readonly label = 'Anthropic (Claude)';
  readonly locality = 'cloud' as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly http: HttpOptions;

  constructor(options: AnthropicOptions) {
    const { apiKey, baseUrl = 'https://api.anthropic.com', ...http } = options;
    checkApiKey(apiKey, KEY_RULES.anthropic, this.id);
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.http = { timeoutMs: 120_000, retries: 2, retryable: anthropicRetryable, ...http };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxOutputTokens,
      system: req.system,
      messages: req.messages,
    };
    if (req.jsonSchema) body['output_config'] = { format: { type: 'json_schema', schema: req.jsonSchema.schema } };
    const started = performance.now();
    let data: MessagesResponse;
    let headers: Headers;
    try {
      ({ data, headers } = await requestJson<MessagesResponse>(
        `${this.baseUrl}/v1/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': ANTHROPIC_API_VERSION, 'user-agent': 'radar-deuda' },
          body: JSON.stringify(body),
        },
        { ...this.http, ...(req.signal ? { signal: req.signal } : {}) },
      ));
    } catch (err) {
      throw this.explain(err);
    }
    const text = (data.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    const u = data.usage;
    return {
      text,
      model: data.model ?? req.model,
      finishReason: FINISH[data.stop_reason ?? ''] ?? 'other',
      usage:
        u && typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number'
          ? { inputTokens: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), outputTokens: u.output_tokens }
          : null,
      latencyMs: Math.round(performance.now() - started),
      ...(headers.get('request-id') ? { requestId: headers.get('request-id') as string } : {}),
    };
  }

  private explain(err: unknown): ProviderError {
    if (!(err instanceof HttpError)) {
      return new ProviderError(`Anthropic: no se pudo conectar (${err instanceof Error ? err.message : String(err)}).`, 'unavailable', this.id, { cause: err });
    }
    let parsed: ErrorBody = {};
    try {
      parsed = JSON.parse(err.body) as ErrorBody;
    } catch {
      /* cuerpo no JSON */
    }
    const type = parsed.error?.type ?? '';
    const reqId = parsed.request_id ?? err.headers.get('request-id');
    const suffix = reqId ? ` (request-id ${reqId})` : '';
    const msg = (parsed.error?.message ?? '').slice(0, 300);
    if (err.status === 401 || type === 'authentication_error') return new ProviderError(`Anthropic: la clave de API no es válida o fue revocada${suffix}.`, 'auth', this.id, { cause: err });
    if (err.status === 402 || type === 'billing_error') return new ProviderError(`Anthropic: problema de facturación en la cuenta${suffix}.`, 'quota', this.id, { cause: err });
    if (err.status === 403) return new ProviderError(`Anthropic: la clave no tiene permiso para este recurso${suffix}.`, 'auth', this.id, { cause: err });
    if (err.status === 429) {
      return err.headers.has('retry-after')
        ? new ProviderError(`Anthropic: límite de peticiones alcanzado${suffix}.`, 'rate-limit', this.id, { cause: err })
        : new ProviderError(`Anthropic: se alcanzó el tope de gasto de la cuenta; reintentar no servirá${suffix}.`, 'quota', this.id, { cause: err });
    }
    if (err.status === 529 || type === 'overloaded_error') return new ProviderError(`Anthropic: el servicio está sobrecargado; inténtalo más tarde${suffix}.`, 'overloaded', this.id, { cause: err });
    if (err.status === 413 || /prompt is too long|context/i.test(msg)) return new ProviderError(`Anthropic: la petición es demasiado grande${suffix}.`, 'context-length', this.id, { cause: err });
    if (err.status >= 500) return new ProviderError(`Anthropic: error del servidor (HTTP ${err.status})${suffix}.`, 'unavailable', this.id, { cause: err });
    return new ProviderError(`Anthropic: petición rechazada (HTTP ${err.status}, ${type || 'sin tipo'}): ${msg}${suffix}`, 'invalid-request', this.id, { cause: err });
  }
}
