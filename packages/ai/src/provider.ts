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
  /** null si el proveedor no informa del consumo. outputTokens incluye los de razonamiento. */
  usage: { inputTokens: number; outputTokens: number; reasoningTokens?: number } | null;
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
  /**
   * Comprobación previa a un análisis (clave válida, saldo, cuota). Lanza un
   * ProviderError si el análisis no puede salir bien; devuelve avisos si puede
   * salir solo en parte. Si el servicio no responde, no bloquea: devuelve [].
   */
  preflight?(plan: PreflightPlan, signal?: AbortSignal): Promise<string[]>;
}

export interface PreflightPlan {
  models: string[];
  /** Peticiones previstas sin contar reintentos. */
  requests: number;
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

export interface ApiKeyRules {
  /** Nombre del proveedor para los mensajes. */
  provider: string;
  /** Variable de entorno de la que se lee (para indicar dónde corregirla). */
  envVar: string;
  /** Prefijo con el que empiezan las claves de este proveedor. */
  prefix?: string;
  minLength: number;
}

/**
 * Comprueba la forma de una clave de API ANTES de enviar ninguna petición, para
 * detectar el error más habitual (pegarla incompleta o con espacios) con un
 * mensaje útil en lugar de un 401 por cada consulta. Los mensajes nunca incluyen
 * la clave ni parte de ella: solo su longitud.
 */
export function checkApiKey(key: string, rules: ApiKeyRules, providerId: string): void {
  const { provider, envVar, prefix, minLength } = rules;
  if (!key) throw new ProviderError(`Falta la clave de ${provider} (${envVar}).`, 'auth', providerId);
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f\u200b-\u200d\ufeff]/.test(key)) {
    throw new ProviderError(`La clave de ${provider} (${envVar}) contiene espacios o caracteres invisibles. Vuelve a pegarla.`, 'auth', providerId);
  }
  if (key.length < minLength || (prefix !== undefined && !key.startsWith(prefix))) {
    const expected = prefix !== undefined ? `debería empezar por "${prefix}" y tener al menos ${minLength} caracteres` : `debería tener al menos ${minLength} caracteres`;
    throw new ProviderError(
      `La clave de ${provider} (${envVar}) no tiene el formato esperado: tiene ${key.length} caracteres y ${expected}. Probablemente no se pegó completa; cópiala de nuevo desde el panel del proveedor.`,
      'auth',
      providerId,
    );
  }
}

export const KEY_RULES = {
  openrouter: { provider: 'OpenRouter', envVar: 'RADAR_OPENROUTER_API_KEY', prefix: 'sk-or-', minLength: 40 },
  anthropic: { provider: 'Anthropic', envVar: 'RADAR_ANTHROPIC_API_KEY', prefix: 'sk-ant-', minLength: 40 },
  openai: { provider: 'OpenAI', envVar: 'RADAR_OPENAI_API_KEY', prefix: 'sk-', minLength: 20 },
} as const satisfies Record<string, ApiKeyRules>;
