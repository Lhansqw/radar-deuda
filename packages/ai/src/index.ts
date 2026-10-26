/**
 * Capa de IA independiente del proveedor. Explica, relaciona y prioriza los
 * hallazgos del motor; nunca produce evidencia ni modifica los hallazgos.
 */
export * from './provider.js';
export { OpenAiCompatibleProvider, PRESETS, type OpenAiCompatibleOptions } from './providers/openai-compatible.js';
