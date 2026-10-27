import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { RedirectError, requestText } from '../src/http.js';

/** Servidores locales de verdad: el comportamiento de las redirecciones es el de fetch, sin simular. */
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

interface Seen {
  path: string;
  authorization: string | null;
  apiKey: string | null;
}

async function server(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ origin: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const s = http.createServer((req, res) => {
    seen.push({ path: req.url ?? '', authorization: req.headers.authorization ?? null, apiKey: (req.headers['x-api-key'] as string | undefined) ?? null });
    handler(req, res);
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, seen };
}

const ok = (_req: http.IncomingMessage, res: http.ServerResponse): void => {
  res.end('{"ok":true}');
};
const redirectTo = (location: string) => (_req: http.IncomingMessage, res: http.ServerResponse): void => {
  res.writeHead(302, { location });
  res.end();
};

describe('redirecciones', () => {
  it('sin credenciales, sigue redirecciones a otro servidor', async () => {
    const other = await server(ok);
    const first = await server(redirectTo(`${other.origin}/destino`));
    const r = await requestText(`${first.origin}/`, {}, { retries: 0 });
    expect(r.text).toBe('{"ok":true}');
    expect(other.seen.map((s) => s.path)).toEqual(['/destino']);
  });

  it('con una clave en cabecera propia, no la envía a otro servidor', async () => {
    const other = await server(ok);
    const first = await server(redirectTo(`${other.origin}/robar`));
    const request = requestText(`${first.origin}/v1/messages`, { headers: { 'x-api-key': 'sk-ant-secreta' } }, { retries: 2, sleep: async () => {} });
    await expect(request).rejects.toThrow(RedirectError);
    await expect(request).rejects.toThrow(/otro servidor rechazada/);
    // Ni se llega a contactar con el otro servidor ni se reintenta.
    expect(other.seen).toEqual([]);
    expect(first.seen).toHaveLength(1);
  });

  it('con Authorization tampoco sale del origen', async () => {
    const other = await server(ok);
    const first = await server(redirectTo(`${other.origin}/`));
    await expect(requestText(`${first.origin}/`, { headers: { authorization: 'Bearer token' } }, { retries: 0 })).rejects.toThrow(RedirectError);
    expect(other.seen).toEqual([]);
  });

  it('con credenciales, sigue las del mismo origen conservando la cabecera', async () => {
    let n = 0;
    const s = await server((req, res) => {
      if (req.url === '/antiguo' && n++ === 0) return redirectTo('/nuevo')(req, res);
      ok(req, res);
    });
    const r = await requestText(`${s.origin}/antiguo`, { headers: { 'x-api-key': 'clave' } }, { retries: 0 });
    expect(r.text).toBe('{"ok":true}');
    expect(s.seen).toEqual([
      { path: '/antiguo', authorization: null, apiKey: 'clave' },
      { path: '/nuevo', authorization: null, apiKey: 'clave' },
    ]);
  });

  it('corta los bucles de redirecciones', async () => {
    const s = await server(redirectTo('/otra-vez'));
    await expect(requestText(`${s.origin}/`, { headers: { authorization: 'Bearer t' } }, { retries: 0 })).rejects.toThrow(/Demasiadas redirecciones/);
  });
});
