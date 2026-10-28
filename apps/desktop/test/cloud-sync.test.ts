import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnalysisReport } from '@radar/engine';
import { AccountService } from '../src/main/account-service.js';
import { cloudConfig, ENV_KEY, ENV_URL } from '../src/main/cloud-config.js';
import { SupabaseRepo } from '../src/main/cloud-repo.js';
import { CloudSync } from '../src/main/cloud-sync.js';
import { EncryptedSessionStorage } from '../src/main/session-storage.js';
import { Store } from '../src/main/store.js';
import type { SyncState } from '../src/shared/sync.js';
import { FAKE_KEY, FAKE_URL, FakeSupabase } from './helpers/fake-supabase.js';
import { report } from './helpers/report.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

const cipher = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() };
const PASSWORD = 'contraseña-larga-1';
const timing = { startedAt: '2026-10-26T12:00:00.000Z', durationMs: 5 };

/** Un equipo: su base de datos local, la cuenta con sesión y la sincronización. */
async function device(server: FakeSupabase, email = 'ana@ejemplo.com', options: { enabled?: () => boolean } = {}) {
  if (!server.users.has(email)) server.addUser(email, PASSWORD);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'radar-sinc-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const store = Store.open(':memory:');
  cleanup.push(() => store.close());
  const account = new AccountService({
    config: cloudConfig({ [ENV_URL]: FAKE_URL, [ENV_KEY]: FAKE_KEY }, null),
    storage: new EncryptedSessionStorage(path.join(dir, 'sesion.bin'), cipher),
    onChange: () => undefined,
    fetch: server.fetch,
    retryReads: false,
  });
  cleanup.push(() => account.dispose());
  await account.signIn(email, PASSWORD, false);
  const states: SyncState[] = [];
  const sync = new CloudSync({
    ledger: store.cloudLedger(),
    repo: async () => {
      const db = await account.database();
      return db ? new SupabaseRepo(db) : null;
    },
    enabled: options.enabled ?? (() => true),
    emit: (s) => states.push(s),
    timing: { debounceMs: 5, retryMs: 60_000, periodMs: 60_000 },
  });
  cleanup.push(() => sync.dispose());
  return { store, sync, states, account };
}

function withTodo(score: number): AnalysisReport {
  const r = report(score);
  r.findings = [{ id: 'f1', severity: 'low', locations: [{ file: 'src/a.ts', startLine: 1, endLine: 1 }], evidence: [{ kind: 'match', tool: 't@1', description: 'TODO', snippet: '// TODO: secreto de prueba' }] }] as unknown as AnalysisReport['findings'];
  return r;
}

describe('CloudSync', () => {
  it('sube los proyectos y el historial de un equipo y los recibe otro con la misma cuenta, sin código', async () => {
    const server = new FakeSupabase();
    const a = await device(server);
    const p = a.store.addProject({ name: 'tienda', kind: 'github', location: 'ana/tienda', branch: 'main' });
    a.store.saveAnalysis(p.id, withTodo(70), timing);
    a.store.saveAnalysis(p.id, withTodo(80), { ...timing, startedAt: '2026-10-27T12:00:00.000Z' });

    const sent = await a.sync.now();
    expect(sent).toMatchObject({ status: 'idle', message: null, pending: { projects: 0, analyses: 0, removals: 0 } });
    expect(server.db.tables.projects).toHaveLength(1);
    expect(server.db.tables.analyses).toHaveLength(2);
    for (const row of server.db.tables.analyses) expect(gunzipSync(Buffer.from(String(row['report_gz']), 'base64')).toString()).not.toMatch(/secreto/);

    const b = await device(server);
    const got = await b.sync.now();
    expect(got.received).toBe(3);
    const [remote] = b.store.listProjects();
    expect(remote).toMatchObject({ name: 'tienda', kind: 'github', location: 'ana/tienda', branch: 'main', lastAnalysis: { score: 80 } });
    expect(b.store.listAnalyses(remote?.id ?? 0).map((x) => x.score)).toEqual([80, 70]);
    // Lo recibido no vuelve a subir.
    expect(b.store.cloudLedger().pendingCount()).toEqual({ projects: 0, analyses: 0, removals: 0 });
    expect((await b.sync.now()).received).toBe(3);
  });

  it('otra cuenta no recibe nada', async () => {
    const server = new FakeSupabase();
    const ana = await device(server);
    ana.store.addProject({ name: 'tienda', kind: 'github', location: 'ana/tienda' });
    await ana.sync.now();
    const luis = await device(server, 'luis@ejemplo.com');
    expect((await luis.sync.now()).received).toBe(0);
    expect(luis.store.listProjects()).toEqual([]);
  });

  it('el mismo repositorio añadido en dos equipos se une en uno', async () => {
    const server = new FakeSupabase();
    const a = await device(server);
    const b = await device(server);
    a.store.addProject({ name: 'tienda', kind: 'github', location: 'ana/tienda' });
    const pb = b.store.addProject({ name: 'tienda', kind: 'github', location: 'ana/tienda' });
    b.store.saveAnalysis(pb.id, report(60), timing);
    await a.sync.now();
    await b.sync.now();
    await a.sync.now();
    expect(server.db.tables.projects).toHaveLength(1);
    expect(a.store.listProjects()).toHaveLength(1);
    expect(a.store.listAnalyses(a.store.listProjects()[0]?.id ?? 0).map((x) => x.score)).toEqual([60]);
  });

  it('quitar un proyecto en un equipo lo quita en los demás; volver a añadirlo lo recupera', async () => {
    const server = new FakeSupabase();
    const a = await device(server);
    const b = await device(server);
    const p = a.store.addProject({ name: 'tienda', kind: 'github', location: 'ana/tienda' });
    a.store.saveAnalysis(p.id, report(70), timing);
    await a.sync.now();
    await b.sync.now();
    expect(b.store.listProjects()).toHaveLength(1);

    a.store.removeProject(p.id);
    await a.sync.now();
    expect(server.db.tables.projects[0]?.['deleted_at']).not.toBeNull();
    expect(server.db.tables.analyses).toEqual([]);
    await b.sync.now();
    expect(b.store.listProjects()).toEqual([]);

    // Un equipo que lo quita no lo vuelve a recibir antes de avisar a la nube.
    a.store.addProject({ name: 'tienda', kind: 'github', location: 'ana/tienda' });
    await a.sync.now();
    expect(server.db.tables.projects).toHaveLength(1);
    expect(server.db.tables.projects[0]?.['deleted_at']).toBeNull();
    await b.sync.now();
    expect(b.store.listProjects()).toHaveLength(1);
  });

  it('sin conexión queda pendiente y se envía cuando vuelve', async () => {
    const server = new FakeSupabase();
    const a = await device(server);
    const p = a.store.addProject({ name: 'tienda', kind: 'github', location: 'ana/tienda' });
    a.store.saveAnalysis(p.id, report(70), timing);
    server.offline = true;
    expect(await a.sync.now()).toMatchObject({ status: 'offline', message: expect.stringMatching(/No se pudo conectar con Supabase/), pending: { projects: 1, analyses: 1 } });
    server.offline = false;
    expect(await a.sync.now()).toMatchObject({ status: 'idle', pending: { projects: 0, analyses: 0 } });
    expect(server.db.tables.analyses).toHaveLength(1);
  });

  it('una subida interrumpida no duplica el análisis en la nube', async () => {
    const server = new FakeSupabase();
    const a = await device(server);
    const p = a.store.addProject({ name: 'tienda', kind: 'github', location: 'ana/tienda' });
    a.store.saveAnalysis(p.id, report(70), timing);
    // El análisis llega a la nube pero la respuesta se pierde.
    let cut = true;
    server.loseResponse = (method, route) => {
      if (!cut || method !== 'POST' || route !== '/rest/v1/analyses') return false;
      cut = false;
      return true;
    };
    expect((await a.sync.now()).status).toBe('offline');
    expect(server.db.tables.analyses).toHaveLength(1);
    expect((await a.sync.now()).status).toBe('idle');
    expect(server.db.tables.analyses).toHaveLength(1);
  });

  it('desactivada no toca la red; borrar la copia la deja pendiente aquí', async () => {
    const server = new FakeSupabase();
    let enabled = false;
    const a = await device(server, 'ana@ejemplo.com', { enabled: () => enabled });
    a.store.addProject({ name: 'tienda', kind: 'github', location: 'ana/tienda' });
    const before = server.requests.length;
    expect(await a.sync.now()).toMatchObject({ status: 'off', pending: { projects: 1 } });
    expect(server.requests.length).toBe(before);
    enabled = true;
    await a.sync.now();
    expect(server.db.tables.projects).toHaveLength(1);
    expect(await a.sync.deleteCloudCopy()).toMatchObject({ pending: { projects: 1 } });
    expect(server.db.tables.projects).toEqual([]);
  });

  it('si la nube pierde un proyecto (se borró la copia en otro equipo), este equipo lo vuelve a subir', async () => {
    const server = new FakeSupabase();
    const a = await device(server);
    const b = await device(server);
    const p = a.store.addProject({ name: 'tienda', kind: 'github', location: 'ana/tienda' });
    a.store.saveAnalysis(p.id, report(70), timing);
    await a.sync.now();
    await b.sync.now();
    await b.sync.deleteCloudCopy();
    await a.sync.now();
    expect(server.db.tables.projects).toHaveLength(1);
    expect(server.db.tables.analyses).toHaveLength(1);
  });

  it('los cambios del usuario se sincronizan solos al poco', async () => {
    const server = new FakeSupabase();
    const a = await device(server);
    a.store.onChange(() => a.sync.schedule());
    a.store.addProject({ name: 'tienda', kind: 'github', location: 'ana/tienda' });
    await expect.poll(() => server.db.tables.projects.length, { timeout: 2000 }).toBe(1);
    await expect.poll(() => a.states.at(-1)?.status, { timeout: 2000 }).toBe('idle');
  });
});
