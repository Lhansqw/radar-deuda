import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisReport } from '@radar/engine';
import { parseAiOptions, type AiCliOptions } from '../src/ai-setup.js';
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
    expect(parseAiOptions({ ai: 'openrouter', 'ai-model': 'a/b', 'ai-reasoning': 'low' })).toMatchObject({ reasoning: 'low' });
    expect(parseAiOptions({ ai: 'openrouter', 'ai-model': 'a/b', 'ai-reasoning': 'mucho' })).toBeInstanceOf(Error);
    expect(parseAiOptions({ ai: 'lmstudio', 'ai-reasoning': 'low' })).toBeInstanceOf(Error);
    expect(parseAiOptions({ 'ai-reasoning': 'low' })).toBeInstanceOf(Error);
    expect(parseAiOptions({ ai: 'openrouter', 'ai-model': 'a/b:free', 'ai-fallback': ' c/d:free, e/f:free ' })).toMatchObject({ fallbackModels: ['c/d:free', 'e/f:free'] });
    expect(parseAiOptions({ ai: 'openrouter', 'ai-model': 'a/b', 'ai-fallback': 'c/d,x' })).toBeInstanceOf(Error);
    expect(parseAiOptions({ ai: 'openrouter', 'ai-model': 'a/b', 'ai-fallback': 'c/d,e/f,g/h,i/j' })).toBeInstanceOf(Error);
    expect(parseAiOptions({ ai: 'openrouter', 'ai-model': 'a/b', 'ai-fallback': ',' })).toBeInstanceOf(Error);
    expect(parseAiOptions({ ai: 'anthropic', 'ai-fallback': 'c/d' })).toBeInstanceOf(Error);
  });
});

describe('--ai openrouter', () => {
  it('envía solo metadatos, sin retención de datos, y usa el coste real informado', async () => {
    const chats: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'qwen/qwen3-coder', pricing: { prompt: '0.0000002', completion: '0.0000008' } }] });
      if (url.endsWith('/key')) return Response.json({ data: { limit_remaining: null, free_model_daily_requests: { used: 0, limit: 50, remaining: 50 } } });
      const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ role: string; content: string }> };
      chats.push(body);
      const isPlan = body.messages[0]?.content.includes('planifica') ?? false;
      return Response.json({ model: body.model, choices: [{ message: { content: answer(body.messages.map((m) => m.content).join('\n'), isPlan) }, finish_reason: 'stop' }], usage: { prompt_tokens: 800, completion_tokens: 120, cost: 0.0003 } });
    });
    vi.stubEnv('RADAR_OPENROUTER_API_KEY', `  ${['sk', 'or', 'v1', 'x'.repeat(64)].join('-')}\r\n`); // con espacios alrededor, como al pegar
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const json = path.join(await tmp(), 'r.json');
    const o: CliOptions = { target: await repo(), noCache: true, online: false, history: false, quiet: true, top: 5, json, ai: { provider: 'openrouter', model: 'qwen/qwen3-coder', limit: 3, budgetUsd: 0.5, plan: true } };
    await run(o, io, new AbortController().signal);
    const report = JSON.parse(await readFile(json, 'utf8')) as AnalysisReport;
    expect(report.ai?.privacy).toBe('metadatos');
    expect(chats.every((c) => (c['provider'] as { data_collection: string }).data_collection === 'deny')).toBe(true);
    expect(JSON.stringify(chats)).not.toContain('for (const x of a)');
    expect(report.ai?.usage.costUsd).toBeCloseTo(0.0003 * chats.length, 8);
    expect(report.ai?.errors).toEqual([]);
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
    vi.stubEnv('RADAR_ANTHROPIC_API_KEY', ['sk', 'ant', 'prueba', 'x'.repeat(40)].join('-'));
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

  it('comprueba que el modelo existe antes de consultar y explica su razonamiento', async () => {
    const chats: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.endsWith('/models'))
        return Response.json({
          data: [
            { id: 'nvidia/nemotron-3.5-super-vl:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['reasoning', 'structured_outputs'], reasoning: { mandatory: false, supported_efforts: ['high', 'low', 'none'] } },
            { id: 'nvidia/nemotron-3.5-super-vl', pricing: { prompt: '0.0000001', completion: '0.0000004' }, supported_parameters: ['reasoning', 'structured_outputs'], reasoning: { mandatory: false } },
          ],
        });
      if (url.endsWith('/key')) return Response.json({ data: { limit_remaining: null, free_model_daily_requests: { used: 0, limit: 50, remaining: 50 } } });
      chats.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] });
    });
    vi.stubEnv('RADAR_OPENROUTER_API_KEY', ['sk', 'or', 'v1', 'x'.repeat(64)].join('-'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const infos: string[] = [];
    const capture = { info: (m: string) => infos.push(m), warn: (m: string) => infos.push(m) };
    const base: CliOptions = { target: await repo(), noCache: true, online: false, history: false, quiet: true, top: 5, ai: { provider: 'openrouter', model: 'nvidia/nemotron-3.5-super:free', limit: 1, budgetUsd: 0.5, plan: false } };
    await expect(run(base, capture, new AbortController().signal)).rejects.toThrow(/no existe en OpenRouter.*¿Quisiste decir nvidia\/nemotron-3\.5-super-vl:free, nvidia\/nemotron-3\.5-super-vl\?/);
    expect(chats).toHaveLength(0);

    await run({ ...base, ai: { ...(base.ai as AiCliOptions), model: 'nvidia/nemotron-3.5-super-vl:free' } }, capture, new AbortController().signal);
    expect(infos).toContain('Modelo nvidia/nemotron-3.5-super-vl:free (gratuito) · razona, pero se desactiva su razonamiento.');
    expect(chats[0]?.['reasoning']).toEqual({ effort: 'none' });

    // Con un respaldo de pago: se envía la cadena y se avisa del posible coste.
    infos.length = 0;
    chats.length = 0;
    await run({ ...base, ai: { ...(base.ai as AiCliOptions), model: 'nvidia/nemotron-3.5-super-vl:free', fallbackModels: ['nvidia/nemotron-3.5-super-vl'] } }, capture, new AbortController().signal);
    expect(chats[0]?.['models']).toEqual(['nvidia/nemotron-3.5-super-vl:free', 'nvidia/nemotron-3.5-super-vl']);
    expect(infos.some((m) => /gratuitos y de pago.*se cobrará/.test(m))).toBe(true);
    expect(infos).toContain('Respaldo: si nvidia/nemotron-3.5-super-vl:free falla, se probará nvidia/nemotron-3.5-super-vl.');
    vi.unstubAllEnvs();
  });

  it('una clave revocada da un solo error y el informe del motor sigue completo', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      // Con una clave revocada, tanto el catálogo como la comprobación de la clave responden 401.
      return Response.json({ error: { code: 401, message: 'User not found.' } }, { status: 401 });
    });
    vi.stubEnv('RADAR_OPENROUTER_API_KEY', ['sk', 'or', 'v1', 'x'.repeat(64)].join('-'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const json = path.join(await tmp(), 'r.json');
    const o: CliOptions = { target: await repo(), noCache: true, online: false, history: false, quiet: true, top: 5, json, ai: { provider: 'openrouter', model: 'a/b', limit: 5, budgetUsd: 0.5, plan: true } };
    expect(await run(o, io, new AbortController().signal)).toBe(0);
    const report = JSON.parse(await readFile(json, 'utf8')) as AnalysisReport;
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.ai?.errors).toEqual([{ message: expect.stringMatching(/revocada/) as unknown }]);
    expect(urls.some((u) => u.endsWith('/chat/completions'))).toBe(false);
    vi.unstubAllEnvs();
  });

  it('una clave incompleta se detecta antes de enviar nada', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return Response.json({});
    });
    vi.stubEnv('RADAR_OPENROUTER_API_KEY', 'abcd');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const o: CliOptions = { target: await repo(), noCache: true, online: false, history: false, quiet: true, top: 5, ai: { provider: 'openrouter', model: 'a/b', limit: 1, budgetUsd: 0.5, plan: false } };
    await expect(run(o, io, new AbortController().signal)).rejects.toThrow(/tiene 4 caracteres/);
    expect(calls).toBe(0);
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

describe('--preguntar y --proponer', () => {
  const KEY = `${['sk', 'or', 'v1', 'x'.repeat(64)].join('-')}`;
  function stub(reply: (body: { messages: Array<{ role: string; content: string }> }) => string): Array<{ messages: Array<{ role: string; content: string }> }> {
    const chats: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'a/m:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['structured_outputs'] }] });
      if (url.endsWith('/key')) return Response.json({ data: { limit_remaining: null, free_model_daily_requests: { used: 0, limit: 50, remaining: 50 } } });
      const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ role: string; content: string }> };
      chats.push(body);
      return Response.json({ model: body.model, choices: [{ message: { content: reply(body) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 } });
    });
    vi.stubEnv('RADAR_OPENROUTER_API_KEY', KEY);
    return chats;
  }
  const base = async (over: Partial<CliOptions>): Promise<CliOptions> => ({ target: await repo(), noCache: true, online: false, history: false, quiet: true, top: 5, ai: { provider: 'openrouter', model: 'a/m:free', limit: 3, budgetUsd: 0.5, plan: true }, ...over });

  it('validan sus combinaciones', () => {
    expect(parseCli(['.', '--preguntar', '¿Qué hago?'])).toEqual({ kind: 'error', message: '--preguntar y --proponer requieren --ai.' });
    expect(parseCli(['.', '--parche', 'x.patch'])).toEqual({ kind: 'error', message: '--parche requiere --proponer.' });
    const ok = parseCli(['.', '--ai', 'lmstudio', '--proponer', 'H1', '--parche', 'x.patch']);
    expect(ok.kind === 'run' && [ok.options.propose, ok.options.patch]).toEqual(['H1', 'x.patch']);
  });

  it('--preguntar responde con solo metadatos y sin explicar los hallazgos', async () => {
    const chats = stub(() => 'Empieza por [H1].');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m: string) => void logs.push(m));
    await run(await base({ ask: '¿Por dónde empiezo?' }), io, new AbortController().signal);
    expect(chats).toHaveLength(1);
    expect(JSON.stringify(chats)).not.toContain('for (const x of a)');
    const out = logs.join('\n');
    expect(out).toContain('Empieza por [H1].');
    expect(out).toMatch(/Hallazgos citados:\n {2}H1 {2}\[MEDIA\] Función difícil de mantener: procesar · procesar\.ts:1/);
    vi.unstubAllEnvs();
  });

  it('--proponer exige --privacy fragmentos en la nube, muestra la diferencia y guarda el parche', async () => {
    const chats = stub((body) => {
      const id = /El id del hallazgo es "([^"]+)"/.exec(body.messages.at(-1)?.content ?? '')?.[1];
      return JSON.stringify({ id_hallazgo: id, aplicable: true, resumen: 'Retornos tempranos.', cambios: [{ archivo: 'procesar.ts', linea_inicio: 3, linea_fin: 3, reemplazo: '} // fin' }], riesgos: ['Ninguno conocido.'], verificacion: [] });
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(run(await base({ propose: 'H1' }), io, new AbortController().signal)).rejects.toThrow(/--privacy fragmentos/);
    expect(chats).toHaveLength(0);

    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((m: string) => void logs.push(m));
    const patch = path.join(await tmp(), 'cambio.patch');
    const o = await base({ propose: 'h1', patch });
    await run({ ...o, ai: { ...(o.ai as AiCliOptions), privacy: 'fragmentos' } }, io, new AbortController().signal);
    expect(chats).toHaveLength(1);
    const out = logs.join('\n');
    expect(out).toContain('Propuesta de corrección para H1 · Función difícil de mantener: procesar');
    expect(out).toContain('+} // fin');
    expect(await readFile(patch, 'utf8')).toMatch(/^diff --git a\/procesar\.ts b\/procesar\.ts\n/);
    await expect(run({ ...o, propose: 'H99', ai: { ...(o.ai as AiCliOptions), privacy: 'fragmentos' } }, io, new AbortController().signal)).rejects.toThrow(/No hay ningún hallazgo «H99»/);
    vi.unstubAllEnvs();
  });
});
