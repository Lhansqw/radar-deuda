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
  REASONING_PREFERENCES,
  runAi,
  type Budget,
  type LlmProvider,
  type PrivacyMode,
  type ReasoningPreference,
} from '@radar/ai';

export const AI_HELP = `
IA (opcional; el análisis funciona sin ella):
  --ai <proveedor>        lmstudio | ollama | anthropic | openrouter | openai | url
  --ai-url <url>          Servidor compatible con OpenAI (con --ai url, o para cambiar el puerto local)
  --ai-model <id>         Modelo. Local: por defecto el primero cargado. Anthropic: ${ANTHROPIC_MODELS.fast}
                          OpenRouter: obligatorio, p. ej. proveedor/modelo (ver openrouter.ai/models)
  --ai-plan-model <id>    Modelo para el plan (Anthropic: ${ANTHROPIC_MODELS.balanced})
  --privacy <modo>        local | metadatos | fragmentos
                          Por defecto: local con proveedores locales; metadatos (sin código) en la nube.
                          Enviar código a la nube exige --privacy fragmentos (secretos siempre redactados).
  --ai-limit <n>          Hallazgos a explicar (por defecto 8)
  --ai-budget <usd>       Coste máximo por análisis en la nube (por defecto 0.50)
  --no-ai-plan            No generar el plan de reducción
  --ai-zdr                OpenRouter: solo endpoints de retención cero (Zero Data Retention)
  --ai-allow-data-collection
                          OpenRouter: permitir proveedores que guardan o entrenan con los datos (por defecto no)
  --ai-fallback <ids>     OpenRouter: modelos de respaldo separados por comas (hasta 3), por si el
                          principal falla o está saturado. Para no pagar, usa solo modelos :free
  --ai-reasoning <nivel>  OpenRouter, modelos que razonan: auto | none | minimal | low | medium | high
                          (por defecto auto: lo desactiva si el modelo lo permite; si no, el mínimo)
  Claves: RADAR_ANTHROPIC_API_KEY, RADAR_OPENROUTER_API_KEY, RADAR_OPENAI_API_KEY
          (variables de entorno; nunca en archivos)
`;

export type AiProviderName = 'lmstudio' | 'ollama' | 'anthropic' | 'openrouter' | 'openai' | 'url';
const PROVIDERS: readonly AiProviderName[] = ['lmstudio', 'ollama', 'anthropic', 'openrouter', 'openai', 'url'];
const PRIVACY: readonly PrivacyMode[] = ['local', 'metadatos', 'fragmentos'];

export interface AiCliOptions {
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

export const AI_ARGS = {
  ai: { type: 'string' },
  'ai-url': { type: 'string' },
  'ai-model': { type: 'string' },
  'ai-plan-model': { type: 'string' },
  privacy: { type: 'string' },
  'ai-limit': { type: 'string' },
  'ai-budget': { type: 'string' },
  'no-ai-plan': { type: 'boolean', default: false },
  'ai-zdr': { type: 'boolean', default: false },
  'ai-allow-data-collection': { type: 'boolean', default: false },
  'ai-reasoning': { type: 'string' },
  'ai-fallback': { type: 'string' },
} as const;

type AiValues = { [K in keyof typeof AI_ARGS]?: (typeof AI_ARGS)[K]['type'] extends 'boolean' ? boolean : string };

export function parseAiOptions(v: AiValues): AiCliOptions | undefined | Error {
  const usesAi = v.ai !== undefined;
  const aiOnly = ['ai-url', 'ai-model', 'ai-plan-model', 'privacy', 'ai-limit', 'ai-budget', 'ai-reasoning', 'ai-fallback'] as const;
  if (!usesAi) {
    const stray = aiOnly.find((k) => v[k] !== undefined);
    return stray ? new Error(`--${stray} requiere --ai.`) : undefined;
  }
  if (!PROVIDERS.includes(v.ai as AiProviderName)) return new Error(`Proveedor de IA no válido: ${v.ai} (usa ${PROVIDERS.join(', ')}).`);
  if (v.ai === 'url' && !v['ai-url']) return new Error('--ai url requiere --ai-url <url>.');
  if ((v['ai-zdr'] || v['ai-allow-data-collection']) && v.ai !== 'openrouter') return new Error('--ai-zdr y --ai-allow-data-collection solo aplican a --ai openrouter.');
  if (v['ai-zdr'] && v['ai-allow-data-collection']) return new Error('--ai-zdr y --ai-allow-data-collection son incompatibles.');
  if (v['ai-reasoning'] !== undefined) {
    if (v.ai !== 'openrouter') return new Error('--ai-reasoning solo aplica a --ai openrouter.');
    if (!REASONING_PREFERENCES.includes(v['ai-reasoning'] as ReasoningPreference)) return new Error(`Nivel de razonamiento no válido: ${v['ai-reasoning']} (usa ${REASONING_PREFERENCES.join(', ')}).`);
  }
  const fallback = v['ai-fallback'] !== undefined ? v['ai-fallback'].split(',').map((m) => m.trim()).filter((m) => m !== '') : undefined;
  if (fallback !== undefined) {
    if (v.ai !== 'openrouter') return new Error('--ai-fallback solo aplica a --ai openrouter.');
    if (fallback.length === 0 || fallback.length > 3) return new Error('--ai-fallback necesita entre 1 y 3 modelos separados por comas.');
    const bad = fallback.find((m) => !OpenRouterProvider.isValidModelId(m));
    if (bad) return new Error(`Id de modelo de respaldo no válido: ${bad} (formato proveedor/modelo).`);
  }
  if (v.ai === 'openrouter') {
    if (!v['ai-model']) return new Error('--ai openrouter requiere --ai-model <proveedor/modelo> (elige uno en https://openrouter.ai/models).');
    for (const m of [v['ai-model'], v['ai-plan-model']]) {
      if (m !== undefined && !OpenRouterProvider.isValidModelId(m)) return new Error(`Id de modelo de OpenRouter no válido: ${m} (formato proveedor/modelo).`);
    }
  }
  if (v.privacy !== undefined && !PRIVACY.includes(v.privacy as PrivacyMode)) return new Error(`Modo de privacidad no válido: ${v.privacy} (usa ${PRIVACY.join(', ')}).`);
  const limit = v['ai-limit'] !== undefined ? Number(v['ai-limit']) : 8;
  const budget = v['ai-budget'] !== undefined ? Number(v['ai-budget']) : 0.5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return new Error('--ai-limit debe ser un entero entre 1 y 50.');
  if (!Number.isFinite(budget) || budget <= 0) return new Error('--ai-budget debe ser un número positivo (USD).');
  return {
    provider: v.ai as AiProviderName,
    limit,
    budgetUsd: budget,
    plan: !v['no-ai-plan'],
    ...(v['ai-zdr'] ? { zeroDataRetention: true } : {}),
    ...(v['ai-allow-data-collection'] ? { allowDataCollection: true } : {}),
    ...(v['ai-reasoning'] ? { reasoning: v['ai-reasoning'] as ReasoningPreference } : {}),
    ...(fallback ? { fallbackModels: fallback } : {}),
    ...(v['ai-url'] ? { url: v['ai-url'] } : {}),
    ...(v['ai-model'] ? { model: v['ai-model'] } : {}),
    ...(v['ai-plan-model'] ? { planModel: v['ai-plan-model'] } : {}),
    ...(v.privacy ? { privacy: v.privacy as PrivacyMode } : {}),
  };
}

export function createProvider(o: AiCliOptions, env: NodeJS.ProcessEnv = process.env): LlmProvider {
  // Los espacios y saltos de línea al principio o al final son el error de pegado más común.
  const key = (name: string): string => (env[name] ?? '').trim();
  switch (o.provider) {
    case 'lmstudio':
      return new OpenAiCompatibleProvider({ ...PRESETS.lmstudio, ...(o.url ? { baseUrl: o.url } : {}) });
    case 'ollama':
      return new OpenAiCompatibleProvider({ ...PRESETS.ollama, ...(o.url ? { baseUrl: o.url } : {}) });
    case 'anthropic':
      return new AnthropicProvider({ apiKey: key('RADAR_ANTHROPIC_API_KEY') });
    case 'openrouter':
      return new OpenRouterProvider({
        apiKey: key('RADAR_OPENROUTER_API_KEY'),
        ...(o.zeroDataRetention ? { zeroDataRetention: true } : {}),
        ...(o.allowDataCollection ? { allowDataCollection: true } : {}),
        ...(o.reasoning ? { reasoning: o.reasoning } : {}),
        ...(o.fallbackModels ? { fallbackModels: o.fallbackModels } : {}),
      });
    case 'openai': {
      const apiKey = key('RADAR_OPENAI_API_KEY');
      checkApiKey(apiKey, KEY_RULES.openai, 'openai');
      return new OpenAiCompatibleProvider({ ...PRESETS.openai, apiKey });
    }
    case 'url': {
      const apiKey = key('RADAR_OPENAI_API_KEY');
      return new OpenAiCompatibleProvider({ id: 'personalizado', label: `Servidor ${o.url}`, baseUrl: o.url as string, ...(apiKey ? { apiKey } : {}) });
    }
  }
}

async function chooseModel(o: AiCliOptions, provider: LlmProvider, signal: AbortSignal): Promise<string> {
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
async function describeOpenRouterModels(provider: OpenRouterProvider, models: string[], reasoning: ReasoningPreference, io: { info(m: string): void; warn(m: string): void }, signal: AbortSignal): Promise<void> {
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
    io.warn(`Combinas modelos gratuitos y de pago (${paid.join(', ')}): si responde uno de pago, se cobrará su precio.`);
  }
  for (const id of models) {
    const m = byId.get(id);
    if (!m) {
      const base = id.replace(/:[a-z]+$/i, '');
      const similar = catalog.filter((c) => c.id.startsWith(`${base.split('/')[0]}/`) && c.id.includes(base.split('/')[1]?.split(/[-.]/)[0] ?? '')).slice(0, 3);
      throw new Error(
        `El modelo "${id}" no existe en OpenRouter.${similar.length > 0 ? ` ¿Quisiste decir ${similar.map((c) => c.id).join(', ')}?` : ''} Consulta los disponibles en https://openrouter.ai/models`,
      );
    }
    const plan = planReasoning(m, reasoning);
    const parts = [`Modelo ${m.id}${m.free ? ' (gratuito)' : ''}`];
    if (m.reasoning) parts.push(plan.effort === 'none' ? 'razona, pero se desactiva su razonamiento' : `razona: esfuerzo ${EFFORT[plan.effort] ?? plan.effort}${m.reasoning.mandatory ? ' (no se puede desactivar)' : ''}, con ${plan.headroom} tokens de margen`);
    if (!m.structuredOutputs) parts.push('no admite salida estructurada: puede necesitar más reintentos');
    io.info(`${parts.join(' · ')}.`);
  }
}

export interface AiRunResult {
  section: AiSection;
  label: string;
}

export async function runAiFromCli(
  report: AnalysisReport,
  o: AiCliOptions,
  io: { info(m: string): void; warn(m: string): void },
  signal: AbortSignal,
  cacheBase: string | null,
): Promise<AiRunResult> {
  const provider = createProvider(o);
  const privacy: PrivacyMode = o.privacy ?? (provider.locality === 'local' ? 'local' : 'metadatos');
  const model = await chooseModel(o, provider, signal);
  const planModel = o.planModel ?? (o.provider === 'anthropic' ? ANTHROPIC_MODELS.balanced : model);
  if (o.provider === 'openrouter') {
    io.info(
      o.allowDataCollection
        ? 'OpenRouter: se permiten proveedores que pueden guardar o entrenar con los datos (--ai-allow-data-collection).'
        : `OpenRouter: solo proveedores que no guardan ni entrenan con los datos${o.zeroDataRetention ? ', con retención cero' : ''}.`,
    );
  }
  if (provider instanceof OpenRouterProvider) {
    await describeOpenRouterModels(provider, [...new Set([model, planModel, ...(o.fallbackModels ?? [])])], o.reasoning ?? 'auto', io, signal);
    if (o.fallbackModels) io.info(`Respaldo: si ${model} falla, se probará ${o.fallbackModels.join(', luego ')}.`);
  }
  if (provider.locality === 'cloud') {
    io.info(
      privacy === 'fragmentos'
        ? `IA en la nube (${provider.label}): se enviarán metadatos y fragmentos de código redactados. Presupuesto máximo ${o.budgetUsd.toFixed(2)} USD.`
        : `IA en la nube (${provider.label}): solo se envían metadatos de los hallazgos, sin código. Presupuesto máximo ${o.budgetUsd.toFixed(2)} USD.`,
    );
  } else io.info(`IA local (${provider.label}, modelo ${model}): nada sale del equipo.`);

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
    onProgress: (done, total) => {
      if (process.stderr.isTTY) process.stderr.write(`\rIA: ${done}/${total}…   `);
      if (done === total && process.stderr.isTTY) process.stderr.write('\r'.padEnd(30) + '\r');
    },
  });
  return { section, label: `${provider.label} · ${model}${planModel !== model ? ` (plan: ${planModel})` : ''}` };
}
