/**
 * Orquestación de un análisis completo. La CLI y la aplicación de escritorio
 * comparten este código: solo cambian cómo se piden las opciones y cómo se
 * muestra el resultado.
 */
export { runPipeline, type PipelineRequest, type PipelineResult } from './pipeline.js';
export { resolveTarget, historyStart, type SourceOptions, type ResolvedTarget } from './target.js';
export { addGitContext } from './git-context.js';
export { cacheUsage, clearCache, folderSize, pruneCache, type CacheCleanup, type CachePart, type CachePartName, type CacheUsage } from './maintenance.js';
export {
  runAiStep,
  createProvider,
  keysFromEnv,
  fixPrivacy,
  previewFix,
  proposeFixStep,
  askStep,
  AI_PROVIDERS,
  PRIVACY_MODES,
  type AiOptions,
  type AiProviderName,
  type ApiKeys,
  type AiStepResult,
  type FixPreview,
  type FixStepOptions,
  type AskStepOptions,
} from './ai.js';
export type { PipelineEvent, PipelineHooks } from './types.js';
