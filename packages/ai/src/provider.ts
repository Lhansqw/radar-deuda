/**
 * Interfaz común a todos los proveedores de modelos. El resto de la
 * aplicación solo conoce estos tipos: cambiar de proveedor no toca el código
 * que construye el contexto, valida las respuestas o las muestra.
 */

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Esquema JSON compatible con las restricciones más estrictas (Anthropic y OpenAI "strict"). */
export interface JsonSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
}

export interface CompletionRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  maxOutputTokens: number;
  /** Pide salida estructurada al proveedor si la soporta; la respuesta se valida igualmente. */
  jsonSchema?: JsonSchemaSpec;
  signal?: AbortSignal;
}

export type FinishReason = 'stop' | 'length' | 'refusal' | 'other';

export interface CompletionResult {
  text: string;
  model: string;
  finishReason: FinishReason;
  /** null si el proveedor no informa del consumo. */
  usage: { inputTokens: number; outputTokens: number } | null;
  latencyMs: number;
  requestId?: string;
  /** Coste real cobrado, si el proveedor lo informa (USD). Tiene prioridad sobre la tabla de precios. */
  costUsd?: number;
}

/** Precio en USD por millón de tokens. */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** Dónde se ejecuta el modelo: decide qué permite la política de privacidad. */
export type Locality = 'local' | 'cloud';

export interface LlmProvider {
  /** Identificador estable (forma parte de la clave de caché). */
  readonly id: string;
  readonly label: string;
  readonly locality: Locality;
  complete(request: CompletionRequest): Promise<CompletionResult>;
  /** Modelos disponibles (en un servidor local, los cargados). */
  listModels?(signal?: AbortSignal): Promise<string[]>;
  /** Precio publicado del modelo, si el proveedor lo ofrece (para aplicar el presupuesto antes de enviar). */
  price?(model: string, signal?: AbortSignal): Promise<ModelPrice | null>;
}

export type ProviderErrorKind = 'auth' | 'rate-limit' | 'overloaded' | 'quota' | 'context-length' | 'unavailable' | 'invalid-request' | 'unknown';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderErrorKind,
    readonly provider: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ProviderError';
  }
}

/** Un host es local si es el propio equipo; cualquier otro se trata como nube. */
export function localityOf(baseUrl: string): Locality {
  const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost') ? 'local' : 'cloud';
}
