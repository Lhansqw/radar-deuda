import { ANTHROPIC_MODELS, OpenRouterProvider, REASONING_PREFERENCES, type PrivacyMode, type ReasoningPreference } from '@radar/ai';
import { AI_PROVIDERS as PROVIDERS, PRIVACY_MODES as PRIVACY, type AiOptions, type AiProviderName } from '@radar/pipeline';

export const AI_HELP = `
IA (opcional; el análisis funciona sin ella):
  --ai <proveedor>        lmstudio | ollama | anthropic | openrouter | openai | url
  --ai-url <url>          Servidor compatible con OpenAI (con --ai url, o para cambiar el puerto local)
  --ai-model <id>         Modelo. Local: por defecto el primero cargado. Anthropic: ${ANTHROPIC_MODELS.fast}
                          OpenRouter: obligatorio, p. ej. proveedor/modelo (lista: npm run models)
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

/** Opciones de IA de la CLI: las mismas que acepta el análisis completo. */
export type AiCliOptions = AiOptions;
export type { AiProviderName };

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

/** Opciones que no tienen sentido sin --ai. */
const AI_ONLY = ['ai-url', 'ai-model', 'ai-plan-model', 'privacy', 'ai-limit', 'ai-budget', 'ai-reasoning', 'ai-fallback'] as const;
const MAX_FALLBACKS = 3;

/** Lista separada por comas, sin vacíos; undefined si no se indicó. */
function splitList(value: string | undefined): string[] | undefined {
  return value?.split(',').map((m) => m.trim()).filter((m) => m !== '');
}

const limitOf = (v: AiValues): number => (v['ai-limit'] !== undefined ? Number(v['ai-limit']) : 8);
const budgetOf = (v: AiValues): number => (v['ai-budget'] !== undefined ? Number(v['ai-budget']) : 0.5);
const isOpenRouterModel = (m: string | undefined): boolean => m === undefined || OpenRouterProvider.isValidModelId(m);

/** Cada comprobación devuelve el problema o null. Se aplican en orden: el primer problema es el que se informa. */
type Check = (v: AiValues & { ai: string }, fallback: string[] | undefined) => string | null;

const CHECKS: readonly Check[] = [
  (v) => (PROVIDERS.includes(v.ai as AiProviderName) ? null : `Proveedor de IA no válido: ${v.ai} (usa ${PROVIDERS.join(', ')}).`),
  (v) => (v.ai === 'url' && !v['ai-url'] ? '--ai url requiere --ai-url <url>.' : null),
  openRouterOnly,
  (v) => (v['ai-zdr'] && v['ai-allow-data-collection'] ? '--ai-zdr y --ai-allow-data-collection son incompatibles.' : null),
  (v) =>
    v['ai-reasoning'] === undefined || REASONING_PREFERENCES.includes(v['ai-reasoning'] as ReasoningPreference)
      ? null
      : `Nivel de razonamiento no válido: ${v['ai-reasoning']} (usa ${REASONING_PREFERENCES.join(', ')}).`,
  (_, fallback) => (fallback === undefined || (fallback.length > 0 && fallback.length <= MAX_FALLBACKS) ? null : `--ai-fallback necesita entre 1 y ${MAX_FALLBACKS} modelos separados por comas.`),
  (_, fallback) => {
    const bad = fallback?.find((m) => !isOpenRouterModel(m));
    return bad ? `Id de modelo de respaldo no válido: ${bad} (formato proveedor/modelo).` : null;
  },
  (v) => (v.ai === 'openrouter' && !v['ai-model'] ? '--ai openrouter requiere --ai-model <proveedor/modelo> (lista los compatibles con: npm run models).' : null),
  (v) => {
    if (v.ai !== 'openrouter') return null;
    const bad = [v['ai-model'], v['ai-plan-model']].find((m) => !isOpenRouterModel(m));
    return bad ? `Id de modelo de OpenRouter no válido: ${bad} (formato proveedor/modelo).` : null;
  },
  (v) => (v.privacy === undefined || PRIVACY.includes(v.privacy as PrivacyMode) ? null : `Modo de privacidad no válido: ${v.privacy} (usa ${PRIVACY.join(', ')}).`),
  (v) => {
    const limit = limitOf(v);
    return Number.isInteger(limit) && limit >= 1 && limit <= 50 ? null : '--ai-limit debe ser un entero entre 1 y 50.';
  },
  (v) => {
    const budget = budgetOf(v);
    return Number.isFinite(budget) && budget > 0 ? null : '--ai-budget debe ser un número positivo (USD).';
  },
];

/** Opciones que solo aplican a OpenRouter. */
function openRouterOnly(v: AiValues & { ai: string }): string | null {
  if (v.ai === 'openrouter') return null;
  if (v['ai-zdr'] || v['ai-allow-data-collection']) return '--ai-zdr y --ai-allow-data-collection solo aplican a --ai openrouter.';
  if (v['ai-reasoning'] !== undefined) return '--ai-reasoning solo aplica a --ai openrouter.';
  if (v['ai-fallback'] !== undefined) return '--ai-fallback solo aplica a --ai openrouter.';
  return null;
}

/** Opciones de IA de la línea de comandos; undefined si no se pidió IA, o el primer problema. */
export function parseAiOptions(v: AiValues): AiCliOptions | undefined | Error {
  const ai = v.ai;
  if (ai === undefined) {
    const stray = AI_ONLY.find((k) => v[k] !== undefined);
    return stray ? new Error(`--${stray} requiere --ai.`) : undefined;
  }
  const fallback = splitList(v['ai-fallback']);
  for (const check of CHECKS) {
    const problem = check({ ...v, ai }, fallback);
    if (problem) return new Error(problem);
  }
  return {
    provider: ai as AiProviderName,
    limit: limitOf(v),
    budgetUsd: budgetOf(v),
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
