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
 * corrección mostrando al modelo el error; si se cortó por longitud, se repite
 * con el doble de margen. Si tampoco sale bien, se informa del fallo (nunca se
 * muestra una respuesta sin validar).
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
  let maxOutputTokens = o.maxOutputTokens;
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    const estimated = estimateTokens(o.system + messages.map((m) => m.content).join('\n'));
    const release = tracker.reserve(ref, estimated, maxOutputTokens);
    let result;
    try {
      result = await limit(() => {
        // Una tarea que esperaba turno no debe enviarse si mientras tanto se detuvo el análisis.
        signal?.throwIfAborted();
        return provider.complete({ model: o.model, system: o.system, messages, maxOutputTokens, jsonSchema: o.schema, ...(signal ? { signal } : {}) });
      });
      tracker.record(ref, result.usage, estimated, result.latencyMs, result.costUsd);
    } finally {
      release();
    }
    if (result.finishReason === 'refusal') throw new RefusalError(`${provider.label} rechazó responder a esta consulta.`);
    if (result.finishReason === 'length') {
      // Pedir una "corrección" de una respuesta cortada no sirve: el modelo necesita más margen.
      // Se repite la misma consulta con el doble de tokens de salida.
      lastError = truncationMessage(result.usage);
      maxOutputTokens *= 2;
      continue;
    }
    try {
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

/**
 * Explica un corte por longitud con lo que informa el proveedor (el límite real
 * puede ser mayor que el pedido si el proveedor añade margen para razonar). Si
 * casi todo fue razonamiento interno, lo dice.
 */
function truncationMessage(usage: { outputTokens: number; reasoningTokens?: number } | null): string {
  if (!usage) return 'La respuesta se cortó por el límite de longitud.';
  const reasoning = usage.reasoningTokens ?? 0;
  if (reasoning > 0 && reasoning >= usage.outputTokens / 2) {
    return `La respuesta se cortó por el límite de longitud: de ${usage.outputTokens} tokens de salida, el modelo dedicó ${reasoning} a razonar. Usa un modelo sin razonamiento o reduce su esfuerzo de razonamiento.`;
  }
  return `La respuesta se cortó por el límite de longitud tras ${usage.outputTokens} tokens de salida.`;
}
