import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { safeJoin, type AiSection, type AnalysisReport } from '@radar/engine';
import {
  ANTHROPIC_MODELS,
  AnthropicProvider,
  OpenAiCompatibleProvider,
  PRESETS,
  runAi,
  type Budget,
  type LlmProvider,
  type PrivacyMode,
} from '@radar/ai';

export const AI_HELP = `
IA (opcional; el análisis funciona sin ella):
  --ai <proveedor>        lmstudio | ollama | anthropic | openai | url
  --ai-url <url>          Servidor compatible con OpenAI (con --ai url, o para cambiar el puerto local)
  --ai-model <id>         Modelo. Local: por defecto el primero cargado. Anthropic: ${ANTHROPIC_MODELS.fast}
  --ai-plan-model <id>    Modelo para el plan (Anthropic: ${ANTHROPIC_MODELS.balanced})
  --privacy <modo>        local | metadatos | fragmentos
                          Por defecto: local con proveedores locales; metadatos (sin código) en la nube.
                          Enviar código a la nube exige --privacy fragmentos (secretos siempre redactados).
  --ai-limit <n>          Hallazgos a explicar (por defecto 8)
  --ai-budget <usd>       Coste máximo por análisis en la nube (por defecto 0.50)
  --no-ai-plan            No generar el plan de reducción
  Claves: RADAR_ANTHROPIC_API_KEY, RADAR_OPENAI_API_KEY (variables de entorno; nunca en archivos)
`;

export type AiProviderName = 'lmstudio' | 'ollama' | 'anthropic' | 'openai' | 'url';
const PROVIDERS: readonly AiProviderName[] = ['lmstudio', 'ollama', 'anthropic', 'openai', 'url'];
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
} as const;

type AiValues = { [K in keyof typeof AI_ARGS]?: (typeof AI_ARGS)[K]['type'] extends 'boolean' ? boolean : string };

export function parseAiOptions(v: AiValues): AiCliOptions | undefined | Error {
  const usesAi = v.ai !== undefined;
  const aiOnly = ['ai-url', 'ai-model', 'ai-plan-model', 'privacy', 'ai-limit', 'ai-budget'] as const;
  if (!usesAi) {
    const stray = aiOnly.find((k) => v[k] !== undefined);
    return stray ? new Error(`--${stray} requiere --ai.`) : undefined;
  }
  if (!PROVIDERS.includes(v.ai as AiProviderName)) return new Error(`Proveedor de IA no válido: ${v.ai} (usa ${PROVIDERS.join(', ')}).`);
  if (v.ai === 'url' && !v['ai-url']) return new Error('--ai url requiere --ai-url <url>.');
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
    ...(v['ai-url'] ? { url: v['ai-url'] } : {}),
    ...(v['ai-model'] ? { model: v['ai-model'] } : {}),
    ...(v['ai-plan-model'] ? { planModel: v['ai-plan-model'] } : {}),
    ...(v.privacy ? { privacy: v.privacy as PrivacyMode } : {}),
  };
}

export function createProvider(o: AiCliOptions, env: NodeJS.ProcessEnv = process.env): LlmProvider {
  switch (o.provider) {
    case 'lmstudio':
      return new OpenAiCompatibleProvider({ ...PRESETS.lmstudio, ...(o.url ? { baseUrl: o.url } : {}) });
    case 'ollama':
      return new OpenAiCompatibleProvider({ ...PRESETS.ollama, ...(o.url ? { baseUrl: o.url } : {}) });
    case 'anthropic':
      return new AnthropicProvider({ apiKey: env['RADAR_ANTHROPIC_API_KEY'] ?? '' });
    case 'openai': {
      const apiKey = env['RADAR_OPENAI_API_KEY'];
      if (!apiKey) throw new Error('Falta la clave de OpenAI: define RADAR_OPENAI_API_KEY.');
      return new OpenAiCompatibleProvider({ ...PRESETS.openai, apiKey });
    }
    case 'url': {
      const apiKey = env['RADAR_OPENAI_API_KEY'];
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
