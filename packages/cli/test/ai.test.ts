import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisReport } from '@radar/engine';
import { parseAiOptions } from '../src/ai-setup.js';
import { parseCli, run, type CliOptions } from '../src/app.js';

const dirs: string[] = [];
let server: Server | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'radar-cli-ai-'));
  dirs.push(d);
  return d;
}
const io = { info: () => undefined, warn: () => undefined };
const CODE = `export function procesar(a: number[], b: boolean, c: boolean) {
  for (const x of a) { if (b) { if (c) { if (x > 1) { while (x) { if (x % 2) { break; } } } } } }
}`;

async function repo(): Promise<string> {
  const root = await tmp();
  await writeFile(path.join(root, 'procesar.ts'), CODE);
  return root;
}

/** Respuesta válida que reutiliza el id recibido (como haría un modelo obediente al formato). */
function answer(prompt: string, isPlan: boolean): string {
  if (isPlan) {
    const ids = [...prompt.matchAll(/id=(\S+)/g)].map((m) => m[1]);
    return JSON.stringify({ pasos: [{ hallazgos: ids, horizonte: 'inmediato', titulo: 'Simplificar procesar', justificacion: 'Es la deuda principal.' }], notas: [] });
  }
  const id = /El id del hallazgo es "([^"]+)"/.exec(prompt)?.[1] ?? '';
  return JSON.stringify({
    id_hallazgo: id,
    resumen: 'La función anida demasiados condicionales.',
    causa_raiz: 'Se añadieron casos sin extraer funciones.',
    recomendacion: 'Usar retornos tempranos y extraer el bucle interior.',
    afirmaciones: [{ tipo: 'evidencia', texto: 'La complejidad cognitiva es 21 con umbral 15.', archivo: '', linea_inicio: 0, linea_fin: 0 }],
    confianza: 'alta',
    informacion_insuficiente: false,
  });
}

describe('opciones de IA', () => {
  it('valida proveedor, privacidad, límites y dependencias entre opciones', () => {
    expect(parseAiOptions({})).toBeUndefined();
    expect(parseAiOptions({ privacy: 'local' })).toBeInstanceOf(Error);
    expect(parseAiOptions({ ai: 'gpt' })).toBeInstanceOf(Error);
    expect(parseAiOptions({ ai: 'url' })).toBeInstanceOf(Error);
    expect(parseAiOptions({ ai: 'lmstudio', privacy: 'todo' })).toBeInstanceOf(Error);
    expect(parseAiOptions({ ai: 'lmstudio', 'ai-limit': '0' })).toBeInstanceOf(Error);
    expect(parseAiOptions({ ai: 'anthropic', 'ai-budget': '0.1' })).toMatchObject({ provider: 'anthropic', budgetUsd: 0.1, limit: 8, plan: true });
    expect(parseCli(['.', '--ai', 'lmstudio', '--no-ai-plan'])).toMatchObject({ kind: 'run', options: { ai: { provider: 'lmstudio', plan: false } } });
  });

  it('OpenRouter exige un modelo válido y sus opciones de privacidad no aplican a otros proveedores', () => {
    expect(parseAiOptions({ ai: 'openrouter' })).toBeInstanceOf(Error);
    expect(parseAiOptions({ ai: 'openrouter', 'ai-model': 'sin-proveedor' })).toBeInstanceOf(Error);
    expect(parseAiOptions({ ai: 'lmstudio', 'ai-zdr': true })).toBeInstanceOf(Error);
    expect(parseAiOptions({ ai: 'openrouter', 'ai-model': 'a/b', 'ai-zdr': true, 'ai-allow-data-collection': true })).toBeInstanceOf(Error);
    expect(parseAiOptions({ ai: 'openrouter', 'ai-model': 'qwen/qwen3-coder', 'ai-zdr': true })).toMatchObject({ provider: 'openrouter', model: 'qwen/qwen3-coder', zeroDataRetention: true });
  });
});

describe('--ai openrouter', () => {
  it('envía solo metadatos, sin retención de datos, y usa el coste real informado', async () => {
    const chats: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'qwen/qwen3-coder', pricing: { prompt: '0.0000002', completion: '0.0000008' } }] });
      const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ role: string; content: string }> };
      chats.push(body);
      const isPlan = body.messages[0]?.content.includes('planifica') ?? false;
      return Response.json({ model: body.model, choices: [{ message: { content: answer(body.messages.map((m) => m.content).join('\n'), isPlan) }, finish_reason: 'stop' }], usage: { prompt_tokens: 800, completion_tokens: 120, cost: 0.0003 } });
    });
    vi.stubEnv('RADAR_OPENROUTER_API_KEY', 'sk-or-de-prueba');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const json = path.join(await tmp(), 'r.json');
    const o: CliOptions = { target: await repo(), noCache: true, online: false, history: false, quiet: true, top: 5, json, ai: { provider: 'openrouter', model: 'qwen/qwen3-coder', limit: 3, budgetUsd: 0.5, plan: true } };
    await run(o, io, new AbortController().signal);
    const report = JSON.parse(await readFile(json, 'utf8')) as AnalysisReport;
    expect(report.ai?.privacy).toBe('metadatos');
    expect(chats.every((c) => (c['provider'] as { data_collection: string }).data_collection === 'deny')).toBe(true);
    expect(JSON.stringify(chats)).not.toContain('for (const x of a)');
    expect(report.ai?.usage.costUsd).toBeCloseTo(0.0003 * chats.length, 8);
    vi.unstubAllEnvs();
  });
});

describe('--ai con un servidor local compatible con OpenAI (como LM Studio)', () => {
  it('elige el modelo cargado, explica, planifica y lo guarda en el informe', async () => {
    const requests: Array<{ model: string; messages: Array<{ content: string }> }> = [];
    server = createServer((rq, rs) => {
      let raw = '';
      rq.on('data', (c: Buffer) => (raw += c.toString()));
      rq.on('end', () => {
        rs.setHeader('content-type', 'application/json');
        if (rq.url === '/v1/models') {
          rs.end(JSON.stringify({ data: [{ id: 'text-embedding-nomic' }, { id: 'qwen-coder-local' }] }));
          return;
        }
        const body = JSON.parse(raw) as { model: string; messages: Array<{ role: string; content: string }> };
        requests.push(body);
        const isPlan = body.messages[0]?.content.includes('planifica') ?? false;
        rs.end(JSON.stringify({ model: body.model, choices: [{ message: { content: answer(body.messages.map((m) => m.content).join('\n'), isPlan) }, finish_reason: 'stop' }], usage: { prompt_tokens: 300, completion_tokens: 80 } }));
      });
    });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    const root = await repo();
    const json = path.join(await tmp(), 'r.json');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m: string) => void logs.push(m));
    const o: CliOptions = { target: root, noCache: true, online: false, history: false, quiet: true, top: 5, json, ai: { provider: 'lmstudio', url: `http://127.0.0.1:${port}/v1`, limit: 3, budgetUsd: 0.5, plan: true } };
    expect(await run(o, io, new AbortController().signal)).toBe(0);
    const report = JSON.parse(await readFile(json, 'utf8')) as AnalysisReport;
    expect(report.ai?.privacy).toBe('local');
    expect(report.ai?.explanations[0]).toMatchObject({ model: 'qwen-coder-local', confidence: 'alta' });
    expect(report.ai?.explanations[0]?.claims[0]?.kind).toBe('evidencia'); // 21 y 15 están en los datos enviados
    expect(report.ai?.plan?.steps[0]?.title).toBe('Simplificar procesar');
    expect(report.ai?.usage).toMatchObject({ costUsd: 0, inputTokens: 300 * requests.length });
    expect(requests.every((r) => r.model === 'qwen-coder-local')).toBe(true); // se ignoró el modelo de embeddings
    expect(JSON.stringify(requests)).toContain('for (const x of a)'); // local: puede ver el código
    expect(logs.join('\n')).toMatch(/Análisis con IA — LM Studio \(local\) · qwen-coder-local/);
  });
});

describe('--ai anthropic', () => {
  it('por defecto solo envía metadatos y contabiliza el coste con la tabla de precios', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { model: string; system: string; messages: Array<{ content: string }> };
      bodies.push(body);
      const isPlan = body.system.includes('planifica');
      return Response.json({ model: body.model, content: [{ type: 'text', text: answer(body.messages.map((m) => m.content).join('\n'), isPlan) }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200 } });
    });
    vi.stubEnv('RADAR_ANTHROPIC_API_KEY', 'clave-de-prueba');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const root = await repo();
    const json = path.join(await tmp(), 'r.json');
    const o: CliOptions = { target: root, noCache: true, online: false, history: false, quiet: true, top: 5, json, ai: { provider: 'anthropic', limit: 3, budgetUsd: 0.5, plan: true } };
    await run(o, io, new AbortController().signal);
    const report = JSON.parse(await readFile(json, 'utf8')) as AnalysisReport;
    expect(report.ai?.privacy).toBe('metadatos');
    expect(JSON.stringify(bodies)).not.toContain('for (const x of a)');
    expect(bodies.map((b) => b['model'])).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
    // haiku: 1000×0,10 + 200×0,50 = 0,0002 USD · sonnet: 1000×2 + 200×10 = 0,004 USD
    expect(report.ai?.usage.costUsd).toBeCloseTo(0.0042, 6);
    vi.unstubAllEnvs();
  });

  it('sin clave informa de cómo configurarla', async () => {
    vi.stubEnv('RADAR_ANTHROPIC_API_KEY', '');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const o: CliOptions = { target: await repo(), noCache: true, online: false, history: false, quiet: true, top: 5, ai: { provider: 'anthropic', limit: 1, budgetUsd: 0.5, plan: false } };
    await expect(run(o, io, new AbortController().signal)).rejects.toThrow(/RADAR_ANTHROPIC_API_KEY/);
    vi.unstubAllEnvs();
  });
});
