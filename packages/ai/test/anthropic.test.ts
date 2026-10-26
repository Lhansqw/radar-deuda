import { describe, expect, it } from 'vitest';
import { AnthropicProvider, ANTHROPIC_API_VERSION } from '../src/providers/anthropic.js';
import { FAKE_KEYS } from './helpers/keys.js';
import { fakeFetch, json, noSleep } from './helpers/fake-fetch.js';

const req = { model: 'claude-haiku-5-5', system: 'sistema', messages: [{ role: 'user' as const, content: 'hola' }], maxOutputTokens: 200 };
const okBody = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  content: [{ type: 'text', text: '{"ok":' }, { type: 'text', text: 'true}' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 },
};

describe('AnthropicProvider', () => {
  it('usa la versión fijada, x-api-key y output_config; nunca envía temperature', async () => {
    const fetch = fakeFetch(() => json(okBody, 200, { 'request-id': 'req_1' }));
    const p = new AnthropicProvider({ apiKey: FAKE_KEYS.anthropic, fetch });
    const r = await p.complete({ ...req, jsonSchema: { name: 'x', schema: { type: 'object', additionalProperties: false } } });
    const call = fetch.calls[0];
    const headers = call?.init?.headers as Record<string, string>;
    const body = JSON.parse(String(call?.init?.body)) as Record<string, unknown>;
    expect(call?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(headers['anthropic-version']).toBe(ANTHROPIC_API_VERSION);
    expect(headers['x-api-key']).toBe(FAKE_KEYS.anthropic);
    expect(body).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 200,
      system: 'sistema',
      messages: [{ role: 'user', content: 'hola' }],
      output_config: { format: { type: 'json_schema', schema: { type: 'object', additionalProperties: false } } },
    });
    expect('temperature' in body).toBe(false);
    expect(r).toEqual({ text: '{"ok":true}', model: 'claude-haiku-5-5', finishReason: 'stop', usage: { inputTokens: 150, outputTokens: 20 }, latencyMs: expect.any(Number), requestId: 'req_1' });
  });

  it.each([
    ['max_tokens', 'length'],
    ['refusal', 'refusal'],
    ['pause_turn', 'other'], // valores nuevos: se toleran
  ])('stop_reason %s → %s', async (stop, finish) => {
    const p = new AnthropicProvider({ apiKey: FAKE_KEYS.anthropic, fetch: fakeFetch(() => json({ ...okBody, stop_reason: stop })) });
    expect((await p.complete(req)).finishReason).toBe(finish);
  });

  it('clasifica los errores de la API y conserva el request-id', async () => {
    const err = (status: number, type: string, headers: Record<string, string> = {}) =>
      json({ type: 'error', error: { type, message: 'm' }, request_id: 'req_X' }, status, headers);
    const cases: Array<[Response, string, RegExp]> = [
      [err(401, 'authentication_error'), 'auth', /no es válida/],
      [err(402, 'billing_error'), 'quota', /facturación/],
      [err(429, 'rate_limit_error'), 'quota', /tope de gasto/], // sin retry-after
      [err(429, 'rate_limit_error', { 'retry-after': '1' }), 'rate-limit', /límite de peticiones/],
      [err(529, 'overloaded_error'), 'overloaded', /sobrecargado/],
      [err(413, 'request_too_large'), 'context-length', /demasiado grande/],
      [err(400, 'invalid_request_error'), 'invalid-request', /invalid_request_error/],
    ];
    for (const [res, kind, message] of cases) {
      const p = new AnthropicProvider({ apiKey: FAKE_KEYS.anthropic, fetch: fakeFetch(() => res.clone()), retries: 0, sleep: noSleep });
      const e = await p.complete(req).then(() => null, (x: unknown) => x as Error & { kind: string });
      expect(e?.kind).toBe(kind);
      expect(e?.message).toMatch(message);
      expect(e?.message).toMatch(/req_X/);
      expect(e?.message).not.toContain(FAKE_KEYS.anthropic);
    }
  });

  it('reintenta 529 y 429 con Retry-After, pero no el 429 de tope de gasto', async () => {
    let n = 0;
    const flaky = fakeFetch(() => (++n === 1 ? json({ error: { type: 'overloaded_error' } }, 529) : json(okBody)));
    await new AnthropicProvider({ apiKey: FAKE_KEYS.anthropic, fetch: flaky, sleep: noSleep }).complete(req);
    expect(flaky.calls).toHaveLength(2);
    const cap = fakeFetch(() => json({ error: { type: 'rate_limit_error' } }, 429));
    await expect(new AnthropicProvider({ apiKey: FAKE_KEYS.anthropic, fetch: cap, sleep: noSleep }).complete(req)).rejects.toMatchObject({ kind: 'quota' });
    expect(cap.calls).toHaveLength(1);
  });

  it('exige una clave', () => {
    expect(() => new AnthropicProvider({ apiKey: '' })).toThrow(/RADAR_ANTHROPIC_API_KEY/);
  });
});
