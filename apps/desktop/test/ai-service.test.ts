import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiSection, AnalysisReport } from '@radar/engine';
import { mergeAiSection } from '../src/main/ai-merge.js';
import { AiService } from '../src/main/ai-service.js';
import { CredentialStore } from '../src/main/credentials.js';
import { Store } from '../src/main/store.js';
import { DEFAULT_SETTINGS, type AppSettings } from '../src/shared/settings.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const f of cleanup.splice(0)) f();
});

const KEY = ['sk', 'or', 'v1', 'q'.repeat(64)].join('-');
const usage = (n: number) => ({ requests: n, cacheHits: 0, inputTokens: 10 * n, outputTokens: 5 * n, costUsd: 0.001 * n, latencyMsTotal: n, latencyMsMax: n });
const explanation = (findingId: string, summary: string) => ({
  findingId,
  summary,
  rootCause: 'c',
  recommendation: 'r',
  claims: [],
  confidence: 'media' as const,
  insufficientInformation: false,
  validationNotes: [],
  provider: 'openrouter',
  model: 'a/b',
  fromCache: false,
});

function setup(settings: AppSettings, withKey = true, root = '/no/existe') {
  const store = Store.open(':memory:');
  cleanup.push(() => store.close());
  const credentials = new CredentialStore(store, { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() }, withKey ? { RADAR_OPENROUTER_API_KEY: KEY } : {});
  const project = store.addProject({ name: 'p', kind: 'local', location: '/p' });
  const report = {
    schemaVersion: 1,
    engineVersion: '0.1.0',
    root,
    generatedAt: new Date().toISOString(),
    config: {},
    score: { score: 70, rating: 'B', debtRatio: 0.1, remediationMinutes: 10, developmentMinutes: 100, codeLines: 10 },
    findings: [
      { id: 'f1', ruleId: 'complexity/function', category: 'complexity', severity: 'high', confidence: 'high', title: 'Función compleja', message: 'm', locations: [{ file: 'a.ts', startLine: 1, endLine: 9 }], evidence: [], impact: 'i', effort: { minutes: 30, rationale: 'r' } },
      { id: 'f2', ruleId: 'markers/todo', category: 'maintainability', severity: 'low', confidence: 'medium', title: 'TODO', message: 'm', locations: [{ file: 'b.ts', startLine: 2, endLine: 2 }], evidence: [], impact: 'i', effort: { minutes: 5, rationale: 'r' } },
    ],
    summary: { bySeverity: { critical: 0, high: 1, medium: 0, low: 1, info: 0 }, byCategory: {} },
    coverage: [],
    errors: [],
    stats: { durationMs: 1, filesDiscovered: 2, filesAnalyzed: 2, cacheHits: 0, skipped: [], cpuUserMs: 1, cpuSystemMs: 1, peakRssMb: 1 },
    ai: { privacy: 'metadatos', explanations: [explanation('f2', 'antigua de f2')], usage: usage(1), errors: [{ findingId: 'f1', message: 'falló antes' }] },
  } as unknown as AnalysisReport;
  const a = store.saveAnalysis(project.id, report, { startedAt: new Date().toISOString(), durationMs: 1 });
  return { store, credentials, report, projectId: project.id, analysisId: a.id, service: new AiService({ store, credentials, settings: () => settings, cacheBase: null }) };
}

const openrouter = (model: string): AppSettings => ({ ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, provider: 'openrouter', model, allowDataCollection: true } });

describe('mergeAiSection', () => {
  it('sustituye las explicaciones de los mismos hallazgos, conserva las demás y el plan, y suma el consumo', () => {
    const plan = { steps: [], notes: [], provider: 'x', model: 'y' };
    const before: AiSection = { privacy: 'metadatos', explanations: [explanation('a', 'vieja'), explanation('b', 'b')], plan, usage: usage(2), errors: [{ findingId: 'a', message: 'error viejo' }, { message: 'general' }] };
    const added: AiSection = { privacy: 'metadatos', explanations: [explanation('a', 'nueva')], usage: usage(1), errors: [] };
    const m = mergeAiSection(before, added);
    expect(m.explanations.map((e) => [e.findingId, e.summary])).toEqual([
      ['b', 'b'],
      ['a', 'nueva'],
    ]);
    expect(m.plan).toBe(plan);
    expect(m.errors).toEqual([{ message: 'general' }]);
    expect(m.usage).toMatchObject({ requests: 3, inputTokens: 30, costUsd: 0.003 });
    expect(mergeAiSection(undefined, added)).toBe(added);
  });
});

describe('AiService', () => {
  it('catálogo: clasifica el razonamiento, ordena por precio y se guarda en caché', async () => {
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      return Response.json({
        data: [
          { id: 'caro/m', pricing: { prompt: '0.000003', completion: '0.000015' }, supported_parameters: ['structured_outputs'] },
          { id: 'libre/m:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['structured_outputs', 'reasoning'], reasoning: { mandatory: false } },
          { id: 'fija/m', pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: [], reasoning: { mandatory: true } },
        ],
      });
    };
    const { store, credentials } = setup(openrouter('a/b'));
    const service = new AiService({ store, credentials, settings: () => DEFAULT_SETTINGS, fetch });
    const models = await service.openRouterModels();
    expect(models.map((m) => [m.id, m.free, m.reasoning, m.outputPerMTok])).toEqual([
      ['libre/m:free', true, 'desactivable', 0],
      ['fija/m', false, 'no ajustable', 2],
      ['caro/m', false, 'no', 15],
    ]);
    await service.openRouterModels();
    expect(calls).toHaveLength(1);
  });

  it('comprueba la clave guardada y explica si no hay ninguna', async () => {
    const fetch = async () => Response.json({ data: { limit_remaining: null, usage: 0.01, free_model_daily_requests: { used: 3, limit: 50, remaining: 47 } } });
    const { store, credentials } = setup(openrouter('a/b'));
    expect(await new AiService({ store, credentials, settings: () => DEFAULT_SETTINGS, fetch }).checkOpenRouterKey()).toEqual({ limitRemaining: null, usage: 0.01, freeDaily: { used: 3, limit: 50, remaining: 47 } });
    const sinClave = setup(openrouter('a/b'), false);
    await expect(sinClave.service.checkOpenRouterKey()).rejects.toThrow(/No hay ninguna clave/);
  });

  it('explica un hallazgo y lo añade al análisis guardado sin perder lo anterior', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'a/b:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['structured_outputs'] }] });
      if (url.endsWith('/key')) return Response.json({ data: { limit_remaining: null, free_model_daily_requests: { used: 0, limit: 50, remaining: 50 } } });
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      bodies.push(body);
      const id = /El id del hallazgo es "([^"]+)"/.exec(body.messages.map((m) => m.content).join('\n'))?.[1];
      const content = JSON.stringify({ id_hallazgo: id, resumen: 'Explicación nueva.', causa_raiz: 'Creció sin control.', recomendacion: 'Dividirla.', afirmaciones: [], confianza: 'media', informacion_insuficiente: false });
      return Response.json({ model: 'a/b:free', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0 } });
    });
    const { service, store, analysisId } = setup(openrouter('a/b:free'));
    const report = await service.explain(analysisId, 'f1');
    expect(bodies).toHaveLength(1); // un solo hallazgo, sin plan
    expect(report.ai?.explanations.map((e) => [e.findingId, e.summary])).toEqual([
      ['f2', 'antigua de f2'],
      ['f1', 'Explicación nueva.'],
    ]);
    expect(report.ai?.errors).toEqual([]);
    expect(store.getReport(analysisId)?.ai?.explanations).toHaveLength(2);
  });

  it('errores claros: sin modelo, hallazgo inexistente o la IA no responde', async () => {
    const sinModelo = setup(openrouter(''));
    await expect(sinModelo.service.explain(sinModelo.analysisId, 'f1')).rejects.toThrow(/Elige un modelo de OpenRouter/);
    const { service, analysisId } = setup(openrouter('a/b'));
    await expect(service.explain(analysisId, 'nada')).rejects.toThrow(/no está en el análisis/);
    await expect(service.explain(999, 'f1')).rejects.toThrow(/ya no existe/);
    vi.stubGlobal('fetch', async () => Response.json({ error: { code: 401, message: 'User not found.' } }, { status: 401 }));
    await expect(service.explain(analysisId, 'f1')).rejects.toThrow(/rechazó la clave/);
  });
});

/** OpenRouter simulado; devuelve las peticiones al modelo. */
function stubOpenRouter(answer: (body: { model: string; messages: Array<{ content: string }> }) => string): Array<{ system: string; body: string }> {
  const chats: Array<{ system: string; body: string }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'a/b:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['structured_outputs'] }] });
    if (url.endsWith('/key')) return Response.json({ data: { limit_remaining: null, free_model_daily_requests: { used: 0, limit: 50, remaining: 50 } } });
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ role: string; content: string }> };
    chats.push({ system: body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n'), body: String(init?.body) });
    return Response.json({ model: body.model, choices: [{ message: { content: answer(body) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 } });
  });
  return chats;
}

describe('AiService: propuestas de corrección', () => {
  it('pide permiso para enviar código, guarda la propuesta y detecta si el archivo cambió después', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'radar-propuesta-'));
    cleanup.push(() => void rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, 'a.ts'), Array.from({ length: 12 }, (_, i) => `const a${i + 1} = ${i + 1};`).join('\n') + '\n');
    const { service, analysisId } = setup(openrouter('a/b:free'), true, root);
    const chats = stubOpenRouter((body) => {
      const id = /El id del hallazgo es "([^"]+)"/.exec(body.messages.at(-1)?.content ?? '')?.[1];
      return JSON.stringify({ id_hallazgo: id, aplicable: true, resumen: 'Cambiar a3.', cambios: [{ archivo: 'a.ts', linea_inicio: 3, linea_fin: 3, reemplazo: 'const a3 = 33;' }], riesgos: [], verificacion: [] });
    });
    const preview = await service.fixPreview(analysisId, 'f1');
    expect(preview).toMatchObject({ provider: 'OpenRouter', cloud: true, needsConsent: true, mayRetain: true });
    expect(preview.text).toContain('const a3 = 3;');
    await expect(service.proposeFix(analysisId, 'f1', false)).rejects.toThrow(/Confirma el envío/);
    expect(chats).toHaveLength(0);

    const r = await service.proposeFix(analysisId, 'f1', true);
    expect(r.stale).toBe(false);
    expect(r.proposal.patch).toContain('-const a3 = 3;\n+const a3 = 33;');
    expect(await service.getFix(analysisId, 'f1')).toMatchObject({ stale: false, proposal: { findingId: 'f1', summary: 'Cambiar a3.' } });
    await writeFile(path.join(root, 'a.ts'), 'const otro = 1;\n');
    expect((await service.getFix(analysisId, 'f1'))?.stale).toBe(true);
    expect(await service.getFix(analysisId, 'f2')).toBeNull();
    await expect(service.fixPreview(analysisId, 'no')).rejects.toThrow(/no está en el análisis/);
  });
});

describe('AiService: preguntas sobre el análisis', () => {
  it('guarda la pregunta y la respuesta, envía la deuda nueva y resuelta, y no guarda nada si falla', async () => {
    const { service, store, report, projectId } = setup(openrouter('a/b:free'));
    // Segundo análisis: f2 resuelto.
    const later = store.saveAnalysis(projectId, { ...report, findings: report.findings.slice(0, 1) }, { startedAt: new Date().toISOString(), durationMs: 1 });
    const chats = stubOpenRouter(() => 'Se resolvió el TODO; queda [H1].');
    const [q, a] = await service.ask(later.id, '  ¿Qué cambió?  ');
    expect(q).toMatchObject({ role: 'user', content: '¿Qué cambió?', meta: null });
    expect(a).toMatchObject({ role: 'assistant', content: 'Se resolvió el TODO; queda [H1].', meta: { references: [{ alias: 'H1', findingId: 'f1' }], unknownReferences: [], truncated: false, model: 'a/b:free', costUsd: 0 } });
    expect(chats[0]?.system).toContain('Resueltos (ya no aparecen): «TODO» (b.ts:2).');

    // La segunda pregunta lleva el historial.
    await service.ask(later.id, '¿Y ahora?');
    expect(chats[1]?.body).toContain('Se resolvió el TODO');

    vi.stubGlobal('fetch', async () => Response.json({ error: { code: 401, message: 'User not found.' } }, { status: 401 }));
    await expect(service.ask(later.id, 'Otra')).rejects.toThrow(/credenciales no válidas/);
    expect(store.listChatMessages(later.id)).toHaveLength(4);
  });

  it('una pregunta a la vez por análisis', async () => {
    const { service, analysisId } = setup(openrouter('a/b:free'));
    stubOpenRouter(() => 'Respuesta.');
    const first = service.ask(analysisId, 'Una');
    await expect(service.ask(analysisId, 'Otra')).rejects.toThrow(/Espera a que termine/);
    await first;
  });
});
