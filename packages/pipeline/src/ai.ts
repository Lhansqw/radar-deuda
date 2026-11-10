import path from 'node:path';
import { repoReader, translator, type AiFixProposal, type AiSection, type AnalysisReport, type Locale, type ReportComparison, type Translate } from '@radar/engine';
import {
  ANTHROPIC_MODELS,
  AnthropicProvider,
  askAboutReport,
  checkApiKey,
  fixContext,
  IncludedAiProvider,
  INCLUDED_DEFAULT_MODEL,
  KEY_RULES,
  OpenAiCompatibleProvider,
  OpenRouterProvider,
  planReasoning,
  PRESETS,
  PrivacyError,
  projectSummary,
  proposeFix,
  runAi,
  type ChatAnswer,
  type ChatTurn,
  type LlmProvider,
  type PrivacyMode,
  type ReasoningPreference,
} from '@radar/ai';
import type { PipelineHooks } from './types.js';

/** «incluida»: la IA de la aplicación de escritorio a través de su proyecto de Supabase (necesita sesión; la CLI no la ofrece). */
export type AiProviderName = 'lmstudio' | 'ollama' | 'anthropic' | 'openrouter' | 'openai' | 'url' | 'incluida';
/** Los que se pueden elegir en la CLI. */
export const AI_PROVIDERS: readonly AiProviderName[] = ['lmstudio', 'ollama', 'anthropic', 'openrouter', 'openai', 'url'];
export const PRIVACY_MODES: readonly PrivacyMode[] = ['local', 'metadatos', 'fragmentos'];

export interface AiOptions {
  provider: AiProviderName;
  url?: string;
  model?: string;
  planModel?: string;
  privacy?: PrivacyMode;
  limit: number;
  budgetUsd: number;
  plan: boolean;
  zeroDataRetention?: boolean;
  allowDataCollection?: boolean;
  reasoning?: ReasoningPreference;
  fallbackModels?: string[];
  /** Explicar exactamente estos hallazgos (sin plan) en lugar de seleccionarlos. */
  findingIds?: string[];
  /** Idioma de las respuestas y de los mensajes (por defecto, español). */
  locale?: Locale;
}

/** Claves de API. Se pasan explícitamente: este paquete no lee variables de entorno ni archivos. */
export interface ApiKeys {
  openrouter?: string;
  anthropic?: string;
  openai?: string;
  /** IA incluida: token de la sesión del usuario (la URL de la función va en AiOptions.url). */
  incluida?: string;
}

/** Claves de las variables de entorno RADAR_*_API_KEY (la forma de pasarlas en la CLI). */
const KEY_ENV_VARS = {
  openrouter: 'RADAR_OPENROUTER_API_KEY',
  anthropic: 'RADAR_ANTHROPIC_API_KEY',
  openai: 'RADAR_OPENAI_API_KEY',
} as const satisfies Partial<Record<keyof ApiKeys, string>>;

export function keysFromEnv(env: NodeJS.ProcessEnv = process.env): ApiKeys {
  const keys: ApiKeys = {};
  for (const [name, variable] of Object.entries(KEY_ENV_VARS) as Array<[keyof typeof KEY_ENV_VARS, string]>) {
    // Los espacios y saltos de línea al principio o al final son el error de pegado más común.
    const value = (env[variable] ?? '').trim();
    if (value !== '') keys[name] = value;
  }
  return keys;
}

export function createProvider(o: AiOptions, keys: ApiKeys): LlmProvider {
  switch (o.provider) {
    case 'lmstudio':
    case 'ollama':
      return new OpenAiCompatibleProvider({ ...PRESETS[o.provider], ...(o.url ? { baseUrl: o.url } : {}) });
    case 'anthropic':
      return new AnthropicProvider({ apiKey: keys.anthropic ?? '' });
    case 'openrouter':
      return new OpenRouterProvider({
        apiKey: keys.openrouter ?? '',
        ...(o.zeroDataRetention ? { zeroDataRetention: true } : {}),
        ...(o.allowDataCollection ? { allowDataCollection: true } : {}),
        ...(o.reasoning ? { reasoning: o.reasoning } : {}),
        ...(o.fallbackModels ? { fallbackModels: o.fallbackModels } : {}),
      });
    case 'openai': {
      const apiKey = keys.openai ?? '';
      checkApiKey(apiKey, KEY_RULES.openai, 'openai');
      return new OpenAiCompatibleProvider({ ...PRESETS.openai, apiKey });
    }
    case 'url':
      return new OpenAiCompatibleProvider({ id: 'personalizado', label: `Servidor ${o.url}`, baseUrl: o.url as string, ...(keys.openai ? { apiKey: keys.openai } : {}) });
    case 'incluida':
      if (!o.url) throw new Error('La IA incluida necesita la conexión con Supabase de la aplicación.');
      return new IncludedAiProvider({ baseUrl: o.url, sessionToken: keys.incluida ?? '', ...(o.reasoning ? { reasoning: o.reasoning } : {}) });
  }
}

async function chooseModel(o: AiOptions, provider: LlmProvider, signal: AbortSignal): Promise<string> {
  if (o.model) return o.model;
  if (o.provider === 'anthropic') return ANTHROPIC_MODELS.fast;
  // Los modelos de la IA incluida los elige el servidor.
  if (o.provider === 'incluida') return INCLUDED_DEFAULT_MODEL;
  if (provider.locality === 'local' && provider.listModels) {
    const models = (await provider.listModels(signal)).filter((m) => !/embed/i.test(m));
    if (models.length === 0) throw new Error(`${provider.label} no tiene ningún modelo cargado. Carga uno (LM Studio: pestaña Developer, o \`lms load <modelo>\`) o indica el modelo (--ai-model en la CLI).`);
    return models[0] as string;
  }
  throw new Error(`Falta el modelo para ${provider.label}: elígelo en Configuración (--ai-model en la CLI).`);
}

const EFFORT: Record<string, string> = { minimal: 'mínimo', low: 'bajo', medium: 'medio', high: 'alto', xhigh: 'muy alto', max: 'máximo', desconocido: 'el del modelo (no se puede ajustar)' };
const EFFORT_EN: Record<string, string> = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'very high', max: 'maximum', desconocido: "the model's own (cannot be adjusted)" };

/**
 * Comprueba en el catálogo que los modelos existen (un id mal escrito daría un
 * error por cada consulta) y explica qué se hará con su razonamiento. Si el
 * catálogo no responde, se sigue: las consultas informarán del problema.
 */
async function describeOpenRouterModels(
  provider: OpenRouterProvider,
  models: string[],
  reasoning: ReasoningPreference,
  hooks: PipelineHooks,
  signal: AbortSignal,
  tr: Translate,
): Promise<void> {
  let catalog;
  try {
    catalog = await provider.models(signal);
  } catch {
    return;
  }
  if (catalog.length === 0) return;
  const byId = new Map(catalog.map((m) => [m.id, m]));
  const paid = models.filter((id) => byId.get(id)?.free === false);
  if (paid.length > 0 && models.some((id) => byId.get(id)?.free)) {
    hooks.warn(tr(`Combinas modelos gratuitos y de pago (${paid.join(', ')}): si responde uno de pago, se cobrará su precio.`, `You are mixing free and paid models (${paid.join(', ')}): if a paid one answers, its price will be charged.`));
  }
  for (const id of models) {
    const m = byId.get(id);
    if (!m) throw unknownModel(id, catalog, tr);
    hooks.info(describeModel(m, reasoning, tr));
  }
}

type CatalogEntry = Awaited<ReturnType<OpenRouterProvider['models']>>[number];

/** Error de un modelo que no está en el catálogo, con hasta tres parecidos. */
function unknownModel(id: string, catalog: readonly CatalogEntry[], tr: Translate): Error {
  const [vendor, name = ''] = id.replace(/:[a-z]+$/i, '').split('/');
  const family = name.split(/[-.]/)[0] ?? '';
  const similar = catalog.filter((c) => c.id.startsWith(`${vendor}/`) && c.id.includes(family)).slice(0, 3);
  const hint = similar.map((c) => c.id).join(', ');
  return new Error(
    tr(
      `El modelo "${id}" no existe en OpenRouter.${similar.length > 0 ? ` ¿Quisiste decir ${hint}?` : ''} Elige uno de la lista en Configuración (en la CLI: npm run models).`,
      `The model "${id}" does not exist on OpenRouter.${similar.length > 0 ? ` Did you mean ${hint}?` : ''} Choose one from the list in Settings (in the CLI: npm run models).`,
    ),
  );
}

/** «Modelo x (gratuito) · razona: esfuerzo bajo… · …»: qué se hará con un modelo del catálogo. */
function describeModel(m: CatalogEntry, reasoning: ReasoningPreference, tr: Translate): string {
  const parts = [tr(`Modelo ${m.id}${m.free ? ' (gratuito)' : ''}`, `Model ${m.id}${m.free ? ' (free)' : ''}`)];
  if (m.reasoning) parts.push(reasoningText(m, planReasoning(m, reasoning), tr));
  if (!m.structuredOutputs) parts.push(tr('no admite salida estructurada: puede necesitar más reintentos', 'does not support structured output: it may need more retries'));
  return `${parts.join(' · ')}.`;
}

function reasoningText(m: CatalogEntry, plan: ReturnType<typeof planReasoning>, tr: Translate): string {
  if (plan.effort === 'none') return tr('razona, pero se desactiva su razonamiento', 'reasons, but its reasoning is turned off');
  const mandatory = m.reasoning?.mandatory === true;
  return tr(
    `razona: esfuerzo ${EFFORT[plan.effort] ?? plan.effort}${mandatory ? ' (no se puede desactivar)' : ''}, con ${plan.headroom} tokens de margen`,
    `reasons: ${EFFORT_EN[plan.effort] ?? plan.effort} effort${mandatory ? ' (cannot be turned off)' : ''}, with ${plan.headroom} tokens of headroom`,
  );
}

export interface AiStepResult {
  section: AiSection;
  /** Proveedor y modelos usados, para mostrar. */
  label: string;
}

/** Privacidad si no se eligió: con un proveedor local nada sale del equipo; en la nube, solo metadatos. */
function defaultPrivacy(o: AiOptions, provider: LlmProvider): PrivacyMode {
  return o.privacy ?? (provider.locality === 'local' ? 'local' : 'metadatos');
}

/** Caché de las respuestas de la IA, dentro de la del motor. */
function aiCacheDir(cacheBase: string | null): string | null {
  return cacheBase ? path.join(cacheBase, 'ai') : null;
}

/** Ejecuta la capa de IA sobre un informe ya generado. */
export async function runAiStep(report: AnalysisReport, o: AiOptions, keys: ApiKeys, hooks: PipelineHooks, signal: AbortSignal, cacheBase: string | null): Promise<AiStepResult> {
  const provider = createProvider(o, keys);
  const privacy = defaultPrivacy(o, provider);
  const model = await chooseModel(o, provider, signal);
  const planModel = capableModel(o, model);
  await announce(o, provider, { privacy, model, planModel }, hooks, signal);

  const section = await runAi(report, {
    provider,
    model,
    planModel,
    privacy,
    readText: repoReader(report.root),
    cacheDir: aiCacheDir(cacheBase),
    budget: { maxRequests: o.limit * 2 + 4, maxCostUsd: o.budgetUsd },
    limit: o.limit,
    plan: o.findingIds ? false : o.plan,
    ...(o.findingIds ? { findingIds: o.findingIds } : {}),
    ...(o.locale ? { locale: o.locale } : {}),
    signal,
    onProgress: (done, total) => hooks.progress?.({ phase: 'ai', done, total }),
  });
  return { section, label: `${provider.label} · ${model}${planModel !== model ? ` (plan: ${planModel})` : ''}` };
}

/** Explica al usuario qué se va a enviar, a quién y con qué modelos, antes de enviar nada. */
async function announce(o: AiOptions, provider: LlmProvider, run: { privacy: PrivacyMode; model: string; planModel: string }, hooks: PipelineHooks, signal: AbortSignal): Promise<void> {
  const { privacy, model, planModel } = run;
  const tr = translator(o.locale);
  if (o.provider === 'incluida') {
    hooks.info(
      tr(
        'IA incluida: el modelo de la aplicación, a través de su proyecto de Supabase (sin clave propia); su proveedor recibe lo que se envía según la privacidad elegida.',
        "Included AI: the app's model, through its Supabase project (no key of your own); its provider receives what is sent according to the chosen privacy.",
      ),
    );
  }
  if (o.provider === 'openrouter') {
    hooks.info(
      o.allowDataCollection
        ? tr('OpenRouter: se permiten proveedores que pueden guardar o entrenar con los datos.', 'OpenRouter: providers that may store or train on the data are allowed.')
        : tr(
            `OpenRouter: solo proveedores que no guardan ni entrenan con los datos${o.zeroDataRetention ? ', con retención cero' : ''}.`,
            `OpenRouter: only providers that do not store or train on the data${o.zeroDataRetention ? ', with zero retention' : ''}.`,
          ),
    );
  }
  if (provider instanceof OpenRouterProvider) {
    await describeOpenRouterModels(provider, [...new Set([model, planModel, ...(o.fallbackModels ?? [])])], o.reasoning ?? 'auto', hooks, signal, tr);
    if (o.fallbackModels) {
      hooks.info(tr(`Respaldo: si ${model} falla, se probará ${o.fallbackModels.join(', luego ')}.`, `Fallback: if ${model} fails, ${o.fallbackModels.join(', then ')} will be tried.`));
    }
  }
  const budget = o.budgetUsd.toFixed(2);
  if (provider.locality === 'cloud') {
    hooks.info(
      privacy === 'fragmentos'
        ? tr(
            `IA en la nube (${provider.label}): se enviarán metadatos y fragmentos de código redactados. Presupuesto máximo ${budget} USD.`,
            `Cloud AI (${provider.label}): metadata and redacted code snippets will be sent. Maximum budget ${budget} USD.`,
          )
        : tr(
            `IA en la nube (${provider.label}): solo se envían metadatos de los hallazgos, sin código. Presupuesto máximo ${budget} USD.`,
            `Cloud AI (${provider.label}): only finding metadata is sent, no code. Maximum budget ${budget} USD.`,
          ),
    );
  } else hooks.info(tr(`IA local (${provider.label}, modelo ${model}): nada sale del equipo.`, `Local AI (${provider.label}, model ${model}): nothing leaves the computer.`));
}

/** Modelo para las tareas que más razonan (plan y propuestas de código). */
function capableModel(o: AiOptions, model: string): string {
  return o.planModel ?? (o.provider === 'anthropic' ? ANTHROPIC_MODELS.balanced : model);
}

/**
 * Privacidad con la que se enviaría el código para proponer una corrección:
 * con un proveedor local, `local`; en la nube, `fragmentos` si la
 * configuración ya lo permite o si el usuario lo confirma para esta petición.
 * null: hace falta esa confirmación.
 */
export function fixPrivacy(o: AiOptions, provider: LlmProvider, consent: boolean): 'local' | 'fragmentos' | null {
  if (provider.locality === 'local') return 'local';
  if (o.privacy === 'local') throw new PrivacyError(`La privacidad «solo en este equipo» no permite usar ${provider.label}, que se ejecuta fuera del equipo.`);
  return o.privacy === 'fragmentos' || consent ? 'fragmentos' : null;
}

export interface FixPreview {
  /** Texto exacto que se enviaría al modelo (metadatos y fragmentos con los secretos ocultos). */
  text: string;
  snippets: Array<{ file: string; startLine: number; endLine: number }>;
  provider: string;
  cloud: boolean;
  /** Hay que pedir permiso al usuario antes de enviarlo. */
  needsConsent: boolean;
  /** OpenRouter (o la IA incluida) puede enviarlo a proveedores que guardan o entrenan con los datos. */
  mayRetain: boolean;
}

/** Lo que se enviaría para proponer una corrección, sin enviar nada. */
export async function previewFix(report: AnalysisReport, findingId: string, o: AiOptions, keys: ApiKeys): Promise<FixPreview> {
  const provider = createProvider(o, keys);
  const ctx = await fixContext(report, findingId, repoReader(report.root), provider.locality === 'local' ? 'local' : 'fragmentos');
  return {
    text: ctx.text,
    snippets: ctx.snippets,
    provider: provider.label,
    cloud: provider.locality === 'cloud',
    needsConsent: fixPrivacy(o, provider, false) === null,
    mayRetain: o.provider === 'incluida' || (o.provider === 'openrouter' && o.allowDataCollection === true),
  };
}

export interface FixStepOptions {
  /** El usuario confirmó enviar el fragmento para esta petición. */
  consent: boolean;
  cacheBase: string | null;
  signal: AbortSignal;
}

/** Propuesta de corrección de un hallazgo con la IA configurada. */
export async function proposeFixStep(report: AnalysisReport, findingId: string, o: AiOptions, keys: ApiKeys, s: FixStepOptions): Promise<AiFixProposal> {
  const provider = createProvider(o, keys);
  const privacy = fixPrivacy(o, provider, s.consent);
  if (privacy === null) {
    throw new PrivacyError(
      'Para proponer una corrección hay que enviar el fragmento de código del hallazgo: confírmalo en la aplicación o elige la privacidad «Fragmentos de código» (en la CLI: --privacy fragmentos).',
    );
  }
  const model = capableModel(o, await chooseModel(o, provider, s.signal));
  return proposeFix(report, findingId, {
    provider,
    model,
    privacy,
    readText: repoReader(report.root),
    cacheDir: aiCacheDir(s.cacheBase),
    budget: { maxRequests: 3, maxCostUsd: o.budgetUsd },
    signal: s.signal,
    ...(o.locale ? { locale: o.locale } : {}),
  });
}

export interface AskStepOptions {
  comparison?: ReportComparison | null;
  signal: AbortSignal;
}

/** Pregunta sobre un análisis (solo se envían metadatos del informe, nunca código). */
export async function askStep(report: AnalysisReport, history: readonly ChatTurn[], question: string, o: AiOptions, keys: ApiKeys, s: AskStepOptions): Promise<ChatAnswer> {
  const provider = createProvider(o, keys);
  const model = await chooseModel(o, provider, s.signal);
  const privacy = defaultPrivacy(o, provider);
  return askAboutReport(report, history, question, {
    provider,
    model,
    privacy,
    budget: { maxRequests: 1, maxCostUsd: o.budgetUsd },
    signal: s.signal,
    projectSummary: await projectSummary(report, repoReader(report.root)),
    ...(s.comparison ? { comparison: s.comparison } : {}),
    ...(o.locale ? { locale: o.locale } : {}),
  });
}
