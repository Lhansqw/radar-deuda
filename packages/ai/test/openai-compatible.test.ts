import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { localityOf, ProviderError } from '../src/provider.js';
import { OpenAiCompatibleProvider, PRESETS } from '../src/providers/openai-compatible.js';
import { fakeFetch, json, noSleep } from './helpers/fake-fetch.js';

const req = { model: 'm', system: 'sistema', messages: [{ role: 'user' as const, content: 'hola' }], maxOutputTokens: 100 };
const ok = (content: string, extra: object = {}) => json({ model: 'm-real', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5 }, ...extra });

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

describe('localityOf', () => {
  it.each([
    ['http://localhost:1234/v1', 'local'],
    ['http://127.0.0.1:11434/v1', 'local'],
    ['http://[::1]:8080/v1', 'local'],
    ['https://api.openai.com/v1', 'cloud'],
    ['http://192.168.1.20:1234/v1', 'cloud'], // otro equipo de la red: sale del equipo
  ])('%s → %s', (url, expected) => {
    expect(localityOf(url)).toBe(expected);
  });
});

describe('OpenAiCompatibleProvider', () => {
  it('envía el sistema como primer mensaje, pide JSON estructurado y normaliza la respuesta', async () => {
    const fetch = fakeFetch(() => ok('{"a":1}'));
    const p = new OpenAiCompatibleProvider({ ...PRESETS.lmstudio, fetch });
    const r = await p.complete({ ...req, jsonSchema: { name: 'x', schema: { type: 'object' } } });
    const body = JSON.parse(String(fetch.calls[0]?.init?.body)) as Record<string, unknown>;
    expect(fetch.calls[0]?.url).toBe('http://localhost:1234/v1/chat/completions');
    expect(body['messages']).toEqual([{ role: 'system', content: 'sistema' }, { role: 'user', content: 'hola' }]);
    expect(body['max_tokens']).toBe(100);
    expect(body['response_format']).toEqual({ type: 'json_schema', json_schema: { name: 'x', strict: true, schema: { type: 'object' } } });
    expect(r).toMatchObject({ text: '{"a":1}', model: 'm-real', finishReason: 'stop', usage: { inputTokens: 12, outputTokens: 5 } });
    expect(p.locality).toBe('local');
  });

  it('si el servidor no soporta salida estructurada, repite sin ella y lo recuerda', async () => {
    let n = 0;
    const fetch = fakeFetch(() => (++n === 1 ? json({ error: 'response_format json_schema is not supported' }, 400) : ok('{}')));
    const p = new OpenAiCompatibleProvider({ ...PRESETS.ollama, fetch });
    await p.complete({ ...req, jsonSchema: { name: 'x', schema: {} } });
    await p.complete({ ...req, jsonSchema: { name: 'x', schema: {} } });
    const bodies = fetch.calls.map((c) => JSON.parse(String(c.init?.body)) as Record<string, unknown>);
    expect(bodies.map((b) => 'response_format' in b)).toEqual([true, false, false]);
  });

  it('OpenAI usa max_completion_tokens y la clave como Bearer; exige https en la nube', async () => {
    const fetch = fakeFetch(() => ok('x'));
    await new OpenAiCompatibleProvider({ ...PRESETS.openai, apiKey: 'sk-x', fetch }).complete(req);
    const body = JSON.parse(String(fetch.calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body['max_completion_tokens']).toBe(100);
    expect((fetch.calls[0]?.init?.headers as Record<string, string>)['authorization']).toBe('Bearer sk-x');
    expect(() => new OpenAiCompatibleProvider({ id: 'x', label: 'x', baseUrl: 'http://ejemplo.com/v1' })).toThrow(/https/);
  });

  it('traduce errores a tipos accionables', async () => {
    const cases: Array<[Response, string]> = [
      [json({}, 401), 'auth'],
      [json({}, 429), 'rate-limit'],
      [json({ error: 'maximum context length is 4096 tokens' }, 400), 'context-length'],
      [json({}, 404), 'invalid-request'],
      [json({}, 503), 'unavailable'],
    ];
    for (const [res, kind] of cases) {
      const p = new OpenAiCompatibleProvider({ ...PRESETS.lmstudio, fetch: fakeFetch(() => res.clone()), retries: 0, sleep: noSleep });
      await expect(p.complete(req)).rejects.toMatchObject({ kind });
    }
  });

  it('sin servidor local, sugiere cómo iniciarlo', async () => {
    const p = new OpenAiCompatibleProvider({ ...PRESETS.lmstudio, baseUrl: 'http://127.0.0.1:9/v1', retries: 0, timeoutMs: 2000 });
    const err = await p.complete(req).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toMatch(/lms server start/);
  });

  it('funciona contra un servidor HTTP real (como LM Studio) y lista los modelos', async () => {
    server = createServer((rq, rs) => {
      let raw = '';
      rq.on('data', (c: Buffer) => (raw += c.toString()));
      rq.on('end', () => {
        rs.setHeader('content-type', 'application/json');
        if (rq.url === '/v1/models') {
          rs.end(JSON.stringify({ data: [{ id: 'qwen-coder' }, { id: 'otro' }] }));
          return;
        }
        const body = JSON.parse(raw) as { messages: Array<{ content: string }> };
        rs.end(JSON.stringify({ model: 'qwen-coder', choices: [{ message: { content: `eco:${body.messages[1]?.content}` }, finish_reason: 'length' }] }));
      });
    });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    const p = new OpenAiCompatibleProvider({ id: 'local', label: 'local', baseUrl: `http://127.0.0.1:${port}/v1` });
    expect(await p.listModels()).toEqual(['qwen-coder', 'otro']);
    expect(await p.complete(req)).toMatchObject({ text: 'eco:hola', finishReason: 'length', usage: null });
  });
});
