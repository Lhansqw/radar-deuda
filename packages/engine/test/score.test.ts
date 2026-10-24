import { describe, expect, it } from 'vitest';
import { computeScore, MINUTES_PER_LINE } from '../src/score.js';
import type { Finding, Severity } from '../src/types.js';

const finding = (minutes: number, severity: Severity = 'medium'): Finding => ({
  id: String(Math.random()),
  ruleId: 'r',
  category: 'complexity',
  severity,
  confidence: 'high',
  title: '',
  message: '',
  locations: [],
  evidence: [],
  impact: '',
  effort: { minutes, rationale: '' },
});

describe('computeScore', () => {
  it('sin hallazgos: 100 y calificación A', () => {
    expect(computeScore([], 1000)).toMatchObject({ score: 100, rating: 'A', debtRatio: 0 });
  });

  it.each([
    [0.05, 'A', 90],
    [0.1, 'B', 80],
    [0.2, 'C', 60],
    [0.5, 'D', 0],
    [0.8, 'E', 0],
  ] as const)('ratio %d → %s (%d)', (ratio, rating, score) => {
    const lines = 1000;
    const minutes = ratio * lines * MINUTES_PER_LINE;
    expect(computeScore([finding(minutes)], lines)).toMatchObject({ rating, score });
  });

  it('los hallazgos informativos no suman deuda', () => {
    expect(computeScore([finding(10_000, 'info')], 100).remediationMinutes).toBe(0);
  });

  it('no divide por cero en repositorios sin código', () => {
    const r = computeScore([finding(30)], 0);
    expect(Number.isFinite(r.debtRatio)).toBe(true);
    expect(r.developmentMinutes).toBe(MINUTES_PER_LINE);
  });
});
