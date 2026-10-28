import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AiFixProposal } from '@radar/engine';
import { CHAT_LIMIT, DuplicateProjectError, HISTORY_LIMIT, SCHEMA_VERSION, Store } from '../src/main/store.js';
import { report } from './helpers/report.js';

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

describe('Store', () => {
  it('crea el esquema y lo reabre sin repetir migraciones', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'radar-store-'));
    dirs.push(dir);
    const file = path.join(dir, 'sub', 'radar.db');
    const a = Store.open(file);
    expect(a.schemaVersion).toBe(SCHEMA_VERSION);
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

  it('migra una base de datos de la versión 1 conservando sus datos', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'radar-store-'));
    dirs.push(dir);
    const file = path.join(dir, 'radar.db');
    const a = Store.open(file);
    const p = a.addProject({ name: 'demo', kind: 'local', location: '/demo' });
    a.saveAnalysis(p.id, report(70), { startedAt: '2026-10-26T12:00:00.000Z', durationMs: 5 });
    a.close();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file);
    // Lo que añadieron las versiones 2 (propuestas y conversaciones) y 3 (copia en la nube).
    db.exec(`DROP INDEX projects_by_cloud_id; DROP INDEX analyses_by_cloud_id; DROP INDEX analyses_to_upload;
      ALTER TABLE projects DROP COLUMN cloud_id; ALTER TABLE analyses DROP COLUMN cloud_id; ALTER TABLE analyses DROP COLUMN cloud_synced;
      DROP TABLE cloud_removals; DROP TABLE fix_proposals; DROP TABLE chat_messages; PRAGMA user_version = 1;`);
    db.close();
    const b = Store.open(file);
    stores.push(b);
    expect(b.schemaVersion).toBe(SCHEMA_VERSION);
    const [analysis] = b.listAnalyses(p.id);
    expect(analysis?.score).toBe(70);
    expect(b.listChatMessages(analysis?.id ?? 0)).toEqual([]);
    // Lo que había antes de la nube queda pendiente de subir.
    expect(b.cloudLedger().pendingCount()).toEqual({ projects: 1, analyses: 1, removals: 0 });
  });

  it('guarda una propuesta por hallazgo, la sustituye y la borra con su análisis', () => {
    const s = memory();
    const p = s.addProject({ name: 'demo', kind: 'local', location: '/demo' });
    const a = s.saveAnalysis(p.id, report(70), { startedAt: '2026-10-26T12:00:00.000Z', durationMs: 5 });
    const proposal = (summary: string): AiFixProposal => ({ findingId: 'f1', applicable: true, summary, hunks: [], patch: '', risks: [], verification: [], validationNotes: [], baseHashes: {}, privacy: 'fragmentos', provider: 'p', model: 'm', fromCache: false, usage: { requests: 1, cacheHits: 0, inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMsTotal: 1, latencyMsMax: 1 }, createdAt: '2026-10-26T12:00:00.000Z' });
    s.saveFixProposal(a.id, proposal('primera'));
    s.saveFixProposal(a.id, proposal('segunda'));
    expect(s.getFixProposal(a.id, 'f1')?.summary).toBe('segunda');
    expect(s.fixProposalIds(a.id)).toEqual(['f1']);
    expect(s.getFixProposal(a.id, 'otro')).toBeNull();
    s.deleteFixProposal(a.id, 'f1');
    expect(s.getFixProposal(a.id, 'f1')).toBeNull();
    s.saveFixProposal(a.id, proposal('tercera'));
    s.removeProject(p.id);
    expect(s.fixProposalIds(a.id)).toEqual([]);
  });

  it('guarda la conversación de un análisis en orden, con sus datos y acotada', () => {
    const s = memory();
    const p = s.addProject({ name: 'demo', kind: 'local', location: '/demo' });
    const a = s.saveAnalysis(p.id, report(70), { startedAt: '2026-10-26T12:00:00.000Z', durationMs: 5 });
    const q = s.addChatMessage(a.id, { role: 'user', content: '¿Por dónde empiezo?' });
    const meta = { references: [{ alias: 'H1', findingId: 'f1' }], unknownReferences: [], truncated: false, model: 'm', costUsd: 0 };
    s.addChatMessage(a.id, { role: 'assistant', content: 'Por [H1].', meta });
    expect(q).toMatchObject({ analysisId: a.id, role: 'user', meta: null });
    expect(s.listChatMessages(a.id).map((m) => [m.role, m.content, m.meta])).toEqual([
      ['user', '¿Por dónde empiezo?', null],
      ['assistant', 'Por [H1].', meta],
    ]);
    for (let i = 0; i < CHAT_LIMIT + 3; i++) s.addChatMessage(a.id, { role: 'user', content: `m${i}` });
    const all = s.listChatMessages(a.id);
    expect(all).toHaveLength(CHAT_LIMIT);
    expect(all.at(-1)?.content).toBe(`m${CHAT_LIMIT + 2}`);
    s.clearChat(a.id);
    expect(s.listChatMessages(a.id)).toEqual([]);
  });

  it('cerrarla dos veces no es un error (al salir de la aplicación ya puede estar cerrada)', () => {
    const s = Store.open(':memory:');
    s.close();
    expect(() => s.close()).not.toThrow();
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
    // La conexión se cerró: el archivo no queda bloqueado (en Windows, borrarlo fallaría con EBUSY).
    await rm(file);
  });
});
