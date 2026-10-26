import { describe, expect, it } from 'vitest';
import type { AiSection, AnalysisReport } from '@radar/engine';
import { formatAiSection } from '../src/format.js';

const report = { findings: [] } as unknown as AnalysisReport;
const usage = { requests: 14, cacheHits: 0, inputTokens: 100, outputTokens: 50, costUsd: 0, latencyMsTotal: 10, latencyMsMax: 5 };

describe('formatAiSection', () => {
  it('agrupa los errores repetidos e indica cuántas veces ocurrieron', () => {
    const cut = 'Respuesta no válida tras un reintento: La respuesta se cortó por el límite de longitud.';
    const ai: AiSection = {
      privacy: 'metadatos',
      explanations: [],
      usage,
      errors: [...Array.from({ length: 6 }, (_, i) => ({ findingId: `f${i}`, message: cut })), { message: 'No se pudo generar el plan: otro motivo.' }],
    };
    const text = formatAiSection(ai, report, 'OpenRouter · x/y');
    expect(text).toContain('Sin completar (7):');
    expect(text.match(/se cortó por el límite/g)).toHaveLength(1);
    expect(text).toContain('(×6)');
    expect(text).toContain('No se pudo generar el plan: otro motivo.');
  });

  it('muestra los avisos y resume los motivos que no caben', () => {
    const ai: AiSection = {
      privacy: 'metadatos',
      explanations: [],
      usage,
      notes: ['Quedan 3 peticiones gratuitas hoy.'],
      errors: Array.from({ length: 10 }, (_, i) => ({ message: `Motivo ${i}.` })),
    };
    const text = formatAiSection(ai, report, 'x');
    expect(text).toContain('Aviso: Quedan 3 peticiones gratuitas hoy.');
    expect(text).toContain('… y 2 motivo(s) más');
  });

  it('indica cuántos tokens de salida fueron de razonamiento', () => {
    const ai: AiSection = { privacy: 'metadatos', explanations: [], usage: { ...usage, outputTokens: 1300, reasoningTokens: 1200 }, errors: [] };
    expect(formatAiSection(ai, report, 'x')).toContain('/ 1300 de salida (1200 razonando)');
  });
});
