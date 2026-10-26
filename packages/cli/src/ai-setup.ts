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
    if (!v['ai-model']) return new Error('--ai openrouter requiere --ai-model <proveedor/modelo> (lista los compatibles con: npm run models).');
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
