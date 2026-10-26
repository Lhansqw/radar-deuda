import type { AiSection, AnalysisReport, ClaimKind } from '@radar/engine';

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

/** Sección de IA para la terminal. Siempre separa evidencia, inferencia y recomendación. */
export function formatAiSection(ai: AiSection, report: AnalysisReport, label: string): string {
  const out: string[] = [];
  const byId = new Map(report.findings.map((f) => [f.id, f]));
  out.push(`Análisis con IA — ${label} · privacidad: ${PRIVACY[ai.privacy]}`);
  out.push('Las explicaciones son orientativas: la evidencia verificable es la de los hallazgos.');
  out.push('');
  for (const e of ai.explanations) {
    const f = byId.get(e.findingId);
    const loc = f?.locations[0];
    out.push(`  [${SEV[f?.severity ?? ''] ?? '?'}] ${f?.title ?? e.findingId}${loc ? ` — ${loc.file}:${loc.startLine}` : ''}${e.fromCache ? ' (caché)' : ''}`);
    out.push(wrap(`Qué ocurre: ${e.summary}`, '      '));
    out.push(wrap(`Causa raíz (inferencia): ${e.rootCause}`, '      '));
    out.push(wrap(`Recomendación: ${e.recommendation}`, '      '));
    for (const c of e.claims.slice(0, 6)) {
      const where = c.lines ? ` (${c.lines.file}:${c.lines.startLine}-${c.lines.endLine})` : '';
      out.push(wrap(`· ${KIND[c.kind]}: ${c.text}${where}`, '      '));
    }
    const conf = `Confianza: ${e.confidence}${e.insufficientInformation ? ' · el modelo indica que la información no basta' : ''}`;
    out.push(`      ${conf}`);
    for (const n of e.validationNotes.slice(0, 3)) out.push(wrap(`Validación: ${n}`, '      '));
    out.push('');
  }
  if (ai.plan) {
    out.push('  Plan de reducción de deuda:');
    for (const s of ai.plan.steps) {
      out.push(wrap(`${s.order}. [${s.horizon}] ${s.title} (${s.findingIds.length} hallazgo(s)) — ${s.rationale}`, '    '));
    }
    for (const n of ai.plan.notes) out.push(wrap(`Nota: ${n}`, '    '));
    out.push('');
  }
  const u = ai.usage;
  const cost = u.costUsd === null ? 'coste desconocido' : u.costUsd === 0 ? 'sin coste' : `~${u.costUsd.toFixed(4)} USD`;
  out.push(
    `  Consumo de IA: ${u.requests} petición(es) · ${u.inputTokens} tokens de entrada / ${u.outputTokens} de salida · ${cost} · latencia máx. ${(u.latencyMsMax / 1000).toFixed(1)} s · ${u.cacheHits} desde caché`,
  );
  for (const n of ai.notes ?? []) out.push(wrap(`Aviso: ${n}`, '  '));
  if (ai.errors.length > 0) {
    out.push(`  Sin completar (${ai.errors.length}):`);
    for (const e of ai.errors.slice(0, 8)) out.push(wrap(`- ${e.message}`, '    '));
  }
  out.push('');
  return out.join('\n');
}
