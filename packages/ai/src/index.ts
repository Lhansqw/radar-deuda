/**
 * Capa de IA independiente del proveedor. Explica, relaciona y prioriza los
 * hallazgos del motor; nunca produce evidencia ni modifica los hallazgos.
 */
export * from './provider.js';
export { OpenAiCompatibleProvider, PRESETS, type OpenAiCompatibleOptions } from './providers/openai-compatible.js';
export { AnthropicProvider, ANTHROPIC_API_VERSION, ANTHROPIC_MODELS, anthropicRetryable, type AnthropicOptions } from './providers/anthropic.js';
export { UsageTracker, BudgetExceededError, createLimiter, estimateTokens, priceFor, costOf, ANTHROPIC_PRICES, PRICES_CHECKED_AT, type Budget, type ModelRef, type Price } from './usage.js';
export { AiResponseCache } from './cache.js';
export { buildFindingContext, assertProviderAllowed, sanitizeLine, sendsCode, numbersIn, PrivacyError, DEFAULT_LIMITS, type PrivacyMode, type FindingContext, type SnippetRange, type ContextLimits, type BuildContextOptions } from './context.js';
export { EXPLANATION_SCHEMA, PLAN_SCHEMA, type RawExplanation, type RawPlan, type RawClaim } from './schemas.js';
export { validateExplanation, validatePlan, extractJson, ValidationError, type ValidatedExplanation, type ValidatedPlan } from './validate.js';
