import { AiResponseCache } from './cache.js';
import type { JsonSchemaSpec, LlmProvider } from './provider.js';
import { estimateTokens, type UsageTracker } from './usage.js';
import { extractJson, ValidationError } from './validate.js';

export interface RunnerDeps {
  provider: LlmProvider;
  tracker: UsageTracker;
  cache: AiResponseCache;
  limit: <T>(task: () => Promise<T>) => Promise<T>;
  signal?: AbortSignal;
}

export interface AskOptions<T> {
  model: string;
  system: string;
  user: string;
  schema: JsonSchemaSpec;
  maxOutputTokens: number;
  /** Partes adicionales de la clave de caché (versión del prompt, privacidad…). */
  cacheKey: string[];
  validate: (data: unknown) => T;
}

export class RefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefusalError';
  }
}

/**
 * Una consulta estructurada: caché → presupuesto → límite de concurrencia →
 * proveedor → validación. Si la respuesta no es válida, se pide UNA
 * corrección mostrando al modelo el error; si tampoco lo es, se informa del
 * fallo (nunca se muestra una respuesta sin validar).
 */
export async function askJson<T>(deps: RunnerDeps, o: AskOptions<T>): Promise<{ value: T; fromCache: boolean; model: string }> {
  const { provider, tracker, cache, limit, signal } = deps;
  const key = AiResponseCache.key([...o.cacheKey, provider.id, o.model, o.system, o.user]);
  const cached = await cache.get<{ value: unknown; model: string }>(key);
  if (cached) {
    try {
      const value = o.validate(cached.value);
      tracker.recordCacheHit();
      return { value, fromCache: true, model: cached.model };
    } catch {
      /* entrada antigua que ya no valida: se vuelve a pedir */
    }
  }

  const ref = { providerId: provider.id, locality: provider.locality, model: o.model };
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [{ role: 'user', content: o.user }];
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    const estimated = estimateTokens(o.system + messages.map((m) => m.content).join('\n'));
    const release = tracker.reserve(ref, estimated, o.maxOutputTokens);
    let result;
    try {
      result = await limit(() => provider.complete({ model: o.model, system: o.system, messages, maxOutputTokens: o.maxOutputTokens, jsonSchema: o.schema, ...(signal ? { signal } : {}) }));
      tracker.record(ref, result.usage, estimated, result.latencyMs, result.costUsd);
    } finally {
      release();
    }
    if (result.finishReason === 'refusal') throw new RefusalError(`${provider.label} rechazó responder a esta consulta.`);
    try {
      if (result.finishReason === 'length') throw new ValidationError('La respuesta se cortó por el límite de longitud.');
      const value = o.validate(extractJson(result.text));
      await cache.set(key, { value: extractJson(result.text), model: result.model }).catch(() => undefined);
      return { value, fromCache: false, model: result.model };
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      lastError = err.message;
      messages.push(
        { role: 'assistant', content: result.text.slice(0, 4000) || '(respuesta vacía)' },
        { role: 'user', content: `Tu respuesta anterior no es válida: ${err.message} Devuelve solo el JSON corregido, siguiendo exactamente el formato pedido.` },
      );
    }
  }
  throw new ValidationError(`Respuesta no válida tras un reintento: ${lastError}`);
}
