import type { AiSection, AiUsage } from '@radar/engine';

function sumUsage(a: AiUsage, b: AiUsage): AiUsage {
  const reasoning = (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0);
  return {
    requests: a.requests + b.requests,
    cacheHits: a.cacheHits + b.cacheHits,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
    costUsd: a.costUsd === null || b.costUsd === null ? null : Number((a.costUsd + b.costUsd).toFixed(6)),
    latencyMsTotal: a.latencyMsTotal + b.latencyMsTotal,
    latencyMsMax: Math.max(a.latencyMsMax, b.latencyMsMax),
  };
}

/**
 * Añade a la sección de IA de un análisis las explicaciones nuevas (p. ej.
 * "explicar este hallazgo"): sustituye las de los mismos hallazgos, conserva
 * las demás y el plan, y suma el consumo.
 */
export function mergeAiSection(existing: AiSection | undefined, added: AiSection): AiSection {
  if (!existing) return added;
  const touched = new Set([...added.explanations.map((e) => e.findingId), ...added.errors.map((e) => e.findingId).filter((id): id is string => id !== undefined)]);
  const notes = added.notes ?? existing.notes;
  return {
    privacy: added.privacy,
    explanations: [...existing.explanations.filter((e) => !touched.has(e.findingId)), ...added.explanations],
    ...(existing.plan ? { plan: existing.plan } : {}),
    usage: sumUsage(existing.usage, added.usage),
    errors: [...existing.errors.filter((e) => e.findingId === undefined || !touched.has(e.findingId)), ...added.errors],
    ...(notes ? { notes } : {}),
  };
}
