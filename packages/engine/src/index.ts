/**
 * API pública del motor de análisis. El motor es independiente de la interfaz
 * y de la capa de IA: solo lee archivos y devuelve un informe estructurado.
 */
export * from './types.js';
export { analyzeRepository, safeJoin, type AnalyzeOptions } from './engine.js';
export { resolveConfig, configHash, DEFAULT_CONFIG, DEFAULT_THRESHOLDS, ENGINE_VERSION, type ConfigOverrides } from './config.js';
export { computeScore } from './score.js';
export { defaultCacheDir } from './cache.js';
export { redactSecrets } from './analyzers/secrets.js';
export * from './analyzers/index.js';
export { formatReport } from './report.js';
