import { HttpError, requestJson, type HttpOptions } from '@radar/sources';
import { localityOf, ProviderError, type CompletionRequest, type CompletionResult, type FinishReason, type LlmProvider, type Locality } from '../provider.js';

/**
 * Adaptador para la API de chat compatible con OpenAI (/v1/chat/completions).
 * Cubre OpenAI y los servidores locales más comunes, que exponen la misma API:
 * LM Studio, Ollama y llama.cpp. Así el soporte local no necesita código propio.
 */

export interface OpenAiCompatibleOptions extends HttpOptions {
  id: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
  /** Por defecto se deduce del host (localhost → local). */
  locality?: Locality;
  /**
   * Nombre del parámetro de longitud. OpenAI usa max_completion_tokens en sus
   * modelos actuales; los servidores locales aceptan max_tokens.
   */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  /** Campos adicionales del cuerpo (p. ej. preferencias de enrutado de OpenRouter). */
  extraBody?: Record<string, unknown>;
  /** Cabeceras adicionales (nunca deben contener la clave: va en Authorization). */
  extraHeaders?: Record<string, string>;
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number | null };
}

const FINISH: Record<string, FinishReason> = { stop: 'stop', length: 'length', content_filter: 'refusal' };

export const PRESETS = {
  lmstudio: { id: 'lmstudio', label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1' },
  ollama: { id: 'ollama', label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1' },
  openai: { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', maxTokensParam: 'max_completion_tokens' as const },
};

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: string;
  readonly label: string;
  readonly locality: Locality;
  protected readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly maxTokensParam: 'max_tokens' | 'max_completion_tokens';
  protected readonly http: HttpOptions;
  private readonly extraBody: Record<string, unknown>;
  private readonly extraHeaders: Record<string, string>;
  /** Se desactiva si el servidor rechaza response_format (algunos modelos o versiones no lo soportan). */
  private structuredOutput = true;

  constructor(options: OpenAiCompatibleOptions) {
    const { id, label, baseUrl, apiKey, locality, maxTokensParam = 'max_tokens', extraBody = {}, extraHeaders = {}, ...http } = options;
    this.extraBody = extraBody;
    this.extraHeaders = extraHeaders;
    this.id = id;
    this.label = label;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.locality = locality ?? localityOf(this.baseUrl);
    this.maxTokensParam = maxTokensParam;
    // Los modelos locales pueden tardar en generar: más margen que una API normal.
    this.http = { timeoutMs: this.locality === 'local' ? 300_000 : 120_000, retries: 2, ...http };
    if (this.locality === 'cloud' && !this.baseUrl.startsWith('https://')) {
      throw new ProviderError(`Un proveedor remoto debe usar https (${this.baseUrl}).`, 'invalid-request', id);
    }
  }

  protected headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'radar-deuda', ...this.extraHeaders };
    if (this.apiKey) h['authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    try {
      const { data } = await requestJson<{ data?: Array<{ id?: string }> }>(`${this.baseUrl}/models`, { headers: this.headers() }, { ...this.http, retries: 0, timeoutMs: 10_000, ...(signal ? { signal } : {}) });
      return (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
    } catch (err) {
      throw this.explain(err);
    }
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      ...this.extraBody,
      model: req.model,
      messages: [{ role: 'system', content: req.system }, ...req.messages],
      [this.maxTokensParam]: req.maxOutputTokens,
    };
    if (req.jsonSchema && this.structuredOutput) {
      body['response_format'] = { type: 'json_schema', json_schema: { name: req.jsonSchema.name, strict: true, schema: req.jsonSchema.schema } };
    }
    this.decorateBody(body, body['response_format'] !== undefined);
    const started = performance.now();
    let data: ChatCompletionResponse;
    let headers: Headers;
    try {
      ({ data, headers } = await requestJson<ChatCompletionResponse>(
        `${this.baseUrl}/chat/completions`,
        { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
        { ...this.http, ...(req.signal ? { signal: req.signal } : {}) },
      ));
    } catch (err) {
      // Servidor o modelo sin salida estructurada: se repite sin ella (la respuesta se valida igualmente).
      if (body['response_format'] && err instanceof HttpError && (err.status === 400 || err.status === 404) && /response_format|json_schema|grammar|structured|parameters|endpoints/i.test(err.body)) {
        this.structuredOutput = false;
        return this.complete(req);
      }
      throw this.explain(err);
    }
    const choice = data.choices?.[0];
    const refusal = choice?.message?.refusal;
    return {
      text: refusal ? '' : (choice?.message?.content ?? ''),
      model: data.model ?? req.model,
      finishReason: refusal ? 'refusal' : (FINISH[choice?.finish_reason ?? ''] ?? 'other'),
      usage:
        data.usage && typeof data.usage.prompt_tokens === 'number' && typeof data.usage.completion_tokens === 'number'
          ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
          : null,
      latencyMs: Math.round(performance.now() - started),
      ...(headers.get('x-request-id') ? { requestId: headers.get('x-request-id') as string } : {}),
      ...(typeof data.usage?.cost === 'number' ? { costUsd: data.usage.cost } : {}),
    };
  }

  /** Punto de extensión para proveedores con parámetros propios (p. ej. enrutado de OpenRouter). */
  protected decorateBody(_body: Record<string, unknown>, _structured: boolean): void {}

  protected explain(err: unknown): ProviderError {
    if (err instanceof ProviderError) return err;
    if (err instanceof HttpError) {
      const detail = err.body.slice(0, 300);
      if (err.status === 401) return new ProviderError(`${this.label}: credenciales no válidas o revocadas.`, 'auth', this.id, { cause: err });
      if (err.status === 402) return new ProviderError(`${this.label}: créditos insuficientes en la cuenta.`, 'quota', this.id, { cause: err });
      if (err.status === 403) return new ProviderError(`${this.label}: petición no permitida (permisos o filtros de contenido): ${detail}`, 'auth', this.id, { cause: err });
      if (err.status === 429) return new ProviderError(`${this.label}: límite de peticiones o de cuota alcanzado.`, 'rate-limit', this.id, { cause: err });
      if (err.status === 404) return new ProviderError(`${this.label}: modelo o ruta no encontrados (${detail}).`, 'invalid-request', this.id, { cause: err });
      if (err.status === 400 && /context|too long|maximum.*tokens/i.test(detail)) {
        return new ProviderError(`${this.label}: el contexto supera la ventana del modelo.`, 'context-length', this.id, { cause: err });
      }
      if (err.status >= 500) return new ProviderError(`${this.label}: error del servidor (HTTP ${err.status}).`, 'unavailable', this.id, { cause: err });
      return new ProviderError(`${this.label}: petición rechazada (HTTP ${err.status}): ${detail}`, 'invalid-request', this.id, { cause: err });
    }
    const message = err instanceof Error ? err.message : String(err);
    const hint = this.locality === 'local' ? ' ¿Está iniciado el servidor local (LM Studio: pestaña Developer → Start server, o `lms server start`)?' : '';
    return new ProviderError(`${this.label}: no se pudo conectar (${message}).${hint}`, 'unavailable', this.id, { cause: err });
  }
}
