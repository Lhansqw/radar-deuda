import type { AnalysisReport, Severity } from '@radar/engine';

/** Informe mínimo con la forma que valida parseReport. */
export function report(score: number, extra: Partial<AnalysisReport> = {}): AnalysisReport {
  const bySeverity: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 0 };
  return {
    schemaVersion: 1,
    engineVersion: '0.1.0',
    root: '/repo',
    generatedAt: '2026-10-26T12:00:00.000Z',
    config: {} as AnalysisReport['config'],
    score: { score, rating: score >= 80 ? 'A' : 'C', debtRatio: 0.12, remediationMinutes: 125.4, developmentMinutes: 1000, codeLines: 300 },
    findings: [{ id: 'f1', severity: 'high', locations: [], evidence: [] }] as unknown as AnalysisReport['findings'],
    summary: { bySeverity, byCategory: {} },
    coverage: [],
    errors: [],
    stats: { durationMs: 10, filesDiscovered: 3, filesAnalyzed: 3, cacheHits: 0, skipped: [], cpuUserMs: 1, cpuSystemMs: 1, peakRssMb: 50 },
    ...extra,
  };
}
