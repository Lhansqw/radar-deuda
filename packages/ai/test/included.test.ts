import { describe, expect, it } from 'vitest';
import { IncludedAiProvider, INCLUDED_DEFAULT_MODEL } from '../src/providers/included.js';
import { fakeFetch, json, noSleep } from './helpers/fake-fetch.js';

const BASE = 'https://prueba.supabase.co/functions/v1/ia';
const TOKEN = 'eyJ.token-de-sesion.firma';
const ok = () => json({ model: 'qwen/qwen3-coder:free', choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, cost: 0 } });
const quota = (used: number, limit: number) => json({ data: { limit: null, limit_remaining: null, usage: 0, free_model_daily_requests: { used, limit, remaining: Math.max(0, limit - used) } } });
const plain = { model: INCLUDED_DEFAULT_MODEL, system: 's', messages: [{ role: 'user' as const, content: 'hola' }], maxOutputTokens: 300 };

describe('IncludedAiProvider', () => {
  it('habla con la función de Supabase usando el token de la sesión, sin clave de OpenRouter', async () => {
    const fetch = fakeFetch((url) => (url.endsWith('/models') ? json({ data: [] }) : ok()));
    const p = new IncludedAiProvider({ baseUrl: BASE, sessionToken: TOKEN, fetch });
    await p.complete(plain);
    const call = fetch.calls.find((c) => c.url.endsWith('/chat/completions'));
    expect(call?.url).toBe(`${BASE}/chat/completions`);
    expect((call?.init?.headers as Record<string, string>)['authorization']).toBe(`Bearer ${TOKEN}`);
    // Los modelos gratuitos necesitan proveedores que pueden guardar datos.
    expect(JSON.parse(String(call?.init?.body))).toMatchObject({ model: INCLUDED_DEFAULT_MODEL, provider: { data_collection: 'allow' } });
    expect(p.id).toBe('incluida');
    expect(p.label).toBe('IA incluida');
  });

  it('no repite lo que la función ya esperó (ocupada o sin cupo), sí los fallos de la red de Supabase', async () => {
    const calls = (status: number) => {
      const fetch = fakeFetch((url) => (url.endsWith('/models') ? json({ data: [] }) : json({ error: { message: 'x' } }, status)));
      return { fetch, count: () => fetch.calls.filter((c) => c.url.endsWith('/chat/completions')).length };
    };
    for (const [status, expected] of [[503, 1], [429, 1], [502, 3]] as const) {
      const c = calls(status);
      await expect(new IncludedAiProvider({ baseUrl: BASE, sessionToken: TOKEN, sleep: noSleep, fetch: c.fetch }).complete(plain)).rejects.toBeTruthy();
      expect(c.count(), `HTTP ${status}`).toBe(expected);
    }
  });

  it('sin sesión no se puede usar', () => {
    expect(() => new IncludedAiProvider({ baseUrl: BASE, sessionToken: '' })).toThrow('Inicia sesión para usar la IA incluida.');
  });

  it('el cupo diario: avisa si no alcanza y se detiene si se agotó', async () => {
    const plan = { models: [INCLUDED_DEFAULT_MODEL], requests: 5 };
    expect(await new IncludedAiProvider({ baseUrl: BASE, sessionToken: TOKEN, fetch: fakeFetch(() => quota(10, 30)) }).preflight(plan)).toEqual([]);
    expect(await new IncludedAiProvider({ baseUrl: BASE, sessionToken: TOKEN, fetch: fakeFetch(() => quota(27, 30)) }).preflight(plan)).toEqual([expect.stringMatching(/Te quedan 3 consultas/)]);
    await expect(new IncludedAiProvider({ baseUrl: BASE, sessionToken: TOKEN, fetch: fakeFetch(() => quota(30, 30)) }).preflight(plan)).rejects.toMatchObject({ kind: 'rate-limit', message: expect.stringMatching(/Usaste las 30 consultas/) });
    // Si la función no responde, no bloquea.
    expect(await new IncludedAiProvider({ baseUrl: BASE, sessionToken: TOKEN, retries: 0, sleep: noSleep, fetch: fakeFetch(() => json({}, 502)) }).preflight(plan)).toEqual([]);
  });

  it('explica la sesión caducada, los rechazos de la función y la función sin instalar', async () => {
    const make = (r: Response) => new IncludedAiProvider({ baseUrl: BASE, sessionToken: TOKEN, retries: 0, sleep: noSleep, fetch: fakeFetch((url) => (url.endsWith('/models') ? json({ data: [] }) : r.clone())) });
    await expect(make(json({ error: { message: 'jwt expired' } }, 401)).complete(plain)).rejects.toMatchObject({ kind: 'auth', message: expect.stringMatching(/sesión caducó/) });
    await expect(make(json({ error: { message: 'Usaste las 30 consultas de IA incluida de hoy.' } }, 429)).complete(plain)).rejects.toThrow('Usaste las 30 consultas de IA incluida de hoy.');
    await expect(make(json({ error: { message: 'La IA incluida solo usa modelos gratuitos.' } }, 400)).complete(plain)).rejects.toThrow('La IA incluida solo usa modelos gratuitos.');
    await expect(make(json({ code: 'NOT_FOUND', message: 'Requested function was not found' }, 404)).complete(plain)).rejects.toThrow(/falta la función «ia»/);
    await expect(make(json({ error: { message: 'x' } }, 401)).keyStatus()).rejects.toMatchObject({ kind: 'auth', message: expect.stringMatching(/sesión caducó/) });
  });
});
