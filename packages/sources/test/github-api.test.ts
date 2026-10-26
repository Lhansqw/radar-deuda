import { describe, expect, it } from 'vitest';
import { GitHubClient, tokenFromEnv } from '../src/github/api.js';
import { cloneUrl, parseGitHubRepo } from '../src/github/url.js';
import { HttpError, requestJson, requestText } from '../src/http.js';
import { fakeFetch, json, noSleep } from './helpers/fake-fetch.js';

describe('parseGitHubRepo', () => {
  it.each([
    ['Lhansqw/radar-deuda', 'Lhansqw', 'radar-deuda'],
    ['github:Lhansqw/radar-deuda', 'Lhansqw', 'radar-deuda'],
    ['https://github.com/Lhansqw/radar-deuda', 'Lhansqw', 'radar-deuda'],
    ['https://github.com/Lhansqw/radar-deuda.git', 'Lhansqw', 'radar-deuda'],
    ['https://github.com/Lhansqw/radar-deuda/tree/main/docs', 'Lhansqw', 'radar-deuda'],
    ['git@github.com:Lhansqw/radar-deuda.git', 'Lhansqw', 'radar-deuda'],
    ['  owner/repo.js  ', 'owner', 'repo.js'],
  ])('%s', (input, owner, repo) => {
    expect(parseGitHubRepo(input)).toEqual({ owner, repo });
  });

  it.each([
    'https://gitlab.com/a/b',
    'https://token@github.com/a/b', // credenciales en la URL
    'https://evil.com/github.com/a/b',
    '-oProxyCommand=x/y',
    'a/..',
    'a b/c',
    'C:\\repos\\x',
    './local/repo',
    'solo-un-nombre',
    `${'a'.repeat(40)}/repo`,
  ])('rechaza %s', (input) => {
    expect(parseGitHubRepo(input)).toBeNull();
  });

  it('construye la URL de clonado https', () => {
    expect(cloneUrl({ owner: 'a', repo: 'b' })).toBe('https://github.com/a/b.git');
  });
});

describe('requestText', () => {
  it('reintenta errores transitorios respetando Retry-After', async () => {
    let n = 0;
    const waits: number[] = [];
    const fetch = fakeFetch(() => (++n < 3 ? new Response('ocupado', { status: n === 1 ? 503 : 429, headers: { 'retry-after': '2' } }) : new Response('ok')));
    const res = await requestText('https://api.example.com/x', {}, { fetch, sleep: async (ms) => void waits.push(ms) });
    expect(res.text).toBe('ok');
    expect(fetch.calls).toHaveLength(3);
    expect(waits).toEqual([2000, 2000]);
  });

  it('permite decidir qué es transitorio (p. ej. 429 sin Retry-After no se reintenta)', async () => {
    const fetch = fakeFetch(() => new Response('tope de gasto', { status: 429 }));
    const retryable = (status: number, headers: Headers) => status === 429 && headers.has('retry-after');
    await expect(requestText('https://api.example.com/x', {}, { fetch, sleep: noSleep, retryable })).rejects.toBeInstanceOf(HttpError);
    expect(fetch.calls).toHaveLength(1);
  });

  it('no reintenta errores del cliente', async () => {
    const fetch = fakeFetch(() => new Response('no', { status: 404 }));
    await expect(requestText('https://api.example.com/x', {}, { fetch, sleep: noSleep })).rejects.toBeInstanceOf(HttpError);
    expect(fetch.calls).toHaveLength(1);
  });

  it('corta respuestas que superan el límite de tamaño', async () => {
    const fetch = fakeFetch(() => new Response('x'.repeat(5000)));
    await expect(requestText('https://api.example.com/x', {}, { fetch, maxBytes: 1000 })).rejects.toThrow(/demasiado grande/);
  });

  it('informa de errores de red tras agotar los reintentos', async () => {
    const fetch = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expect(requestText('https://api.example.com/x', {}, { fetch, retries: 2, sleep: noSleep })).rejects.toThrow(/No se pudo contactar con api.example.com/);
    expect(fetch.calls).toHaveLength(3);
  });

  it('requestJson rechaza respuestas que no son JSON', async () => {
    const fetch = fakeFetch(() => new Response('<html>'));
    await expect(requestJson('https://api.example.com/x', {}, { fetch })).rejects.toThrow(/no es JSON/);
  });
});

describe('GitHubClient', () => {
  const repoBody = { full_name: 'a/b', private: true, default_branch: 'main', size: 2048, archived: false, pushed_at: '2026-10-01T00:00:00Z', language: 'TypeScript' };

  it('obtiene los metadatos con las cabeceras recomendadas y el token como Bearer', async () => {
    const fetch = fakeFetch(() => json(repoBody));
    const gh = new GitHubClient({ token: 'github_pat_abc', fetch });
    expect(await gh.getRepository({ owner: 'a', repo: 'b' })).toEqual({
      fullName: 'a/b',
      private: true,
      defaultBranch: 'main',
      sizeKb: 2048,
      archived: false,
      pushedAt: '2026-10-01T00:00:00Z',
      language: 'TypeScript',
    });
    const headers = fetch.calls[0]?.init?.headers as Record<string, string>;
    expect(fetch.calls[0]?.url).toBe('https://api.github.com/repos/a/b');
    expect(headers['Authorization']).toBe('Bearer github_pat_abc');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
  });

  it('explica 404, 401 y el límite de peticiones sin mostrar el token', async () => {
    const token = 'github_pat_SECRETO';
    const cases: Array<[Response, RegExp]> = [
      [json({}, 404), /no existe o el token no tiene acceso/],
      [json({}, 401), /no es válido/],
      [json({}, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' }), /límite de peticiones/],
    ];
    for (const [response, message] of cases) {
      const gh = new GitHubClient({ token, fetch: fakeFetch(() => response.clone()), retries: 0 });
      const err = await gh.getRepository({ owner: 'a', repo: 'b' }).then(
        () => new Error('se esperaba un error'),
        (e: unknown) => e as Error,
      );
      expect(err.message).toMatch(message);
      expect(err.message).not.toContain(token);
    }
  });

  it('sin token sugiere configurarlo para repositorios privados', async () => {
    const gh = new GitHubClient({ fetch: fakeFetch(() => json({}, 404)) });
    await expect(gh.getRepository({ owner: 'a', repo: 'b' })).rejects.toThrow(/RADAR_GITHUB_TOKEN/);
  });

  it('avisa si el token tiene permisos excesivos', async () => {
    const classic = new GitHubClient({ token: 'ghp_x', fetch: fakeFetch(() => json({ login: 'nik' }, 200, { 'x-oauth-scopes': 'repo, delete_repo' })) });
    const c = await classic.checkToken();
    expect(c).toMatchObject({ kind: 'classic', login: 'nik' });
    expect(c.warnings[0]).toMatch(/repo, delete_repo/);

    const fine = new GitHubClient({ token: 'github_pat_x', fetch: fakeFetch(() => json({ login: 'nik' })) });
    expect(await fine.checkToken()).toEqual({ kind: 'fine-grained', login: 'nik', warnings: [] });
  });

  it('solo usa RADAR_GITHUB_TOKEN, nunca tokens de otras herramientas', () => {
    expect(tokenFromEnv({ GITHUB_TOKEN: 'b', RADAR_GITHUB_TOKEN: ' a ' })).toBe('a');
    expect(tokenFromEnv({ GH_TOKEN: 'c', GITHUB_TOKEN: 'd' })).toBeUndefined();
    expect(tokenFromEnv({ RADAR_GITHUB_TOKEN: '' })).toBeUndefined();
  });
});
