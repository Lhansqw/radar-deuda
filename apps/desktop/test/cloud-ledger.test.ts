import { afterEach, describe, expect, it } from 'vitest';
import { HISTORY_LIMIT, Store } from '../src/main/store.js';
import { report } from './helpers/report.js';

const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});
function memory(): Store {
  const s = Store.open(':memory:');
  stores.push(s);
  return s;
}

const CLOUD_A = '6f1c2a4e-9b3d-4c5e-8f70-112233445566';
const CLOUD_B = '0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3';
const timing = { startedAt: '2026-10-26T12:00:00.000Z', durationMs: 5 };

describe('CloudLedger', () => {
  it('lo nuevo queda pendiente de subir y deja de estarlo al enlazarlo', () => {
    const s = memory();
    const ledger = s.cloudLedger();
    const p = s.addProject({ name: 'tienda', kind: 'github', location: 'ana/tienda', branch: 'main' });
    const a = s.saveAnalysis(p.id, report(80), timing);
    expect(ledger.pendingProjects()).toEqual([{ id: p.id, name: 'tienda', kind: 'github', location: 'ana/tienda', branch: 'main', createdAt: p.createdAt }]);
    // Sin el proyecto en la nube, sus análisis esperan.
    expect(ledger.pendingAnalyses(10)).toEqual([]);
    ledger.linkProject(p.id, CLOUD_A);
    expect(ledger.pendingProjects()).toEqual([]);
    const [pending] = ledger.pendingAnalyses(10);
    expect(pending).toMatchObject({ id: a.id, cloudId: null, projectCloudId: CLOUD_A, summary: { score: 80 }, report: { score: { score: 80 } } });
    ledger.markUploaded(a.id, CLOUD_B);
    expect(ledger.pendingAnalyses(10)).toEqual([]);
    expect(ledger.knownAnalyses()).toEqual(new Set([CLOUD_B]));
    expect(ledger.pendingCount()).toEqual({ projects: 0, analyses: 0, removals: 0 });
  });

  it('avisa de los cambios del usuario, no de lo que llega de la nube', () => {
    const s = memory();
    const ledger = s.cloudLedger();
    let changes = 0;
    const stop = s.onChange(() => changes++);
    const p = s.addProject({ name: 'tienda', kind: 'github', location: 'ana/tienda' });
    s.saveAnalysis(p.id, report(80), timing);
    expect(changes).toBe(2);
    const other = ledger.importProject({ cloudId: CLOUD_A, name: 'web', kind: 'github', location: 'ana/web', branch: null, createdAt: '2026-10-01T00:00:00.000Z' });
    ledger.importAnalysis(other, { cloudId: CLOUD_B, startedAt: timing.startedAt, finishedAt: '2026-10-26T12:00:01.000Z', durationMs: 5, report: report(60) });
    expect(changes).toBe(2);
    stop();
    s.removeProject(p.id);
    expect(changes).toBe(2);
  });

  it('quitar un proyecto que estaba en la nube se anota para quitarlo allí', () => {
    const s = memory();
    const ledger = s.cloudLedger();
    const local = s.addProject({ name: 'local', kind: 'local', location: '/repos/local' });
    const synced = s.addProject({ name: 'tienda', kind: 'github', location: 'ana/tienda' });
    ledger.linkProject(synced.id, CLOUD_A);
    s.removeProject(local.id);
    s.removeProject(synced.id);
    expect(ledger.removals()).toEqual([CLOUD_A]);
    ledger.clearRemoval(CLOUD_A);
    expect(ledger.removals()).toEqual([]);
  });

  it('lo que llega de la nube entra ya subido; uno más antiguo que el historial que se conserva no entra', () => {
    const s = memory();
    const ledger = s.cloudLedger();
    const id = ledger.importProject({ cloudId: CLOUD_A, name: 'tienda', kind: 'github', location: 'ana/tienda', branch: null, createdAt: '2026-10-01T00:00:00.000Z' });
    expect(ledger.linkedProjects()).toEqual(new Map([[CLOUD_A, id]]));
    expect(ledger.findProject('github', 'ana/tienda')).toBe(id);
    expect(ledger.findProject('local', 'ana/tienda')).toBeNull();
    const imported = ledger.importAnalysis(id, { cloudId: CLOUD_B, startedAt: '2026-10-20T10:00:00.000Z', finishedAt: '2026-10-20T10:00:05.000Z', durationMs: 5000, report: report(75) });
    expect(imported).toMatchObject({ projectId: id, score: 75, finishedAt: '2026-10-20T10:00:05.000Z', durationMs: 5000 });
    expect(ledger.pendingCount()).toEqual({ projects: 0, analyses: 0, removals: 0 });

    for (let i = 0; i < HISTORY_LIMIT; i++) s.saveAnalysis(id, report(80), timing);
    const old = ledger.importAnalysis(id, { cloudId: '11111111-1111-4111-8111-111111111111', startedAt: '2020-01-01T00:00:00.000Z', finishedAt: '2020-01-01T00:00:01.000Z', durationMs: 1000, report: report(10) });
    expect(old).toBeNull();
    expect(s.listAnalyses(id)).toHaveLength(HISTORY_LIMIT);
  });

  it('un proyecto quitado en otro equipo se olvida aquí sin anotarlo para la nube', () => {
    const s = memory();
    const ledger = s.cloudLedger();
    const id = ledger.importProject({ cloudId: CLOUD_A, name: 'tienda', kind: 'github', location: 'ana/tienda', branch: null, createdAt: '2026-10-01T00:00:00.000Z' });
    ledger.forgetProject(id);
    expect(s.listProjects()).toEqual([]);
    expect(ledger.removals()).toEqual([]);
  });

  it('tras borrar la copia en la nube, todo vuelve a estar pendiente', () => {
    const s = memory();
    const ledger = s.cloudLedger();
    const p = s.addProject({ name: 'tienda', kind: 'github', location: 'ana/tienda' });
    const a = s.saveAnalysis(p.id, report(80), timing);
    ledger.linkProject(p.id, CLOUD_A);
    ledger.markUploaded(a.id, CLOUD_B);
    const gone = s.addProject({ name: 'vieja', kind: 'github', location: 'ana/vieja' });
    ledger.linkProject(gone.id, '22222222-2222-4222-8222-222222222222');
    s.removeProject(gone.id);
    ledger.unlinkAll();
    expect(ledger.pendingCount()).toEqual({ projects: 1, analyses: 1, removals: 0 });
    expect(ledger.knownAnalyses()).toEqual(new Set());
  });
});
