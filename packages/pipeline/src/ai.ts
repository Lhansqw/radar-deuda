import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { safeJoin, type AiFixProposal, type AiSection, type AnalysisReport, type ReportComparison } from '@radar/engine';
import {
  ANTHROPIC_MODELS,
  AnthropicProvider,
  askAboutReport,
  checkApiKey,
  fixContext,
  KEY_RULES,
  OpenAiCompatibleProvider,
  OpenRouterProvider,
  planReasoning,
  PRESETS,
  PrivacyError,
  projectSummary,
  proposeFix,
  runAi,
  type Budget,
  type ChatAnswer,
  type ChatTurn,
  type LlmProvider,
  type PrivacyMode,
  type ReasoningPreference,
} from '@radar/ai';
import type { PipelineHooks } from './types.js';

export type AiProviderName = 'lmstudio' | 'ollama' | 'anthropic' | 'openrouter' | 'openai' | 'url';
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
}

/** Claves de API. Se pasan explícitamente: este paquete no lee variables de entorno ni archivos. */
export interface ApiKeys {
  openrouter?: string;
  anthropic?: string;
  openai?: string;
}

/** Claves de las variables de entorno RADAR_*_API_KEY (la forma de pasarlas en la CLI). */
export function keysFromEnv(env: NodeJS.ProcessEnv = process.env): ApiKeys {
  // Los espacios y saltos de línea al principio o al final son el error de pegado más común.
  const read = (name: string): string | undefined => {
    const v = (env[name] ?? '').trim();
    return v === '' ? undefined : v;
  };
  const keys: ApiKeys = {};
  const openrouter = read('RADAR_OPENROUTER_API_KEY');
  const anthropic = read('RADAR_ANTHROPIC_API_KEY');
  const openai = read('RADAR_OPENAI_API_KEY');
  if (openrouter) keys.openrouter = openrouter;
  if (anthropic) keys.anthropic = anthropic;
  if (openai) keys.openai = openai;
  return keys;
}

export function createProvider(o: AiOptions, keys: ApiKeys): LlmProvider {
  switch (o.provider) {
    case 'lmstudio':
      return new OpenAiCompatibleProvider({ ...PRESETS.lmstudio, ...(o.url ? { baseUrl: o.url } : {}) });
    case 'ollama':
      return new OpenAiCompatibleProvider({ ...PRESETS.ollama, ...(o.url ? { baseUrl: o.url } : {}) });
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
  }
}

async function chooseModel(o: AiOptions, provider: LlmProvider, signal: AbortSignal): Promise<string> {
  if (o.model) return o.model;
  if (o.provider === 'anthropic') return ANTHROPIC_MODELS.fast;
  if (provider.locality === 'local' && provider.listModels) {
    const models = (await provider.listModels(signal)).filter((m) => !/embed/i.test(m));
    if (models.length === 0) throw new Error(`${provider.label} no tiene ningún modelo cargado. Carga uno (LM Studio: pestaña Developer, o \`lms load <modelo>\`) o indica el modelo (--ai-model en la CLI).`);
    return models[0] as string;
  }
  throw new Error(`Falta el modelo para ${provider.label}: elígelo en Configuración (--ai-model en la CLI).`);
}

const EFFORT: Record<string, string> = { minimal: 'mínimo', low: 'bajo', medium: 'medio', high: 'alto', xhigh: 'muy alto', max: 'máximo', desconocido: 'el del modelo (no se puede ajustar)' };

/**
 * Comprueba en el catálogo que los modelos existen (un id mal escrito daría un
 * error por cada consulta) y explica qué se hará con su razonamiento. Si el
 * catálogo no responde, se sigue: las consultas informarán del problema.
 */
async function describeOpenRouterModels(provider: OpenRouterProvider, models: string[], reasoning: ReasoningPreference, hooks: PipelineHooks, signal: AbortSignal): Promise<void> {
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
    hooks.warn(`Combinas modelos gratuitos y de pago (${paid.join(', ')}): si responde uno de pago, se cobrará su precio.`);
  }
  for (const id of models) {
    const m = byId.get(id);
    if (!m) {
      const base = id.replace(/:[a-z]+$/i, '');
      const similar = catalog.filter((c) => c.id.startsWith(`${base.split('/')[0]}/`) && c.id.includes(base.split('/')[1]?.split(/[-.]/)[0] ?? '')).slice(0, 3);
      throw new Error(
        `El modelo "${id}" no existe en OpenRouter.${similar.length > 0 ? ` ¿Quisiste decir ${similar.map((c) => c.id).join(', ')}?` : ''} Elige uno de la lista en Configuración (en la CLI: npm run models).`,
      );
    }
    const plan = planReasoning(m, reasoning);
    const parts = [`Modelo ${m.id}${m.free ? ' (gratuito)' : ''}`];
    if (m.reasoning) parts.push(plan.effort === 'none' ? 'razona, pero se desactiva su razonamiento' : `razona: esfuerzo ${EFFORT[plan.effort] ?? plan.effort}${m.reasoning.mandatory ? ' (no se puede desactivar)' : ''}, con ${plan.headroom} tokens de margen`);
    if (!m.structuredOutputs) parts.push('no admite salida estructurada: puede necesitar más reintentos');
    hooks.info(`${parts.join(' · ')}.`);
  }
}

export interface AiStepResult {
  section: AiSection;
  /** Proveedor y modelos usados, para mostrar. */
  label: string;
}

/** Ejecuta la capa de IA sobre un informe ya generado. */
export async function runAiStep(report: AnalysisReport, o: AiOptions, keys: ApiKeys, hooks: PipelineHooks, signal: AbortSignal, cacheBase: string | null): Promise<AiStepResult> {
  const provider = createProvider(o, keys);
  const privacy: PrivacyMode = o.privacy ?? (provider.locality === 'local' ? 'local' : 'metadatos');
  const model = await chooseModel(o, provider, signal);
  const planModel = o.planModel ?? (o.provider === 'anthropic' ? ANTHROPIC_MODELS.balanced : model);
  if (o.provider === 'openrouter') {
    hooks.info(
      o.allowDataCollection
        ? 'OpenRouter: se permiten proveedores que pueden guardar o entrenar con los datos.'
        : `OpenRouter: solo proveedores que no guardan ni entrenan con los datos${o.zeroDataRetention ? ', con retención cero' : ''}.`,
    );
  }
  if (provider instanceof OpenRouterProvider) {
    await describeOpenRouterModels(provider, [...new Set([model, planModel, ...(o.fallbackModels ?? [])])], o.reasoning ?? 'auto', hooks, signal);
    if (o.fallbackModels) hooks.info(`Respaldo: si ${model} falla, se probará ${o.fallbackModels.join(', luego ')}.`);
  }
  if (provider.locality === 'cloud') {
    hooks.info(
      privacy === 'fragmentos'
        ? `IA en la nube (${provider.label}): se enviarán metadatos y fragmentos de código redactados. Presupuesto máximo ${o.budgetUsd.toFixed(2)} USD.`
        : `IA en la nube (${provider.label}): solo se envían metadatos de los hallazgos, sin código. Presupuesto máximo ${o.budgetUsd.toFixed(2)} USD.`,
    );
  } else hooks.info(`IA local (${provider.label}, modelo ${model}): nada sale del equipo.`);

  const readText = reportReader(report);
  const budget: Budget = { maxRequests: o.limit * 2 + 4, maxCostUsd: o.budgetUsd };
  const section = await runAi(report, {
    provider,
    model,
    planModel,
    privacy,
    readText,
    cacheDir: cacheBase ? path.join(cacheBase, 'ai') : null,
    budget,
    limit: o.limit,
    plan: o.findingIds ? false : o.plan,
    ...(o.findingIds ? { findingIds: o.findingIds } : {}),
    signal,
    onProgress: (done, total) => hooks.progress?.({ phase: 'ai', done, total }),
  });
  return { section, label: `${provider.label} · ${model}${planModel !== model ? ` (plan: ${planModel})` : ''}` };
}

/** Lee archivos del repositorio analizado sin salir de su carpeta. */
function reportReader(report: AnalysisReport): (rel: string) => Promise<string | null> {
  return async (rel) => {
    const abs = safeJoin(report.root, rel);
    return abs ? readFile(abs, 'utf8').catch(() => null) : null;
  };
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
  /** OpenRouter puede enviarlo a proveedores que guardan o entrenan con los datos. */
  mayRetain: boolean;
}

/** Lo que se enviaría para proponer una corrección, sin enviar nada. */
export async function previewFix(report: AnalysisReport, findingId: string, o: AiOptions, keys: ApiKeys): Promise<FixPreview> {
  const provider = createProvider(o, keys);
  const ctx = await fixContext(report, findingId, reportReader(report), provider.locality === 'local' ? 'local' : 'fragmentos');
  return {
    text: ctx.text,
    snippets: ctx.snippets,
    provider: provider.label,
    cloud: provider.locality === 'cloud',
    needsConsent: fixPrivacy(o, provider, false) === null,
    mayRetain: o.provider === 'openrouter' && o.allowDataCollection === true,
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
    readText: reportReader(report),
    cacheDir: s.cacheBase ? path.join(s.cacheBase, 'ai') : null,
    budget: { maxRequests: 3, maxCostUsd: o.budgetUsd },
    signal: s.signal,
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
  const privacy: PrivacyMode = o.privacy ?? (provider.locality === 'local' ? 'local' : 'metadatos');
  return askAboutReport(report, history, question, {
    provider,
    model,
    privacy,
    budget: { maxRequests: 1, maxCostUsd: o.budgetUsd },
    signal: s.signal,
    projectSummary: await projectSummary(report, reportReader(report)),
    ...(s.comparison ? { comparison: s.comparison } : {}),
  });
}
