/**
 * Ajustes de la aplicación. Se guardan en la base de datos y se editan desde
 * la pantalla de configuración. Este módulo no depende de Node ni de Electron:
 * lo usan tanto el proceso principal (para validar) como la interfaz.
 */

/** «incluida»: modelos gratuitos con la cuenta de la aplicación, sin clave (fase 14). */
export type AiProviderName = 'incluida' | 'openrouter' | 'anthropic' | 'openai' | 'lmstudio' | 'ollama';
export type PrivacySetting = 'auto' | 'local' | 'metadatos' | 'fragmentos';
export type ReasoningLevel = 'auto' | 'none' | 'minimal' | 'low' | 'medium' | 'high';

export const AI_PROVIDER_NAMES: readonly AiProviderName[] = ['incluida', 'openrouter', 'anthropic', 'openai', 'lmstudio', 'ollama'];
export const PRIVACY_SETTINGS: readonly PrivacySetting[] = ['auto', 'local', 'metadatos', 'fragmentos'];
export const REASONING_LEVELS: readonly ReasoningLevel[] = ['auto', 'none', 'minimal', 'low', 'medium', 'high'];
/**
 * Tema de la interfaz. No forma parte de AppSettings: es del equipo, no de la
 * cuenta, y se aplica también en la pantalla de acceso (main/appearance.ts).
 */
export type ThemeSetting = 'dark' | 'light' | 'system';
export const THEME_SETTINGS: readonly ThemeSetting[] = ['dark', 'light', 'system'];
export const DEFAULT_THEME: ThemeSetting = 'dark';

export const LOCAL_PROVIDERS: ReadonlySet<AiProviderName> = new Set(['lmstudio', 'ollama']);

/** Idiomas de la interfaz, de los hallazgos y de las respuestas de la IA. */
export type Locale = 'es' | 'en';
/** «auto»: el idioma del sistema (español si es es-*, inglés en otro caso). */
export type LanguageSetting = 'auto' | Locale;
export const LOCALES: readonly Locale[] = ['es', 'en'];
export const LANGUAGE_SETTINGS: readonly LanguageSetting[] = ['auto', 'es', 'en'];
export const isLanguageSetting = (v: unknown): v is LanguageSetting => typeof v === 'string' && (LANGUAGE_SETTINGS as readonly string[]).includes(v);

/** Idioma que se usa: el elegido o, en «auto», el del sistema. */
export function resolveLocale(setting: LanguageSetting, systemLang: string): Locale {
  if (setting !== 'auto') return setting;
  return /^es\b/i.test(systemLang) ? 'es' : 'en';
}

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
  /** Vacío: el predeterminado del proveedor (Anthropic) o el primero cargado (locales). La IA incluida no lo usa. */
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

export interface CloudSettings {
  /** Guardar proyectos e historial (sin código) en la nube de la cuenta (fase 13b). */
  sync: boolean;
}

export interface UpdateSettings {
  /** Al abrir, consultar en GitHub si hay una versión nueva (solo avisa: no descarga nada). */
  check: boolean;
}

export interface AppSettings {
  analysis: AnalysisSettings;
  ai: AiSettings;
  cloud: CloudSettings;
  updates: UpdateSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  analysis: { history: true, historyMonths: 12, online: false, memoryLimitMb: 4096 },
  ai: {
    auto: false,
    provider: 'incluida',
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
  cloud: { sync: true },
  updates: { check: true },
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

/** Textos de los errores de validación, en los dos idiomas. */
const MESSAGES = {
  es: {
    bool: (l: string) => `${l}: debe ser sí o no.`,
    int: (l: string, min: number, max: number) => `${l}: debe ser un número entero entre ${min} y ${max}.`,
    oneOf: (l: string) => `${l}: valor no válido.`,
    str: (l: string) => `${l}: texto no válido.`,
    list: (l: string) => `${l}: lista no válida.`,
    labels: {
      history: 'Historial de Git',
      historyMonths: 'Meses de historial',
      online: 'Consultas en línea',
      memory: 'Memoria del análisis (MB)',
      provider: 'Proveedor de IA',
      model: 'Modelo',
      fallbackModels: 'Modelos de respaldo',
      localUrl: 'Servidor local',
      auto: 'IA automática',
      privacy: 'Privacidad',
      limit: 'Hallazgos a explicar',
      plan: 'Plan de reducción',
      allowDataCollection: 'Permitir retención de datos',
      zeroDataRetention: 'Retención cero',
      reasoning: 'Razonamiento',
      sync: 'Copia en la nube',
      updates: 'Buscar versiones nuevas',
    },
    budget: 'Presupuesto: debe ser mayor que 0 y como mucho 50 USD.',
    autoNeedsModel: 'Para usar la IA automáticamente con OpenRouter, elige un modelo.',
    localPrivacy: 'Privacidad "local" impide usar un proveedor en la nube.',
    localUrl: 'Servidor local: URL no válida (p. ej. http://localhost:1234/v1).',
    openRouterModel: 'Modelo: en OpenRouter el formato es proveedor/modelo.',
    maxFallbacks: 'Modelos de respaldo: como mucho 3.',
    badFallback: (m: string) => `Modelo de respaldo no válido: ${m} (formato proveedor/modelo).`,
    retentionConflict: 'Retención cero y permitir retención de datos son incompatibles.',
    badModelId: 'Modelo: identificador no válido.',
    fallbacksOnlyOpenRouter: 'Los modelos de respaldo solo existen en OpenRouter.',
    badFormat: 'Formato de ajustes no válido.',
  },
  en: {
    bool: (l: string) => `${l}: must be yes or no.`,
    int: (l: string, min: number, max: number) => `${l}: must be a whole number between ${min} and ${max}.`,
    oneOf: (l: string) => `${l}: invalid value.`,
    str: (l: string) => `${l}: invalid text.`,
    list: (l: string) => `${l}: invalid list.`,
    labels: {
      history: 'Git history',
      historyMonths: 'Months of history',
      online: 'Online lookups',
      memory: 'Analysis memory (MB)',
      provider: 'AI provider',
      model: 'Model',
      fallbackModels: 'Fallback models',
      localUrl: 'Local server',
      auto: 'Automatic AI',
      privacy: 'Privacy',
      limit: 'Findings to explain',
      plan: 'Reduction plan',
      allowDataCollection: 'Allow data retention',
      zeroDataRetention: 'Zero retention',
      reasoning: 'Reasoning',
      sync: 'Cloud copy',
      updates: 'Check for new versions',
    },
    budget: 'Budget: must be greater than 0 and at most 50 USD.',
    autoNeedsModel: 'To use AI automatically with OpenRouter, choose a model.',
    localPrivacy: '"Local" privacy does not allow a cloud provider.',
    localUrl: 'Local server: invalid URL (e.g. http://localhost:1234/v1).',
    openRouterModel: 'Model: on OpenRouter the format is provider/model.',
    maxFallbacks: 'Fallback models: at most 3.',
    badFallback: (m: string) => `Invalid fallback model: ${m} (format provider/model).`,
    retentionConflict: 'Zero retention and allowing data retention are incompatible.',
    badModelId: 'Model: invalid identifier.',
    fallbacksOnlyOpenRouter: 'Fallback models only exist on OpenRouter.',
    badFormat: 'Invalid settings format.',
  },
};
type Messages = (typeof MESSAGES)['es'];
// Las dos versiones deben tener las mismas claves.
const _parity: Record<Locale, Messages> = MESSAGES;
void _parity;

export type SettingsResult = { ok: true; value: AppSettings } | { ok: false; errors: string[] };

/**
 * Lee los campos de un objeto sin confiar en él: cada campo que no es válido
 * añade su error (en el idioma elegido) y devuelve un valor sustituto para seguir.
 */
class FieldReader {
  readonly errors: string[] = [];

  constructor(readonly m: Messages) {}

  bool(o: Record<string, unknown>, k: string, label: string): boolean {
    if (typeof o[k] !== 'boolean') this.errors.push(this.m.bool(label));
    return o[k] === true;
  }

  int(o: Record<string, unknown>, k: string, min: number, max: number, label: string): number {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) this.errors.push(this.m.int(label, min, max));
    return typeof v === 'number' ? v : min;
  }

  oneOf<T extends string>(o: Record<string, unknown>, k: string, values: readonly T[], label: string): T {
    const v = o[k];
    const ok = typeof v === 'string' && values.includes(v as T);
    if (!ok) this.errors.push(this.m.oneOf(label));
    return (ok ? v : values[0]) as T;
  }

  str(o: Record<string, unknown>, k: string, label: string): string {
    const v = o[k];
    if (typeof v !== 'string' || v.length > 500) this.errors.push(this.m.str(label));
    return typeof v === 'string' ? v.trim() : '';
  }

  /** Lista de textos sin vacíos. */
  strings(o: Record<string, unknown>, k: string, label: string): string[] {
    const v = o[k];
    if (!Array.isArray(v)) {
      this.errors.push(this.m.list(label));
      return [];
    }
    return v
      .filter((m): m is string => typeof m === 'string')
      .map((m) => m.trim())
      .filter((m) => m !== '');
  }
}

function readAnalysis(r: FieldReader, a: Record<string, unknown>): AnalysisSettings {
  const L = r.m.labels;
  return {
    history: r.bool(a, 'history', L.history),
    historyMonths: r.int(a, 'historyMonths', 1, 120, L.historyMonths),
    online: r.bool(a, 'online', L.online),
    memoryLimitMb: r.int(a, 'memoryLimitMb', MEMORY_LIMIT_RANGE.min, MEMORY_LIMIT_RANGE.max, L.memory),
  };
}

/** Campo a campo; el orden de lectura es el orden en que se muestran los errores. */
function readAi(r: FieldReader, ai: Record<string, unknown>): AiSettings {
  const L = r.m.labels;
  const provider = r.oneOf(ai, 'provider', AI_PROVIDER_NAMES, L.provider);
  const model = r.str(ai, 'model', L.model);
  const fallbackModels = r.strings(ai, 'fallbackModels', L.fallbackModels);
  const budgetUsd = ai['budgetUsd'];
  if (typeof budgetUsd !== 'number' || !Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 50) r.errors.push(r.m.budget);
  const localUrl = r.str(ai, 'localUrl', L.localUrl);
  return {
    auto: r.bool(ai, 'auto', L.auto),
    provider,
    model,
    fallbackModels,
    privacy: r.oneOf(ai, 'privacy', PRIVACY_SETTINGS, L.privacy),
    limit: r.int(ai, 'limit', 1, 50, L.limit),
    budgetUsd: typeof budgetUsd === 'number' ? budgetUsd : DEFAULT_SETTINGS.ai.budgetUsd,
    plan: r.bool(ai, 'plan', L.plan),
    allowDataCollection: r.bool(ai, 'allowDataCollection', L.allowDataCollection),
    zeroDataRetention: r.bool(ai, 'zeroDataRetention', L.zeroDataRetention),
    reasoning: r.oneOf(ai, 'reasoning', REASONING_LEVELS, L.reasoning),
    localUrl,
  };
}

function readCloud(r: FieldReader, c: Record<string, unknown>): CloudSettings {
  return { sync: r.bool(c, 'sync', r.m.labels.sync) };
}

function readUpdates(r: FieldReader, u: Record<string, unknown>): UpdateSettings {
  return { check: r.bool(u, 'check', r.m.labels.updates) };
}

/** Reglas que relacionan campos de la IA. */
function aiRuleErrors(s: AiSettings, m: Messages): string[] {
  return [
    // La IA incluida elige sus modelos en el servidor: el modelo y los respaldos no se usan.
    ...(s.provider === 'openrouter' ? openRouterErrors(s, m) : s.provider === 'incluida' ? [] : otherProviderErrors(s, m)),
    ...(s.auto && s.provider === 'openrouter' && s.model === '' ? [m.autoNeedsModel] : []),
    ...(!LOCAL_PROVIDERS.has(s.provider) && s.privacy === 'local' ? [m.localPrivacy] : []),
    ...(s.localUrl !== '' && !isHttpUrlWithoutCredentials(s.localUrl) ? [m.localUrl] : []),
  ];
}

function openRouterErrors(s: AiSettings, m: Messages): string[] {
  const errors: string[] = [];
  if (s.model !== '' && !OPENROUTER_MODEL.test(s.model)) errors.push(m.openRouterModel);
  if (s.fallbackModels.length > 3) errors.push(m.maxFallbacks);
  const bad = s.fallbackModels.find((f) => !OPENROUTER_MODEL.test(f));
  if (bad) errors.push(m.badFallback(bad));
  if (s.allowDataCollection && s.zeroDataRetention) errors.push(m.retentionConflict);
  return errors;
}

function otherProviderErrors(s: AiSettings, m: Messages): string[] {
  const errors: string[] = [];
  if (s.model !== '' && !MODEL_ID.test(s.model)) errors.push(m.badModelId);
  if (s.fallbackModels.length > 0) errors.push(m.fallbacksOnlyOpenRouter);
  return errors;
}

/**
 * Valida unos ajustes completos. Devuelve todos los errores a la vez, en el
 * idioma pedido, para mostrarlos junto al formulario.
 */
export function validateSettings(input: unknown, locale: Locale = 'es'): SettingsResult {
  const m = MESSAGES[locale];
  if (!isObject(input) || !isObject(input['analysis']) || !isObject(input['ai']) || !isObject(input['cloud']) || !isObject(input['updates'])) return { ok: false, errors: [m.badFormat] };
  const r = new FieldReader(m);
  const settings: AppSettings = {
    analysis: readAnalysis(r, input['analysis']),
    ai: readAi(r, input['ai']),
    cloud: readCloud(r, input['cloud']),
    updates: readUpdates(r, input['updates']),
  };
  const errors = [...r.errors, ...aiRuleErrors(settings.ai, m)];
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
    cloud: { ...DEFAULT_SETTINGS.cloud, ...(isObject(stored['cloud']) ? stored['cloud'] : {}) },
    updates: { ...DEFAULT_SETTINGS.updates, ...(isObject(stored['updates']) ? stored['updates'] : {}) },
  };
  const full = validateSettings(merged);
  if (full.ok) return full.value;
  // Cada sección por separado, con las demás por defecto.
  const only = <K extends keyof AppSettings>(key: K): AppSettings[K] => {
    const r = validateSettings({ ...DEFAULT_SETTINGS, [key]: merged[key] });
    return r.ok ? r.value[key] : structuredClone(DEFAULT_SETTINGS[key]);
  };
  return { analysis: only('analysis'), ai: only('ai'), cloud: only('cloud'), updates: only('updates') };
}
