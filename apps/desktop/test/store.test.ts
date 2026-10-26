import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnalysisReport, Severity } from '@radar/engine';
import { DuplicateProjectError, HISTORY_LIMIT, Store } from '../src/main/store.js';

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
function memory(): Store {
  const s = Store.open(':memory:');
  stores.push(s);
  return s;
}

/** Informe mínimo con la forma que valida parseReport. */
function report(score: number, extra: Partial<AnalysisReport> = {}): AnalysisReport {
  const bySeverity: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 0 };
  return {
    schemaVersion: 1,
    engineVersion: '0.1.0',
    root: '/repo',
    generatedAt: '2026-10-26T12:00:00.000Z',
    config: {} as AnalysisReport['config'],
    score: { score, rating: score >= 80 ? 'A' : 'C', debtRatio: 0.12, remediationMinutes: 125.4, developmentMinutes: 1000, codeLines: 300 },
    findings: [{ id: 'f1', severity: 'high' }] as AnalysisReport['findings'],
    summary: { bySeverity, byCategory: {} },
    coverage: [],
    errors: [],
    stats: { durationMs: 10, filesDiscovered: 3, filesAnalyzed: 3, cacheHits: 0, skipped: [], cpuUserMs: 1, cpuSystemMs: 1, peakRssMb: 50 },
    ...extra,
  };
}

describe('Store', () => {
  it('crea el esquema y lo reabre sin repetir migraciones', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'radar-store-'));
    dirs.push(dir);
    const file = path.join(dir, 'sub', 'radar.db');
    const a = Store.open(file);
    expect(a.schemaVersion).toBe(1);
    a.addProject({ name: 'demo', kind: 'local', location: 'C:\\dev\\demo' });
    a.close();
    const b = Store.open(file);
    stores.push(b);
    expect(b.listProjects().map((p) => p.name)).toEqual(['demo']);
  });

  it('gestiona proyectos sin duplicados y los ordena por nombre', () => {
    const s = memory();
    const z = s.addProject({ name: 'zeta', kind: 'github', location: 'org/zeta', branch: 'develop' });
    s.addProject({ name: 'Alfa', kind: 'local', location: '/repos/alfa' });
    expect(z).toMatchObject({ kind: 'github', location: 'org/zeta', branch: 'develop', lastAnalysis: null });
    expect(() => s.addProject({ name: 'otra', kind: 'github', location: 'org/zeta' })).toThrow(DuplicateProjectError);
    // La misma ubicación con otro tipo es otro proyecto.
    s.addProject({ name: 'org-zeta', kind: 'local', location: 'org/zeta' });
    expect(s.listProjects().map((p) => p.name)).toEqual(['Alfa', 'org-zeta', 'zeta']);
    expect(s.getProject(999)).toBeNull();
  });

  it('guarda análisis con su resumen y recupera el informe completo', () => {
    const s = memory();
    const p = s.addProject({ name: 'demo', kind: 'local', location: '/demo' });
    const r = report(66, { vcs: { head: 'abc123', branch: 'main', remoteUrl: null, shallow: false } });
    const sum = s.saveAnalysis(p.id, r, { startedAt: '2026-10-26T11:59:00.000Z', durationMs: 1234.6 });
    expect(sum).toMatchObject({ projectId: p.id, score: 66, rating: 'C', debtRatio: 0.12, effortMinutes: 125, findings: 1, durationMs: 1235, head: 'abc123', branch: 'main', withAi: false });
    expect(sum.bySeverity).toEqual({ critical: 0, high: 1, medium: 2, low: 3, info: 0 });
    expect(s.getProject(p.id)?.lastAnalysis?.id).toBe(sum.id);
    expect(s.getReport(sum.id)).toEqual(r);
    expect(s.getReport(999)).toBeNull();
  });

  it('lista el historial del más reciente al más antiguo y lo acota', () => {
    const s = memory();
    const p = s.addProject({ name: 'demo', kind: 'local', location: '/demo' });
    for (let i = 0; i < HISTORY_LIMIT + 3; i++) s.saveAnalysis(p.id, report(i % 100), { startedAt: new Date().toISOString(), durationMs: 1 });
    const list = s.listAnalyses(p.id);
    expect(list).toHaveLength(HISTORY_LIMIT);
    expect(list[0]?.id).toBeGreaterThan(list[1]?.id ?? Infinity);
    expect(s.listAnalyses(p.id, 2)).toHaveLength(2);
  });

  it('al eliminar un proyecto se elimina su historial', () => {
    const s = memory();
    const p = s.addProject({ name: 'demo', kind: 'local', location: '/demo' });
    const a = s.saveAnalysis(p.id, report(50), { startedAt: new Date().toISOString(), durationMs: 1 });
    s.removeProject(p.id);
    expect(s.listProjects()).toEqual([]);
    expect(s.getReport(a.id)).toBeNull();
  });

  it('actualiza el informe de un análisis (p. ej. al añadir la IA después)', () => {
    const s = memory();
    const p = s.addProject({ name: 'demo', kind: 'local', location: '/demo' });
    const a = s.saveAnalysis(p.id, report(50), { startedAt: new Date().toISOString(), durationMs: 1 });
    const withAi = report(50, { ai: { privacy: 'metadatos', explanations: [], usage: { requests: 1, cacheHits: 0, inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMsTotal: 1, latencyMsMax: 1 }, errors: [] } });
    s.updateReport(a.id, withAi);
    expect(s.getReport(a.id)?.ai?.privacy).toBe('metadatos');
    expect(s.listAnalyses(p.id)[0]?.withAi).toBe(true);
  });

  it('guarda ajustes como JSON y credenciales como bytes opacos', () => {
    const s = memory();
    expect(s.getSetting('x')).toBeUndefined();
    s.setSetting('x', { a: 1 });
    s.setSetting('x', { a: 2 });
    expect(s.getSetting('x')).toEqual({ a: 2 });
    s.setSecret('openrouter', new Uint8Array([1, 2, 3]));
    expect([...(s.getSecret('openrouter') ?? [])]).toEqual([1, 2, 3]);
    s.deleteSecret('openrouter');
    expect(s.getSecret('openrouter')).toBeNull();
  });

  it('rechaza una base de datos de una versión más reciente', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'radar-store-'));
    dirs.push(dir);
    const file = path.join(dir, 'radar.db');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA user_version = 99');
    db.close();
    expect(() => Store.open(file)).toThrow(/versión más reciente/);
  });
});
