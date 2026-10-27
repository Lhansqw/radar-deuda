/**
 * Ajustes de la aplicación. Se guardan en la base de datos y se editan desde
 * la pantalla de configuración. Este módulo no depende de Node ni de Electron:
 * lo usan tanto el proceso principal (para validar) como la interfaz.
 */

export type AiProviderName = 'openrouter' | 'anthropic' | 'openai' | 'lmstudio' | 'ollama';
export type PrivacySetting = 'auto' | 'local' | 'metadatos' | 'fragmentos';
export type ReasoningLevel = 'auto' | 'none' | 'minimal' | 'low' | 'medium' | 'high';

export const AI_PROVIDER_NAMES: readonly AiProviderName[] = ['openrouter', 'anthropic', 'openai', 'lmstudio', 'ollama'];
export const PRIVACY_SETTINGS: readonly PrivacySetting[] = ['auto', 'local', 'metadatos', 'fragmentos'];
export const REASONING_LEVELS: readonly ReasoningLevel[] = ['auto', 'none', 'minimal', 'low', 'medium', 'high'];
export const LOCAL_PROVIDERS: ReadonlySet<AiProviderName> = new Set(['lmstudio', 'ollama']);

export interface AnalysisSettings {
  /** Puntos críticos con el historial de Git. */
  history: boolean;
  /** Meses de historial que se leen (y se clonan en repositorios de GitHub). */
  historyMonths: number;
  /** Vulnerabilidades (OSV) y versiones (npm): solo envía nombres y versiones de paquetes. */
  online: boolean;
  /** Memoria máxima del proceso de análisis (MB). */
  memoryLimitMb: number;
}

/** Electron usa compresión de punteros: el montículo de V8 no puede pasar de 4 GB por proceso. */
export const MEMORY_LIMIT_RANGE = { min: 512, max: 4096 } as const;

export interface AiSettings {
  /** Explicar los hallazgos con IA al terminar cada análisis. */
  auto: boolean;
  provider: AiProviderName;
  /** Vacío: el predeterminado del proveedor (Anthropic) o el primero cargado (locales). */
  model: string;
  /** OpenRouter: hasta 3 modelos de respaldo. */
  fallbackModels: string[];
  /** auto: local con proveedores locales y metadatos en la nube. */
  privacy: PrivacySetting;
  /** Hallazgos a explicar por análisis. */
  limit: number;
  /** Coste máximo por análisis en la nube (USD). */
  budgetUsd: number;
  plan: boolean;
  /** OpenRouter: permitir proveedores que guardan o entrenan con los datos. */
  allowDataCollection: boolean;
  /** OpenRouter: solo endpoints de retención cero. */
  zeroDataRetention: boolean;
  reasoning: ReasoningLevel;
  /** Servidor local (LM Studio u Ollama). Vacío: el puerto habitual. */
  localUrl: string;
}

export interface AppSettings {
  analysis: AnalysisSettings;
  ai: AiSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  analysis: { history: true, historyMonths: 12, online: false, memoryLimitMb: 4096 },
  ai: {
    auto: false,
    provider: 'openrouter',
    model: '',
    fallbackModels: [],
    privacy: 'auto',
    limit: 8,
    budgetUsd: 0.5,
    plan: true,
    allowDataCollection: false,
    zeroDataRetention: false,
    reasoning: 'auto',
    localUrl: '',
  },
};

/** Mismo formato que valida la CLI: proveedor/modelo con variante opcional (":free"). */
const OPENROUTER_MODEL = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;
/** Ids de modelos de otros proveedores (claude-haiku-5-5, gpt-…, qwen2.5-coder:7b…). */
const MODEL_ID = /^[\w.:/@-]{1,200}$/;

function isHttpUrlWithoutCredentials(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.username === '' && u.password === '';
  } catch {
    return false;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export type SettingsResult = { ok: true; value: AppSettings } | { ok: false; errors: string[] };

/**
 * Lee los campos de un objeto sin confiar en él: cada campo que no es válido
 * añade su error (en español) y devuelve un valor sustituto para seguir.
 */
class FieldReader {
  readonly errors: string[] = [];

  bool(o: Record<string, unknown>, k: string, label: string): boolean {
    if (typeof o[k] !== 'boolean') this.errors.push(`${label}: debe ser sí o no.`);
    return o[k] === true;
  }

  int(o: Record<string, unknown>, k: string, min: number, max: number, label: string): number {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) this.errors.push(`${label}: debe ser un número entero entre ${min} y ${max}.`);
    return typeof v === 'number' ? v : min;
  }

  oneOf<T extends string>(o: Record<string, unknown>, k: string, values: readonly T[], label: string): T {
    const v = o[k];
    const ok = typeof v === 'string' && values.includes(v as T);
    if (!ok) this.errors.push(`${label}: valor no válido.`);
    return (ok ? v : values[0]) as T;
  }

  str(o: Record<string, unknown>, k: string, label: string): string {
    const v = o[k];
    if (typeof v !== 'string' || v.length > 500) this.errors.push(`${label}: texto no válido.`);
    return typeof v === 'string' ? v.trim() : '';
  }

  /** Lista de textos sin vacíos. */
  strings(o: Record<string, unknown>, k: string, label: string): string[] {
    const v = o[k];
    if (!Array.isArray(v)) {
      this.errors.push(`${label}: lista no válida.`);
      return [];
    }
    return v
      .filter((m): m is string => typeof m === 'string')
      .map((m) => m.trim())
      .filter((m) => m !== '');
  }
}

function readAnalysis(r: FieldReader, a: Record<string, unknown>): AnalysisSettings {
  return {
    history: r.bool(a, 'history', 'Historial de Git'),
    historyMonths: r.int(a, 'historyMonths', 1, 120, 'Meses de historial'),
    online: r.bool(a, 'online', 'Consultas en línea'),
    memoryLimitMb: r.int(a, 'memoryLimitMb', MEMORY_LIMIT_RANGE.min, MEMORY_LIMIT_RANGE.max, 'Memoria del análisis (MB)'),
  };
}

/** Campo a campo; el orden de lectura es el orden en que se muestran los errores. */
function readAi(r: FieldReader, ai: Record<string, unknown>): AiSettings {
  const provider = r.oneOf(ai, 'provider', AI_PROVIDER_NAMES, 'Proveedor de IA');
  const model = r.str(ai, 'model', 'Modelo');
  const fallbackModels = r.strings(ai, 'fallbackModels', 'Modelos de respaldo');
  const budgetUsd = ai['budgetUsd'];
  if (typeof budgetUsd !== 'number' || !Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 50) r.errors.push('Presupuesto: debe ser mayor que 0 y como mucho 50 USD.');
  const localUrl = r.str(ai, 'localUrl', 'Servidor local');
  return {
    auto: r.bool(ai, 'auto', 'IA automática'),
    provider,
    model,
    fallbackModels,
    privacy: r.oneOf(ai, 'privacy', PRIVACY_SETTINGS, 'Privacidad'),
    limit: r.int(ai, 'limit', 1, 50, 'Hallazgos a explicar'),
    budgetUsd: typeof budgetUsd === 'number' ? budgetUsd : DEFAULT_SETTINGS.ai.budgetUsd,
    plan: r.bool(ai, 'plan', 'Plan de reducción'),
    allowDataCollection: r.bool(ai, 'allowDataCollection', 'Permitir retención de datos'),
    zeroDataRetention: r.bool(ai, 'zeroDataRetention', 'Retención cero'),
    reasoning: r.oneOf(ai, 'reasoning', REASONING_LEVELS, 'Razonamiento'),
    localUrl,
  };
}

/** Reglas que relacionan campos de la IA. */
function aiRuleErrors(s: AiSettings): string[] {
  return [
    ...(s.provider === 'openrouter' ? openRouterErrors(s) : otherProviderErrors(s)),
    ...(s.auto && s.provider === 'openrouter' && s.model === '' ? ['Para usar la IA automáticamente con OpenRouter, elige un modelo.'] : []),
    ...(!LOCAL_PROVIDERS.has(s.provider) && s.privacy === 'local' ? ['Privacidad "local" impide usar un proveedor en la nube.'] : []),
    ...(s.localUrl !== '' && !isHttpUrlWithoutCredentials(s.localUrl) ? ['Servidor local: URL no válida (p. ej. http://localhost:1234/v1).'] : []),
  ];
}

function openRouterErrors(s: AiSettings): string[] {
  const errors: string[] = [];
  if (s.model !== '' && !OPENROUTER_MODEL.test(s.model)) errors.push('Modelo: en OpenRouter el formato es proveedor/modelo.');
  if (s.fallbackModels.length > 3) errors.push('Modelos de respaldo: como mucho 3.');
  const bad = s.fallbackModels.find((m) => !OPENROUTER_MODEL.test(m));
  if (bad) errors.push(`Modelo de respaldo no válido: ${bad} (formato proveedor/modelo).`);
  if (s.allowDataCollection && s.zeroDataRetention) errors.push('Retención cero y permitir retención de datos son incompatibles.');
  return errors;
}

function otherProviderErrors(s: AiSettings): string[] {
  const errors: string[] = [];
  if (s.model !== '' && !MODEL_ID.test(s.model)) errors.push('Modelo: identificador no válido.');
  if (s.fallbackModels.length > 0) errors.push('Los modelos de respaldo solo existen en OpenRouter.');
  return errors;
}

/**
 * Valida unos ajustes completos. Devuelve todos los errores a la vez, en
 * español, para mostrarlos junto al formulario.
 */
export function validateSettings(input: unknown): SettingsResult {
  if (!isObject(input) || !isObject(input['analysis']) || !isObject(input['ai'])) return { ok: false, errors: ['Formato de ajustes no válido.'] };
  const r = new FieldReader();
  const settings: AppSettings = { analysis: readAnalysis(r, input['analysis']), ai: readAi(r, input['ai']) };
  const errors = [...r.errors, ...aiRuleErrors(settings.ai)];
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: settings };
}

/**
 * Ajustes guardados → ajustes válidos. Tolera datos de versiones anteriores:
 * cada sección que no valida se sustituye por su valor por defecto.
 */
export function normalizeSettings(stored: unknown): AppSettings {
  if (!isObject(stored)) return structuredClone(DEFAULT_SETTINGS);
  const merged = {
    analysis: { ...DEFAULT_SETTINGS.analysis, ...(isObject(stored['analysis']) ? stored['analysis'] : {}) },
    ai: { ...DEFAULT_SETTINGS.ai, ...(isObject(stored['ai']) ? stored['ai'] : {}) },
  };
  const full = validateSettings(merged);
  if (full.ok) return full.value;
  const analysisOnly = validateSettings({ analysis: merged.analysis, ai: DEFAULT_SETTINGS.ai });
  const aiOnly = validateSettings({ analysis: DEFAULT_SETTINGS.analysis, ai: merged.ai });
  return {
    analysis: analysisOnly.ok ? analysisOnly.value.analysis : structuredClone(DEFAULT_SETTINGS.analysis),
    ai: aiOnly.ok ? aiOnly.value.ai : structuredClone(DEFAULT_SETTINGS.ai),
  };
}
