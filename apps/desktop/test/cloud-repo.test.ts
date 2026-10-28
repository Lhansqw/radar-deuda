import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnalysisReport } from '@radar/engine';
import { AccountService } from '../src/main/account-service.js';
import { cloudConfig, ENV_KEY, ENV_URL } from '../src/main/cloud-config.js';
import { cloudReport, decodeCloudReport, encodeCloudReport } from '../src/main/cloud-report.js';
import { CloudError, SupabaseRepo, type NewCloudAnalysis } from '../src/main/cloud-repo.js';
import { EncryptedSessionStorage } from '../src/main/session-storage.js';
import { FAKE_KEY, FAKE_URL, FakeSupabase } from './helpers/fake-supabase.js';
import { report } from './helpers/report.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

const cipher = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() };
const PASSWORD = 'contraseña-larga-1';

/** Una cuenta con la sesión iniciada contra el Supabase simulado, y su acceso a la base de datos. */
async function signedIn(server: FakeSupabase, email: string): Promise<SupabaseRepo> {
  if (!server.users.has(email)) server.addUser(email, PASSWORD);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'radar-nube-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const account = new AccountService({
    config: cloudConfig({ [ENV_URL]: FAKE_URL, [ENV_KEY]: FAKE_KEY }, null),
    storage: new EncryptedSessionStorage(path.join(dir, 'sesion.bin'), cipher),
    onChange: () => undefined,
    fetch: server.fetch,
    retryReads: false,
  });
  cleanup.push(() => account.dispose());
  await account.signIn(email, PASSWORD, false);
  const db = await account.database();
  if (!db) throw new Error('sin sesión');
  return new SupabaseRepo(db);
}

function withCode(): AnalysisReport {
  const r = report(80);
  r.findings = [
    {
      id: 'f1',
      ruleId: 'markers',
      category: 'maintainability',
      severity: 'low',
      confidence: 'high',
      title: 'Marcadores pendientes',
      message: '2 TODO',
      locations: [{ file: 'src/a.ts', startLine: 3, endLine: 3 }],
      evidence: [{ kind: 'match', tool: 'markers@1', description: 'TODO en línea 3', snippet: '// TODO: quitar la contraseña de aquí' }],
      impact: 'Bajo',
      effort: { minutes: 5, rationale: '5 min' },
    },
  ];
  r.ai = { explanations: [{ findingId: 'f1', summary: 'La línea 3 dice: quitar la contraseña' }] } as unknown as NonNullable<AnalysisReport['ai']>;
  return r;
}

const analysisRow = (id: string, projectId: string, finishedAt: string, r: AnalysisReport = report(80)): NewCloudAnalysis => ({
  id,
  project_id: projectId,
  started_at: finishedAt,
  finished_at: finishedAt,
  duration_ms: 1000,
  score: 80,
  rating: 'A',
  debt_ratio: 0.1,
  effort_minutes: 30,
  findings: 1,
  critical: 0,
  high: 1,
  medium: 0,
  low: 0,
  info: 0,
  head: null,
  branch: null,
  report_gz: encodeCloudReport(r),
});

describe('informe para la nube', () => {
  it('sube sin fragmentos de código ni anotaciones de la IA, y se recupera igual', () => {
    const original = withCode();
    const clean = cloudReport(original);
    expect(clean.ai).toBeUndefined();
    expect(clean.findings[0]?.evidence[0]).toEqual({ kind: 'match', tool: 'markers@1', description: 'TODO en línea 3' });
    expect(clean.findings[0]?.locations).toEqual(original.findings[0]?.locations);
    expect(original.findings[0]?.evidence[0]?.snippet).toBeDefined(); // el original no cambia
    const encoded = encodeCloudReport(original);
    expect(gunzipSync(Buffer.from(encoded, 'base64')).toString()).not.toMatch(/contraseña/);
    expect(decodeCloudReport(encoded)).toEqual(clean);
  });

  it('rechaza lo que no es un informe', () => {
    expect(() => decodeCloudReport(Buffer.from('hola').toString('base64'))).toThrow();
  });
});

describe('SupabaseRepo', () => {
  it('proyectos: crear, buscar, quitar y recuperar; el mismo repositorio dos veces no', async () => {
    const server = new FakeSupabase();
    const repo = await signedIn(server, 'ana@ejemplo.com');
    const id = await repo.addProject({ name: 'tienda', kind: 'github', location: 'ana/tienda', branch: 'main', createdAt: '2026-10-01T00:00:00.000Z' });
    expect(await repo.findProject('github', 'ana/tienda')).toMatchObject({ id, name: 'tienda', branch: 'main', deletedAt: null });
    expect(await repo.findProject('local', 'ana/tienda')).toBeNull();
    await expect(repo.addProject({ name: 'otra', kind: 'github', location: 'ana/tienda', branch: null, createdAt: '2026-10-02T00:00:00.000Z' })).rejects.toThrow(/subir un proyecto \(23505\)/);

    await repo.addAnalysis(analysisRow('6f1c2a4e-9b3d-4c5e-8f70-112233445566', id, '2026-10-20T10:00:00.000Z'));
    await repo.removeProject(id);
    expect((await repo.projects())[0]?.deletedAt).not.toBeNull();
    expect(await repo.analysisRefs()).toEqual([]);
    await repo.restoreProject(id, { name: 'tienda-web', branch: null });
    expect(await repo.projects()).toMatchObject([{ id, name: 'tienda-web', branch: null, deletedAt: null }]);
  });

  it('análisis: subir (dos veces no es error), listar y descargar', async () => {
    const server = new FakeSupabase();
    const repo = await signedIn(server, 'ana@ejemplo.com');
    const project = await repo.addProject({ name: 'tienda', kind: 'github', location: 'ana/tienda', branch: null, createdAt: '2026-10-01T00:00:00.000Z' });
    const row = analysisRow('6f1c2a4e-9b3d-4c5e-8f70-112233445566', project, '2026-10-20T10:00:00.000Z', withCode());
    await repo.addAnalysis(row);
    await repo.addAnalysis(row);
    expect(await repo.analysisRefs()).toEqual([{ id: row.id, projectId: project, finishedAt: row.finished_at }]);
    const got = await repo.analysis(row.id);
    expect(got).toMatchObject({ id: row.id, projectId: project, durationMs: 1000 });
    expect(decodeCloudReport(got?.reportGz ?? '').findings[0]?.evidence[0]?.snippet).toBeUndefined();
    expect(await repo.analysis('0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3')).toBeNull();
  });

  it('lee todas las páginas aunque haya más de 1000 filas', async () => {
    const server = new FakeSupabase();
    const repo = await signedIn(server, 'ana@ejemplo.com');
    const user = server.users.get('ana@ejemplo.com')?.id;
    for (let i = 0; i < 1203; i++) {
      server.db.tables.projects.push({ id: `p-${String(i).padStart(4, '0')}`, user_id: user, name: `p${i}`, kind: 'github', location: `ana/p${i}`, branch: null, created_at: '2026-10-01T00:00:00.000Z', deleted_at: null });
    }
    expect(await repo.projects()).toHaveLength(1203);
  });

  it('cada cuenta solo ve y cambia lo suyo', async () => {
    const server = new FakeSupabase();
    const ana = await signedIn(server, 'ana@ejemplo.com');
    const luis = await signedIn(server, 'luis@ejemplo.com');
    const project = await ana.addProject({ name: 'tienda', kind: 'github', location: 'ana/tienda', branch: null, createdAt: '2026-10-01T00:00:00.000Z' });
    expect(await luis.projects()).toEqual([]);
    await expect(luis.addAnalysis(analysisRow('6f1c2a4e-9b3d-4c5e-8f70-112233445566', project, '2026-10-20T10:00:00.000Z'))).rejects.toThrow(/no dio permiso/);
    await luis.deleteEverything();
    expect(await ana.projects()).toHaveLength(1);
    await ana.deleteEverything();
    expect(await ana.projects()).toEqual([]);
  });

  it('sin conexión el error lo dice (y se reintentará); sin tablas, explica qué falta', async () => {
    const server = new FakeSupabase();
    const repo = await signedIn(server, 'ana@ejemplo.com');
    server.offline = true;
    const offline = await repo.projects().catch((e: unknown) => e);
    expect(offline).toBeInstanceOf(CloudError);
    expect(offline).toMatchObject({ offline: true, message: 'No se pudo conectar con Supabase para leer los proyectos.' });
    server.offline = false;
    const tables = server.db.tables as Record<string, unknown>;
    delete tables['projects'];
    await expect(repo.projects()).rejects.toMatchObject({ offline: false, message: expect.stringMatching(/Faltan las tablas de la nube/) });
  });
});
