import type { AiUsage } from '@radar/engine';
import type { Locality } from './provider.js';

/**
 * Precios en USD por millón de tokens. Fuente:
 * https://platform.claude.com/docs/en/about-claude/pricing (consultado el 2026-10-25).
 * Los modelos locales cuestan 0; los proveedores sin precio conocido devuelven
 * null y su coste se informa como desconocido (el límite de tokens sigue activo).
 */
export interface Price {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Tramo para prompts largos (Haiku 5.5 cambia de precio por encima de 100 K tokens). */
  longPrompt?: { aboveInputTokens: number; inputPerMTok: number; outputPerMTok: number };
}

export const PRICES_CHECKED_AT = '2026-10-25';

export const ANTHROPIC_PRICES: Readonly<Record<string, Price>> = {
  'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5, longPrompt: { aboveInputTokens: 100_000, inputPerMTok: 0.5, outputPerMTok: 2.5 } },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20 },
  'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50 },
};

export function priceFor(providerId: string, locality: Locality, model: string): Price | null {
  if (locality === 'local') return { inputPerMTok: 0, outputPerMTok: 0 };
  if (providerId === 'anthropic') return ANTHROPIC_PRICES[model] ?? null;
  return null;
}

export function costOf(price: Price, inputTokens: number, outputTokens: number): number {
  const tier = price.longPrompt && inputTokens > price.longPrompt.aboveInputTokens ? price.longPrompt : price;
  return (inputTokens * tier.inputPerMTok + outputTokens * tier.outputPerMTok) / 1_000_000;
}

/**
 * Estimación conservadora de tokens (≈3 caracteres por token, por encima de la
 * media real en español y código) para comprobar el presupuesto antes de enviar.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export interface Budget {
  maxRequests?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /** Solo se aplica a proveedores con precio conocido. */
  maxCostUsd?: number;
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

export interface ModelRef {
  providerId: string;
  locality: Locality;
  model: string;
}

/**
 * Lleva la cuenta del consumo y aplica el presupuesto ANTES de cada petición
 * con el peor caso (entrada estimada + salida máxima), así nunca se supera.
 */
export class UsageTracker {
  private requests = 0;
  private cacheHits = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cost = 0;
  private costUnknown = false;
  private latencyTotal = 0;
  private latencyMax = 0;
  /** Reservas de peticiones en curso (concurrentes). */
  private reserved = { requests: 0, input: 0, output: 0, cost: 0 };

  constructor(private readonly budget: Budget = {}) {}

  /** Reserva capacidad para una petición; lanza BudgetExceededError si no cabe. */
  reserve(ref: ModelRef, estimatedInput: number, maxOutput: number): () => void {
    const b = this.budget;
    const price = priceFor(ref.providerId, ref.locality, ref.model);
    const worstCost = price ? costOf(price, estimatedInput, maxOutput) : 0;
    const req = this.requests + this.reserved.requests + 1;
    const inp = this.inputTokens + this.reserved.input + estimatedInput;
    const out = this.outputTokens + this.reserved.output + maxOutput;
    const cost = this.cost + this.reserved.cost + worstCost;
    if (b.maxRequests !== undefined && req > b.maxRequests) throw new BudgetExceededError(`Se alcanzó el máximo de ${b.maxRequests} peticiones a la IA.`);
    if (b.maxInputTokens !== undefined && inp > b.maxInputTokens) throw new BudgetExceededError(`Se alcanzaría el límite de ${b.maxInputTokens} tokens de entrada.`);
    if (b.maxOutputTokens !== undefined && out > b.maxOutputTokens) throw new BudgetExceededError(`Se alcanzaría el límite de ${b.maxOutputTokens} tokens de salida.`);
    if (b.maxCostUsd !== undefined && price && cost > b.maxCostUsd) throw new BudgetExceededError(`Se alcanzaría el presupuesto de ${b.maxCostUsd.toFixed(2)} USD.`);
    const r = { requests: 1, input: estimatedInput, output: maxOutput, cost: worstCost };
    this.reserved.requests += r.requests;
    this.reserved.input += r.input;
    this.reserved.output += r.output;
    this.reserved.cost += r.cost;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reserved.requests -= r.requests;
      this.reserved.input -= r.input;
      this.reserved.output -= r.output;
      this.reserved.cost -= r.cost;
    };
  }

  /** Registra el consumo real (o la estimación si el proveedor no lo informa). */
  record(ref: ModelRef, usage: { inputTokens: number; outputTokens: number } | null, estimatedInput: number, latencyMs: number): void {
    const input = usage?.inputTokens ?? estimatedInput;
    const output = usage?.outputTokens ?? 0;
    this.requests++;
    this.inputTokens += input;
    this.outputTokens += output;
    const price = priceFor(ref.providerId, ref.locality, ref.model);
    if (price) this.cost += costOf(price, input, output);
    else this.costUnknown = true;
    this.latencyTotal += latencyMs;
    this.latencyMax = Math.max(this.latencyMax, latencyMs);
  }

  recordCacheHit(): void {
    this.cacheHits++;
  }

  summary(): AiUsage {
    return {
      requests: this.requests,
      cacheHits: this.cacheHits,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.costUnknown ? null : Number(this.cost.toFixed(6)),
      latencyMsTotal: Math.round(this.latencyTotal),
      latencyMsMax: Math.round(this.latencyMax),
    };
  }
}

/** Limita las tareas simultáneas (un modelo local suele atender una petición a la vez). */
export function createLimiter(concurrency: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = (): void => {
    active--;
    queue.shift()?.();
  };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      next();
    }
  };
}
