/**
 * Capa de IA independiente del proveedor. Explica, relaciona y prioriza los
 * hallazgos del motor; nunca produce evidencia ni modifica los hallazgos.
 */
export * from './provider.js';
export { OpenAiCompatibleProvider, PRESETS, type OpenAiCompatibleOptions } from './providers/openai-compatible.js';
export { AnthropicProvider, ANTHROPIC_API_VERSION, ANTHROPIC_MODELS, anthropicRetryable, type AnthropicOptions } from './providers/anthropic.js';
export { UsageTracker, BudgetExceededError, createLimiter, estimateTokens, priceFor, costOf, ANTHROPIC_PRICES, PRICES_CHECKED_AT, type Budget, type ModelRef, type Price } from './usage.js';
export { AiResponseCache } from './cache.js';
export { buildFindingContext, assertProviderAllowed, sanitizeLine, OMITTED_LINE, sendsCode, numbersIn, PrivacyError, DEFAULT_LIMITS, type PrivacyMode, type FindingContext, type SnippetRange, type ContextLimits, type BuildContextOptions } from './context.js';
export { EXPLANATION_SCHEMA, FIX_SCHEMA, PLAN_SCHEMA, type RawExplanation, type RawFix, type RawPlan, type RawClaim } from './schemas.js';
export { validateExplanation, validatePlan, extractJson, ValidationError, type ValidatedExplanation, type ValidatedPlan } from './validate.js';
export { runAi, selectForAi, projectSummary, type AiRunOptions, type TriageOptions } from './tasks.js';
export { askJson, RefusalError, type AskOptions, type RunnerDeps } from './runner.js';
export { EXPLAIN_PROMPT_VERSION, FIX_PROMPT_VERSION, PLAN_PROMPT_VERSION } from './prompts.js';
export { formatAiSection } from './format.js';
export { fixContext, fixUnavailableReason, FixUnavailableError, proposeFix, validateFix, FIX_CONTEXT_LIMITS, type FixOptions, type ValidatedFix } from './fix.js';
export { applyEdits, buildHunks, diffOps, EditError, formatPatch, joinLines, splitLines, type FilePatch, type LineEdit, type TextLines } from './diff.js';
export { OpenRouterProvider, fetchOpenRouterModels, OPENROUTER_BASE_URL, planReasoning, REASONING_PREFERENCES, type OpenRouterOptions, type OpenRouterModel, type OpenRouterKeyStatus, type ReasoningPreference, type ReasoningPlan } from './providers/openrouter.js';
