/**
 * Orquestación de un análisis completo. La CLI y la aplicación de escritorio
 * comparten este código: solo cambian cómo se piden las opciones y cómo se
 * muestra el resultado.
 */
export { runPipeline, type PipelineRequest, type PipelineResult } from './pipeline.js';
export { resolveTarget, historyStart, type SourceOptions, type ResolvedTarget } from './target.js';
export { addGitContext } from './git-context.js';
export { runAiStep, createProvider, keysFromEnv, AI_PROVIDERS, PRIVACY_MODES, type AiOptions, type AiProviderName, type ApiKeys, type AiStepResult } from './ai.js';
export type { PipelineEvent, PipelineHooks } from './types.js';
