import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisReport } from '@radar/engine';
import { CredentialStore } from '../src/main/credentials.js';
import { aiOptionsFrom, JobError, JobManager, sinceFromMonths, type WorkerHandle } from '../src/main/jobs.js';
import { Store } from '../src/main/store.js';
import type { JobState } from '../src/shared/jobs.js';
import { DEFAULT_SETTINGS, type AppSettings } from '../src/shared/settings.js';
import type { FromWorker, StartMessage, ToWorker } from '../src/worker/protocol.js';
import { runJob } from '../src/worker/run-job.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const f of cleanup.splice(0)) await f();
});

/** Proceso de análisis simulado: registra lo que recibe y permite responder a mano. */
function fakeWorker() {
  const received: ToWorker[] = [];
  let onMessage: (m: FromWorker) => void = () => undefined;
  let onExit: (code: number) => void = () => undefined;
  const handle: WorkerHandle & { killed: number } = {
    killed: 0,
    postMessage: (m) => received.push(m),
    onMessage: (cb) => (onMessage = cb),
    onExit: (cb) => (onExit = cb),
    kill: () => {
      handle.killed++;
    },
  };
  return { handle, received, send: (m: FromWorker) => onMessage(m), exit: (code: number) => onExit(code) };
}

const report = (score = 70): AnalysisReport =>
  ({
    schemaVersion: 1,
    engineVersion: '0.1.0',
    root: '/r',
    generatedAt: '2026-10-26T00:00:00Z',
    config: {},
    score: { score, rating: 'B', debtRatio: 0.1, remediationMinutes: 60, developmentMinutes: 600, codeLines: 100 },
    findings: [],
    summary: { bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, byCategory: {} },
    coverage: [],
    errors: [],
    stats: { durationMs: 1, filesDiscovered: 1, filesAnalyzed: 1, cacheHits: 0, skipped: [], cpuUserMs: 1, cpuSystemMs: 1, peakRssMb: 1 },
  }) as unknown as AnalysisReport;

function setup(settings: AppSettings = DEFAULT_SETTINGS, env: NodeJS.ProcessEnv = {}) {
  const store = Store.open(':memory:');
  cleanup.push(() => store.close());
  const cipher = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() };
  const credentials = new CredentialStore(store, cipher, env);
  const workers: Array<ReturnType<typeof fakeWorker>> = [];
  const spawned: Array<{ memoryLimitMb: number }> = [];
  const events: JobState[] = [];
  const jobs = new JobManager({
    store,
    credentials,
    settings: () => settings,
    spawn: (o) => {
      spawned.push(o);
      const w = fakeWorker();
      workers.push(w);
      return w.handle;
    },
    emit: (s) => events.push(s),
    now: () => new Date('2026-10-26T15:00:00Z'),
    cancelGraceMs: 50,
  });
  const project = store.addProject({ name: 'demo', kind: 'local', location: '/repos/demo' });
  return { store, credentials, jobs, workers, events, project, spawned };
}

describe('JobManager', () => {
  it('lanza un proceso con la petición derivada de los ajustes y guarda el análisis', () => {
    const { jobs, workers, events, project, store, spawned } = setup({ ...DEFAULT_SETTINGS, analysis: { history: true, historyMonths: 6, online: true, memoryLimitMb: 2048 } });
    const job = jobs.start(project.id);
    expect(spawned).toEqual([{ memoryLimitMb: 2048 }]);
    expect(job).toMatchObject({ projectId: project.id, status: 'running', phase: 'starting', analysisId: null });
    const w = workers[0];
    expect(w?.received[0]).toEqual({ type: 'start', request: { target: '/repos/demo', history: true, since: '2026-04-26', online: true, noCache: false } });

    w?.send({ type: 'event', event: { phase: 'files', done: 3, total: 10 } });
    expect(events.at(-1)).toMatchObject({ phase: 'files', progress: { done: 3, total: 10 } });
    w?.send({ type: 'log', level: 'warn', message: 'Aviso de prueba' });
    expect(events.at(-1)?.log).toEqual([{ level: 'warn', message: 'Aviso de prueba', at: '2026-10-26T15:00:00.000Z' }]);

    w?.send({ type: 'report', report: report(81), durationMs: 1500 });
    const saved = events.at(-1);
    expect(saved?.analysisId).toBeGreaterThan(0);
    expect(saved?.phase).toBe('saving'); // sin IA no hay etapa de IA
    expect(store.listAnalyses(project.id)[0]).toMatchObject({ score: 81, durationMs: 1500 });

    w?.send({ type: 'finished' });
    expect(events.at(-1)).toMatchObject({ status: 'done', phase: 'finished', error: null, finishedAt: '2026-10-26T15:00:00.000Z' });
    expect(w?.handle.killed).toBe(1);
    expect(jobs.list().map((j) => j.status)).toEqual(['done']);
  });

  it('limita la frecuencia de los avisos de progreso de archivos', () => {
    const { jobs, workers, events, project } = setup();
    jobs.start(project.id);
    const before = events.length;
    for (let i = 1; i <= 50; i++) workers[0]?.send({ type: 'event', event: { phase: 'files', done: i, total: 50 } });
    // Primer aviso de la etapa nueva y nada más dentro de la misma ventana de 100 ms (el reloj está fijo).
    expect(events.length - before).toBe(1);
  });

  it('con IA automática pasa las opciones y las claves; un fallo de la IA no pierde el análisis', () => {
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      ai: { ...DEFAULT_SETTINGS.ai, auto: true, model: 'a/b:free', fallbackModels: ['c/d:free'], allowDataCollection: true, reasoning: 'low', budgetUsd: 0.2, limit: 3 },
    };
    const key = ['sk', 'or', 'v1', 'k'.repeat(64)].join('-');
    const { jobs, workers, events, project, store } = setup(settings, { RADAR_OPENROUTER_API_KEY: key });
    jobs.start(project.id);
    const start = workers[0]?.received[0] as StartMessage;
    expect(start.ai).toEqual({
      options: { provider: 'openrouter', limit: 3, budgetUsd: 0.2, plan: true, model: 'a/b:free', fallbackModels: ['c/d:free'], allowDataCollection: true, reasoning: 'low' },
      keys: { openrouter: key },
    });
    workers[0]?.send({ type: 'report', report: report(), durationMs: 10 });
    expect(events.at(-1)?.phase).toBe('ai');
    workers[0]?.send({ type: 'ai-error', message: 'Clave revocada.' });
    workers[0]?.send({ type: 'finished' });
    expect(events.at(-1)).toMatchObject({ status: 'done', aiError: 'Clave revocada.' });
    expect(store.listAnalyses(project.id)).toHaveLength(1);
  });

  it('añade la sección de IA al análisis ya guardado', () => {
    const { jobs, workers, store, project } = setup();
    jobs.start(project.id);
    workers[0]?.send({ type: 'report', report: report(), durationMs: 10 });
    const section = { privacy: 'metadatos' as const, explanations: [], usage: { requests: 2, cacheHits: 0, inputTokens: 5, outputTokens: 5, costUsd: 0, latencyMsTotal: 1, latencyMsMax: 1 }, errors: [] };
    workers[0]?.send({ type: 'ai', section, label: 'OpenRouter · a/b' });
    const [a] = store.listAnalyses(project.id);
    expect(a?.withAi).toBe(true);
    expect(store.getReport(a?.id ?? 0)?.ai?.usage.requests).toBe(2);
  });

  it('un análisis a la vez, y un proyecto inexistente da un error claro', () => {
    const { jobs, project, store } = setup();
    const other = store.addProject({ name: 'otro', kind: 'github', location: 'org/otro' });
    jobs.start(project.id);
    expect(() => jobs.start(other.id)).toThrow(new JobError('Ya hay un análisis en curso (demo). Espera a que termine o cancélalo.'));
    expect(() => jobs.start(999)).toThrow(/ya no existe/);
  });

  it('cancela: pide al proceso que se detenga y, si no responde, lo termina', async () => {
    const { jobs, workers, events, project } = setup();
    const job = jobs.start(project.id);
    jobs.cancel(job.jobId);
    expect(workers[0]?.received.at(-1)).toEqual({ type: 'cancel' });
    await new Promise((r) => setTimeout(r, 80));
    expect(workers[0]?.handle.killed).toBe(1);
    expect(events.at(-1)).toMatchObject({ status: 'cancelled', error: 'Análisis cancelado.' });
    // Ya se puede iniciar otro.
    expect(jobs.start(project.id).status).toBe('running');
  });

  it('si el proceso responde a la cancelación, termina como cancelado', () => {
    const { jobs, workers, events, project } = setup();
    const job = jobs.start(project.id);
    jobs.cancel(job.jobId);
    workers[0]?.send({ type: 'error', message: 'This operation was aborted', cancelled: true });
    expect(events.at(-1)).toMatchObject({ status: 'cancelled', error: 'Análisis cancelado.' });
  });

  it('si el proceso muere inesperadamente, falla con un mensaje (y conserva lo guardado)', () => {
    const { jobs, workers, events, project } = setup();
    jobs.start(project.id);
    workers[0]?.send({ type: 'report', report: report(), durationMs: 10 });
    workers[0]?.exit(134);
    expect(events.at(-1)).toMatchObject({ status: 'failed', error: 'El proceso de análisis terminó inesperadamente (código 134). El análisis del motor sí se guardó.' });
  });

  it('los repositorios de GitHub usan la rama y el token guardados', () => {
    const token = `github_pat_${'T'.repeat(30)}`;
    const { jobs, workers, store, credentials } = setup();
    credentials.set('github', token);
    const gh = store.addProject({ name: 'repo', kind: 'github', location: 'org/repo', branch: 'develop' });
    jobs.start(gh.id);
    expect((workers[0]?.received[0] as StartMessage).request).toMatchObject({ target: 'org/repo', branch: 'develop', githubToken: token });
  });
});

describe('ajustes → opciones', () => {
  it('solo pasa las opciones de OpenRouter a OpenRouter y la URL local a los proveedores locales', () => {
    expect(aiOptionsFrom({ ...DEFAULT_SETTINGS.ai, provider: 'anthropic', fallbackModels: [], allowDataCollection: true, localUrl: 'http://x/' })).toEqual({ provider: 'anthropic', limit: 8, budgetUsd: 0.5, plan: true });
    expect(aiOptionsFrom({ ...DEFAULT_SETTINGS.ai, provider: 'lmstudio', privacy: 'local', localUrl: 'http://localhost:1235/v1' })).toEqual({
      provider: 'lmstudio',
      limit: 8,
      budgetUsd: 0.5,
      plan: true,
      privacy: 'local',
      url: 'http://localhost:1235/v1',
    });
  });

  it('calcula el inicio del historial', () => {
    expect(sinceFromMonths(12, new Date('2026-10-26T12:00:00Z'))).toBe('2025-10-26');
    expect(sinceFromMonths(1, new Date('2026-03-31T12:00:00Z'))).toBe('2026-02-28');
    expect(sinceFromMonths(1, new Date('2028-03-31T12:00:00Z'))).toBe('2028-02-29');
    expect(sinceFromMonths(14, new Date('2026-01-15T12:00:00Z'))).toBe('2024-11-15');
  });
});

describe('proceso de análisis (runJob)', () => {
  it('analiza un repositorio real, informa del progreso y del resultado', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'radar-worker-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(path.join(dir, 'a.ts'), 'export const API_TOKEN = "Zq8vT2mW9xLp4RbN7cYd";\n');
    const out: FromWorker[] = [];
    await runJob({ type: 'start', request: { target: dir, history: false, online: false, noCache: true } }, (m) => out.push(m), new AbortController().signal);
    const types = out.map((m) => m.type);
    expect(types[0]).toBe('event');
    expect(types.slice(-2)).toEqual(['report', 'finished']);
    const r = out.find((m) => m.type === 'report');
    expect(r?.type === 'report' && r.report.findings.some((f) => f.category === 'security')).toBe(true);
  });

  it('si la IA no puede ejecutarse, el informe ya se envió y la IA se informa aparte', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'radar-worker-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(path.join(dir, 'a.ts'), 'export const x = 1;\n');
    const out: FromWorker[] = [];
    await runJob(
      { type: 'start', request: { target: dir, history: false, online: false, noCache: true }, ai: { options: { provider: 'openrouter', model: 'a/b', limit: 1, budgetUsd: 0.1, plan: false }, keys: {} } },
      (m) => out.push(m),
      new AbortController().signal,
    );
    expect(out.map((m) => m.type).filter((t) => t !== 'event' && t !== 'log')).toEqual(['report', 'ai-error', 'finished']);
    expect(out.find((m) => m.type === 'ai-error')).toMatchObject({ message: expect.stringMatching(/RADAR_OPENROUTER_API_KEY/) as unknown });
  });

  it('un origen inválido o la cancelación se informan como error', async () => {
    const out: FromWorker[] = [];
    await runJob({ type: 'start', request: { target: 'no/existe/nada', history: false, online: false, noCache: true } }, (m) => out.push(m), new AbortController().signal);
    expect(out).toEqual([{ type: 'error', message: expect.stringMatching(/ni es una referencia válida/) as unknown, cancelled: false }]);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'radar-worker-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const c = new AbortController();
    c.abort();
    const out2: FromWorker[] = [];
    await runJob({ type: 'start', request: { target: dir, history: false, online: false, noCache: true } }, (m) => out2.push(m), c.signal);
    expect(out2.at(-1)).toEqual({ type: 'error', message: 'Análisis cancelado.', cancelled: true });
  });
});

describe('memoria del proceso de análisis', () => {
  it('avisa antes de agotar el límite, con qué hacer', async () => {
    const { memoryPressure } = await import('../src/worker/memory.js');
    const MB = 1024 * 1024;
    expect(memoryPressure({ used_heap_size: 800 * MB, heap_size_limit: 1024 * MB })).toBeNull();
    const msg = memoryPressure({ used_heap_size: 950 * MB, heap_size_limit: 1024 * MB });
    expect(msg).toMatch(/usaba 950 MB de un límite de 1024 MB/);
    expect(msg).toMatch(/Configuración → Análisis/);
    expect(msg).toMatch(/\.radarignore/);
    expect(memoryPressure({ used_heap_size: 1, heap_size_limit: 0 })).toBeNull();
  });
});
