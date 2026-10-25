import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeRepository } from '@radar/engine';
import { majorsBehind, NpmRegistryClient, outdatedAnalyzer } from '../src/deps/outdated.js';
import { fakeFetch, json } from './helpers/fake-fetch.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'radar-npm-'));
  dirs.push(d);
  return d;
}

const REGISTRY: Record<string, unknown> = {
  express: { 'dist-tags': { latest: '5.1.0' }, versions: { '4.17.1': {}, '5.1.0': {} } },
  request: { 'dist-tags': { latest: '2.88.2' }, versions: { '2.88.2': { deprecated: 'request has been deprecated' } } },
  vitest: { 'dist-tags': { latest: '5.0.5' }, versions: { '5.0.5': {} } },
  '@types/node': { 'dist-tags': { latest: '24.0.0' }, versions: { '20.0.0': {}, '24.0.0': {} } },
};
const registry = () =>
  fakeFetch((url) => {
    const name = decodeURIComponent(url.replace('https://registry.npmjs.org/', ''));
    return name in REGISTRY ? json(REGISTRY[name]) : json({ error: 'Not found' }, 404);
  });

describe('majorsBehind', () => {
  it.each([
    ['4.17.1', '5.1.0', 1],
    ['1.0.0', '4.2.0', 3],
    ['5.0.0', '5.9.0', 0],
    ['0.3.1', '0.5.0', 2], // en 0.x cada menor es incompatible
    ['2.0.0', '1.0.0', 0],
  ])('%s → %s = %d', (installed, latest, n) => {
    expect(majorsBehind(installed, latest)).toBe(n);
  });
});

describe('NpmRegistryClient', () => {
  it('pide metadatos abreviados, codifica scopes y valida nombres', async () => {
    const fetch = registry();
    const client = new NpmRegistryClient({ fetch });
    expect((await client.summary('@types/node')).latest).toBe('24.0.0');
    expect(fetch.calls[0]?.url).toBe('https://registry.npmjs.org/@types%2fnode');
    expect(String((fetch.calls[0]?.init?.headers as Record<string, string>)['accept'])).toMatch(/vnd\.npm\.install-v1\+json/);
    await expect(client.summary('../../etc/passwd')).rejects.toThrow(/no válido/);
  });

  it('guarda solo lo necesario en caché y respeta la caducidad', async () => {
    const cacheDir = await tmp();
    const a = new NpmRegistryClient({ fetch: registry(), cacheDir });
    expect(await a.summary('request')).toMatchObject({ latest: '2.88.2', deprecated: { '2.88.2': 'request has been deprecated' } });
    const b = new NpmRegistryClient({ fetch: registry(), cacheDir });
    await b.summary('request');
    expect(b.requests).toBe(0);
    const expired = new NpmRegistryClient({ fetch: registry(), cacheDir, ttlMs: 0 });
    await expired.summary('request');
    expect(expired.requests).toBe(1);
  });
});

describe('outdatedAnalyzer', () => {
  it('reporta directas desactualizadas y en desuso, no las transitivas', async () => {
    const root = await tmp();
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { express: '^4.17.1', request: '^2.88.2' }, devDependencies: { vitest: '^5.0.5' } }));
    await writeFile(
      path.join(root, 'package-lock.json'),
      JSON.stringify(
        {
          lockfileVersion: 3,
          packages: {
            '': { dependencies: { express: '^4.17.1', request: '^2.88.2' }, devDependencies: { vitest: '^5.0.5' } },
            'node_modules/express': { version: '4.17.1' },
            'node_modules/request': { version: '2.88.2' },
            'node_modules/vitest': { version: '5.0.5', dev: true },
            'node_modules/@types/node': { version: '20.0.0', dev: true },
          },
        },
        null,
        2,
      ),
    );
    const report = await analyzeRepository(root, { cacheDir: null, projectAnalyzers: [outdatedAnalyzer(new NpmRegistryClient({ fetch: registry() }))] });
    const found = report.findings.filter((f) => f.ruleId.startsWith('dependencies/')).map((f) => [f.ruleId, f.locations[0]?.symbol, f.severity]);
    expect(found).toEqual(
      expect.arrayContaining([
        ['dependencies/deprecated', 'request@2.88.2', 'medium'],
        ['dependencies/outdated', 'express@4.17.1', 'low'],
      ]),
    );
    expect(found.some(([, s]) => s === '@types/node@20.0.0')).toBe(false); // transitiva: no se reporta
    expect(report.coverage.find((c) => c.area === 'Versiones de dependencias')).toMatchObject({ status: 'analyzed' });
  });

  it.runIf(process.env['RADAR_LIVE'] === '1')('en vivo: el registro de npm responde con la última versión de semver', async () => {
    const info = await new NpmRegistryClient().summary('semver');
    expect(info.latest).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
