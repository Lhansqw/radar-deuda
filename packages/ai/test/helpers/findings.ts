import type { Finding } from '@radar/engine';

export function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    ruleId: 'complexity/function',
    category: 'complexity',
    severity: 'high',
    confidence: 'high',
    title: 'Función difícil de mantener: procesar',
    message: 'La función procesar supera los umbrales: complejidad cognitiva 31 (umbral 15).',
    locations: [{ file: 'src/p.ts', startLine: 10, endLine: 14, symbol: 'procesar' }],
    evidence: [{ kind: 'metric', tool: 'complexity@1.1.0', description: 'Complejidad cognitiva', metric: { name: 'cognitive', value: 31, threshold: 15 } }],
    impact: 'Difícil de entender.',
    effort: { minutes: 79, rationale: '15 min base + 4 min por punto.' },
    ...over,
  };
}

/** 30 líneas numeradas: "línea N". */
export const FILE = Array.from({ length: 30 }, (_, i) => `const linea${i + 1} = ${i + 1};`).join('\n');
