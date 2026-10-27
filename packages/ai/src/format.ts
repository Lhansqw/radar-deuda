import { findingRefs, type AiClaim, type AiExplanation, type AiFixProposal, type AiPlan, type AiSection, type AiUsage, type AnalysisReport, type ClaimKind, type Finding } from '@radar/engine';
import type { ChatAnswer } from './chat.js';

const KIND: Record<ClaimKind, string> = { evidencia: 'Evidencia', inferencia: 'Inferencia', recomendacion: 'Recomendación' };
const SEV: Record<string, string> = { critical: 'CRÍTICA', high: 'ALTA', medium: 'MEDIA', low: 'BAJA', info: 'INFO' };
const PRIVACY: Record<AiSection['privacy'], string> = {
  local: 'local (nada sale del equipo)',
  metadatos: 'metadatos (sin código)',
  fragmentos: 'fragmentos de código redactados',
};

function wrap(text: string, indent: string, width = 96): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width - indent.length) {
      lines.push(line.trim());
      line = w;
    } else line += ` ${w}`;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.map((l) => indent + l).join('\n');
}

/** Agrupa mensajes idénticos conservando el orden de aparición. */
function groupMessages(messages: readonly string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const m of messages) counts.set(m, (counts.get(m) ?? 0) + 1);
  return [...counts.entries()];
}

/** Sección de IA para la terminal. Siempre separa evidencia, inferencia y recomendación. */
export function formatAiSection(ai: AiSection, report: AnalysisReport, label: string): string {
  const byId = new Map(report.findings.map((f) => [f.id, f]));
  return [
    `Análisis con IA — ${label} · privacidad: ${PRIVACY[ai.privacy]}`,
    'Las explicaciones son orientativas: la evidencia verificable es la de los hallazgos.',
    '',
    ...ai.explanations.flatMap((e) => explanationLines(e, byId.get(e.findingId))),
    ...(ai.plan ? planLines(ai.plan) : []),
    usageLine(ai.usage),
    ...(ai.notes ?? []).map((n) => wrap(`Aviso: ${n}`, '  ')),
    ...errorLines(ai.errors),
    '',
  ].join('\n');
}

const INDENT = '      ';

function explanationLines(e: AiExplanation, f: Finding | undefined): string[] {
  const loc = f?.locations[0];
  const where = (c: AiClaim): string => (c.lines ? ` (${c.lines.file}:${c.lines.startLine}-${c.lines.endLine})` : '');
  return [
    `  [${SEV[f?.severity ?? ''] ?? '?'}] ${f?.title ?? e.findingId}${loc ? ` — ${loc.file}:${loc.startLine}` : ''}${e.fromCache ? ' (caché)' : ''}`,
    wrap(`Qué ocurre: ${e.summary}`, INDENT),
    wrap(`Causa raíz (inferencia): ${e.rootCause}`, INDENT),
    wrap(`Recomendación: ${e.recommendation}`, INDENT),
    ...e.claims.slice(0, 6).map((c) => wrap(`· ${KIND[c.kind]}: ${c.text}${where(c)}`, INDENT)),
    `${INDENT}Confianza: ${e.confidence}${e.insufficientInformation ? ' · el modelo indica que la información no basta' : ''}`,
    ...e.validationNotes.slice(0, 3).map((n) => wrap(`Validación: ${n}`, INDENT)),
    '',
  ];
}

function planLines(plan: AiPlan): string[] {
  return [
    '  Plan de reducción de deuda:',
    ...plan.steps.map((s) => wrap(`${s.order}. [${s.horizon}] ${s.title} (${s.findingIds.length} hallazgo(s)) — ${s.rationale}`, '    ')),
    ...plan.notes.map((n) => wrap(`Nota: ${n}`, '    ')),
    '',
  ];
}

function usageLine(u: AiUsage): string {
  const cost = u.costUsd === null ? 'coste desconocido' : u.costUsd === 0 ? 'sin coste' : `~${u.costUsd.toFixed(4)} USD`;
  const reasoning = u.reasoningTokens ? ` (${u.reasoningTokens} razonando)` : '';
  return `  Consumo de IA: ${u.requests} petición(es) · ${u.inputTokens} tokens de entrada / ${u.outputTokens} de salida${reasoning} · ${cost} · latencia máx. ${(u.latencyMsMax / 1000).toFixed(1)} s · ${u.cacheHits} desde caché`;
}

/** Los motivos repetidos se agrupan («×3») y se muestran como mucho ocho. */
function errorLines(errors: AiSection['errors']): string[] {
  if (errors.length === 0) return [];
  const groups = groupMessages(errors.map((e) => e.message));
  return [
    `  Sin completar (${errors.length}):`,
    ...groups.slice(0, 8).map(([message, count]) => wrap(`- ${message}${count > 1 ? ` (×${count})` : ''}`, '    ')),
    ...(groups.length > 8 ? [`    … y ${groups.length - 8} motivo(s) más (ver el informe JSON).`] : []),
  ];
}

/** Propuesta de corrección para la terminal: resumen, diferencia, riesgos y cómo comprobarla. */
export function formatFixProposal(p: AiFixProposal, finding: Finding, ref: string): string {
  const out: string[] = ['', `Propuesta de corrección para ${ref} · ${finding.title}`, '─'.repeat(72)];
  out.push(wrap(p.applicable ? p.summary : `La IA no propone cambios: ${p.summary}`, ''));
  if (p.patch !== '') out.push('', p.patch.trimEnd());
  // Viñeta en la primera línea y sangría en las siguientes.
  const bullet = (t: string): string => `  - ${wrap(t, '    ').slice(4)}`;
  if (p.risks.length > 0) out.push('', 'Qué revisar:', ...p.risks.map(bullet));
  if (p.verification.length > 0) out.push('', 'Cómo comprobarlo:', ...p.verification.map(bullet));
  for (const n of p.validationNotes) out.push(wrap(`Validación: ${n}`, '  '));
  out.push('', `Modelo ${p.model}${p.fromCache ? ' (desde caché)' : ''}. Orientativa: revísala antes de aplicarla; la herramienta nunca modifica tus archivos.`);
  return out.join('\n');
}

/** Respuesta a una pregunta, con la lista de hallazgos citados. */
export function formatChatAnswer(a: ChatAnswer, report: AnalysisReport): string {
  const byId = new Map(report.findings.map((f) => [f.id, f]));
  const refs = findingRefs(report.findings);
  const out: string[] = ['', a.text];
  if (a.truncated) out.push('', '(La respuesta se cortó por el límite de longitud.)');
  if (a.references.length > 0) {
    out.push('', 'Hallazgos citados:');
    for (const r of a.references) {
      const f = byId.get(r.findingId);
      const loc = f?.locations[0];
      if (f) out.push(`  ${(refs.get(f.id) ?? r.alias).padEnd(4)}[${SEV[f.severity] ?? f.severity}] ${f.title}${loc && loc.file !== '.' ? ` · ${loc.file}:${loc.startLine}` : ''}`);
    }
  }
  if (a.unknownReferences.length > 0) out.push('', `La IA citó referencias que no existen (${a.unknownReferences.join(', ')}): ignóralas.`);
  out.push('', `Modelo ${a.model}. Solo se enviaron datos del análisis, nunca código.`);
  return out.join('\n');
}
