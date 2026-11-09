import { describe, expect, it } from 'vitest';
import { checkForUpdate, isNewer, parseVersion } from '../src/main/updates.js';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const page = (tag: string): string => `https://github.com/Lhansqw/radar-deuda/releases/tag/${tag}`;

describe('versiones', () => {
  it('lee versiones estables con o sin «v» y rechaza las demás', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('0.10.0')).toEqual([0, 10, 0]);
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion('1.2.3-beta.1')).toBeNull();
  });

  it('compara número a número, no como texto', () => {
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('0.1.0', '0.2.0')).toBe(false);
    expect(isNewer('basura', '0.1.0')).toBe(false);
  });
});

describe('checkForUpdate', () => {
  it('avisa de una versión más reciente y enlaza a su página', async () => {
    let asked = '';
    const fetch = async (url: string): Promise<Response> => {
      asked = url;
      return json({ tag_name: 'v0.2.0', html_url: page('v0.2.0'), draft: false, prerelease: false });
    };
    expect(await checkForUpdate('0.1.0', fetch)).toEqual({ current: '0.1.0', latest: '0.2.0', url: page('v0.2.0'), newer: true });
    expect(asked).toBe('https://api.github.com/repos/Lhansqw/radar-deuda/releases/latest');
  });

  it('con la misma versión no avisa', async () => {
    const r = await checkForUpdate('0.2.0', async () => json({ tag_name: 'v0.2.0', html_url: page('v0.2.0') }));
    expect(r).toMatchObject({ latest: '0.2.0', newer: false });
  });

  it('sin versiones publicadas (404) no es un error', async () => {
    expect(await checkForUpdate('0.1.0', async () => json({ message: 'Not Found' }, 404))).toEqual({ current: '0.1.0', latest: null, url: null, newer: false });
  });

  it('ignora enlaces a otros sitios, borradores y versiones de prueba', async () => {
    const none = { current: '0.1.0', latest: null, url: null, newer: false };
    expect(await checkForUpdate('0.1.0', async () => json({ tag_name: 'v9.0.0', html_url: 'https://malo.example/descarga' }))).toEqual(none);
    expect(await checkForUpdate('0.1.0', async () => json({ tag_name: 'v9.0.0', html_url: 'https://github.com/otro/repo/releases/tag/v9.0.0' }))).toEqual(none);
    expect(await checkForUpdate('0.1.0', async () => json({ tag_name: 'v9.0.0', html_url: page('v9.0.0'), prerelease: true }))).toEqual(none);
    expect(await checkForUpdate('0.1.0', async () => json({ tag_name: 'v9.0.0-rc.1', html_url: page('v9.0.0-rc.1') }))).toEqual(none);
  });

  it('un fallo del servidor llega como error (la interfaz decide si mostrarlo)', async () => {
    await expect(checkForUpdate('0.1.0', async () => json({}, 403))).rejects.toThrow(/403/);
  });
});
