import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { safeJoin, type AiSection, type AnalysisReport } from '@radar/engine';
import {
  ANTHROPIC_MODELS,
  AnthropicProvider,
  checkApiKey,
  KEY_RULES,
  OpenAiCompatibleProvider,
  OpenRouterProvider,
  planReasoning,
  PRESETS,
  runAi,
  type Budget,
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
    if (models.length === 0) throw new Error(`${provider.label} no tiene ningún modelo cargado. Carga uno (LM Studio: pestaña Developer, o \`lms load <modelo>\`) o indica --ai-model.`);
    return models[0] as string;
  }
  throw new Error(`Indica el modelo con --ai-model para ${provider.label}.`);
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
        `El modelo "${id}" no existe en OpenRouter.${similar.length > 0 ? ` ¿Quisiste decir ${similar.map((c) => c.id).join(', ')}?` : ''} Lista los disponibles con: npm run models`,
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
        ? 'OpenRouter: se permiten proveedores que pueden guardar o entrenar con los datos (--ai-allow-data-collection).'
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

  const readText = async (rel: string): Promise<string | null> => {
    const abs = safeJoin(report.root, rel);
    return abs ? readFile(abs, 'utf8').catch(() => null) : null;
  };
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
    plan: o.plan,
    signal,
    onProgress: (done, total) => hooks.progress?.({ phase: 'ai', done, total }),
  });
  return { section, label: `${provider.label} · ${model}${planModel !== model ? ` (plan: ${planModel})` : ''}` };
}
