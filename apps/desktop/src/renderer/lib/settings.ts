import { LOCAL_PROVIDERS, type AiProviderName, type AiSettings } from '../../shared/settings.js';

/**
 * Al cambiar de proveedor deja de tener sentido el modelo elegido (y sus
 * respaldos), y «solo en este equipo» exige un proveedor local.
 */
export function providerChange(ai: AiSettings, next: AiProviderName): Partial<AiSettings> {
  return { provider: next, model: '', fallbackModels: [], ...(ai.privacy === 'local' && !LOCAL_PROVIDERS.has(next) ? { privacy: 'auto' as const } : {}) };
}

/** Permitir que los proveedores guarden datos es incompatible con exigir retención cero. */
export function dataCollectionChange(allow: boolean): Partial<AiSettings> {
  return { allowDataCollection: allow, ...(allow ? { zeroDataRetention: false } : {}) };
}
