import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeRepository, type AnalysisReport } from '@radar/engine';
import { PrivacyError, type LlmProvider } from '@radar/ai';
import { askStep, fixPrivacy, previewFix, proposeFixStep, type AiOptions } from '../src/index.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const CODE_LINE = 'if (x > 7) { while (x) { if (x % 2) { break; } } }';
const KEYS = { openrouter: `sk-or-v1-${'a'.repeat(64)}` };
const BASE: AiOptions = { provider: 'openrouter', model: 'a/rapido:free', limit: 4, budgetUsd: 0.5, plan: false, allowDataCollection: true };

async function demo(): Promise<{ report: AnalysisReport; findingId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'radar-pasos-'));
  dirs.push(root);
  await writeFile(path.join(root, 'f.ts'), `export function f(a: number[], b: boolean, c: boolean) {\n  for (const x of a) { if (b) { if (c) { ${CODE_LINE} } } }\n}\n`);
  const report = await analyzeRepository(root, { cacheDir: null });
  const f = report.findings.find((x) => x.category === 'complexity');
  if (!f) throw new Error('Falta el hallazgo de complejidad');
  return { report, findingId: f.id };
}

/** OpenRouter simulado: catálogo, estado de la clave y una respuesta por petición. */
function stubOpenRouter(answer: (body: { model: string; messages: Array<{ content: string }> }) => string): Array<{ url: string; body: string }> {
  const calls: Array<{ url: string; body: string }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, body: String(init?.body ?? '') });
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'a/rapido:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['structured_outputs'] }, { id: 'b/capaz', pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: ['structured_outputs'] }] });
    if (url.endsWith('/key')) return Response.json({ data: { limit_remaining: null, free_model_daily_requests: { used: 0, limit: 50, remaining: 50 } } });
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> };
    return Response.json({ model: body.model, choices: [{ message: { content: answer(body) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 } });
  });
  return calls;
}

describe('fixPrivacy', () => {
  const provider = (locality: 'local' | 'cloud'): LlmProvider => ({ id: 'p', label: 'Proveedor', locality, complete: () => Promise.reject(new Error('no')) });
  it('local sin preguntar; en la nube, con «fragmentos» o con el permiso del usuario', () => {
    expect(fixPrivacy(BASE, provider('local'), false)).toBe('local');
    expect(fixPrivacy(BASE, provider('cloud'), false)).toBeNull();
    expect(fixPrivacy({ ...BASE, privacy: 'metadatos' }, provider('cloud'), false)).toBeNull();
    expect(fixPrivacy({ ...BASE, privacy: 'metadatos' }, provider('cloud'), true)).toBe('fragmentos');
    expect(fixPrivacy({ ...BASE, privacy: 'fragmentos' }, provider('cloud'), false)).toBe('fragmentos');
    expect(() => fixPrivacy({ ...BASE, privacy: 'local' }, provider('cloud'), true)).toThrow(PrivacyError);
  });
});

describe('previewFix', () => {
  it('muestra exactamente lo que se enviaría y si hace falta permiso, sin usar la red', async () => {
    const { report, findingId } = await demo();
    const calls = stubOpenRouter(() => '');
    const p = await previewFix(report, findingId, BASE, KEYS);
    expect(p).toMatchObject({ provider: 'OpenRouter', cloud: true, needsConsent: true, mayRetain: true });
    expect(p.text).toContain(CODE_LINE);
    expect(p.snippets.map((s) => s.file)).toEqual(['f.ts']);
    expect((await previewFix(report, findingId, { ...BASE, privacy: 'fragmentos', allowDataCollection: false }, KEYS)).needsConsent).toBe(false);
    expect(await previewFix(report, findingId, { ...BASE, provider: 'lmstudio' }, {})).toMatchObject({ cloud: false, needsConsent: false, mayRetain: false });
    expect(calls).toHaveLength(0);
  });
});

describe('proposeFixStep', () => {
  it('sin permiso no envía nada; con permiso envía el fragmento al modelo capaz y devuelve la diferencia', async () => {
    const { report, findingId } = await demo();
    const calls = stubOpenRouter((body) => {
      const id = /El id del hallazgo es "([^"]+)"/.exec(body.messages[0]?.content ?? '')?.[1];
      return JSON.stringify({ id_hallazgo: id, aplicable: true, resumen: 'Extraer la condición.', cambios: [{ archivo: 'f.ts', linea_inicio: 3, linea_fin: 3, reemplazo: '} // fin' }], riesgos: [], verificacion: ['Pruebas de f.'] });
    });
    const s = { consent: false, cacheBase: null, signal: new AbortController().signal };
    await expect(proposeFixStep(report, findingId, BASE, KEYS, s)).rejects.toThrow(/confírmalo en la aplicación/);
    expect(calls).toHaveLength(0);

    const p = await proposeFixStep(report, findingId, { ...BASE, planModel: 'b/capaz' }, KEYS, { ...s, consent: true });
    expect(p).toMatchObject({ applicable: true, privacy: 'fragmentos', model: 'b/capaz' });
    expect(p.patch).toContain('+} // fin');
    const chat = calls.filter((c) => c.url.endsWith('/chat/completions'));
    expect(chat).toHaveLength(1);
    expect(chat[0]?.body).toContain(CODE_LINE.replace(/"/g, '\\"'));
  });
});

describe('askStep', () => {
  it('responde con solo metadatos del informe', async () => {
    const { report } = await demo();
    const calls = stubOpenRouter(() => 'Empieza por [H1].');
    const a = await askStep(report, [], '¿Qué arreglo primero?', BASE, KEYS, { signal: new AbortController().signal });
    expect(a.text).toBe('Empieza por [H1].');
    expect(a.references[0]?.alias).toBe('H1');
    const chat = calls.filter((c) => c.url.endsWith('/chat/completions'));
    expect(chat).toHaveLength(1);
    expect(chat[0]?.body).not.toContain('while (x)');
  });
});
