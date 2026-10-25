import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisReport } from '@radar/engine';
import { runGit } from '@radar/sources';
import { parseCli, run, type CliOptions } from '../src/app.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'radar-app-'));
  dirs.push(d);
  return d;
}
const io = { info: () => undefined, warn: () => undefined };
const opts = (target: string, extra: Partial<CliOptions> = {}): CliOptions => ({ target, noCache: true, online: false, history: true, quiet: true, top: 15, ...extra });

const complex = (n: number) => `export function f(a: number[], b: boolean, c: boolean) {
  for (const x of a) { if (b) { if (c) { if (x > ${n}) { while (x) { if (x % 2) { break; } } } } } }
}`;

async function gitRepo(): Promise<string> {
  const root = await tmp();
  const git = (...a: string[]) => runGit(['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@x.co', ...a], { cwd: root });
  await git('init', '-q', '-b', 'main');
  for (let i = 0; i < 3; i++) {
    await writeFile(path.join(root, 'caliente.ts'), complex(i));
    await git('add', '-A');
    await git('commit', '-q', '-m', `c${i}`);
  }
  return root;
}

describe('parseCli', () => {
  it('valida opciones y combinaciones', () => {
    expect(parseCli(['a', '--fail-on', 'grave'])).toMatchObject({ kind: 'error', message: expect.stringMatching(/no válida/) });
    expect(parseCli(['a', '--fail-on-new', 'high'])).toMatchObject({ kind: 'error', message: expect.stringMatching(/requiere --baseline/) });
    expect(parseCli(['a', '--since', 'ayer'])).toMatchObject({ kind: 'error' });
    expect(parseCli([])).toMatchObject({ kind: 'error' });
    expect(parseCli(['-h'])).toEqual({ kind: 'help' });
    expect(parseCli(['a', '--online', '--no-history', '--top', '5'])).toMatchObject({ kind: 'run', options: { target: 'a', online: true, history: false, top: 5 } });
  });
});

describe('run', () => {
  it('añade el commit y los puntos críticos en un repositorio Git', async () => {
    const root = await gitRepo();
    const json = path.join(await tmp(), 'r.json');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await run(opts(root, { json, since: '2000-01-01' }), io, new AbortController().signal)).toBe(0);
    const report = JSON.parse(await readFile(json, 'utf8')) as AnalysisReport;
    expect(report.vcs).toMatchObject({ branch: 'main', shallow: false });
    expect(report.hotspots?.map((h) => [h.file, h.commits])).toEqual([['caliente.ts', 3]]);
  });

  it('con --baseline y --fail-on-new falla solo si hay deuda nueva', async () => {
    const root = await gitRepo();
    const base = path.join(await tmp(), 'base.json');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run(opts(root, { json: base }), io, new AbortController().signal);
    expect(await run(opts(root, { baseline: base, failOnNew: 'low' }), io, new AbortController().signal)).toBe(0);
    await writeFile(path.join(root, 'nuevo.ts'), complex(9).replace('function f', 'function g'));
    expect(await run(opts(root, { baseline: base, failOnNew: 'low' }), io, new AbortController().signal)).toBe(1);
  });

  it('--online consulta OSV y npm y lo refleja en el informe', async () => {
    const root = await tmp();
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { lodash: '^4.17.0' } }));
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { lodash: '^4.17.0' } }, 'node_modules/lodash': { version: '4.17.20' } } }));
    const hosts = new Set<string>();
    vi.stubGlobal('fetch', async (url: string) => {
      hosts.add(new URL(url).host);
      if (url.endsWith('/v1/querybatch')) return Response.json({ results: [{ vulns: [{ id: 'GHSA-35jh-r3h4-6jhm', modified: 'm' }] }] });
      if (url.includes('/v1/vulns/')) {
        return Response.json({
          id: 'GHSA-35jh-r3h4-6jhm',
          modified: 'm',
          summary: 'Command Injection in lodash',
          database_specific: { severity: 'HIGH' },
          affected: [{ package: { ecosystem: 'npm', name: 'lodash' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }],
        });
      }
      return Response.json({ 'dist-tags': { latest: '4.17.21' }, versions: {} });
    });
    const json = path.join(await tmp(), 'r.json');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await run(opts(root, { online: true, json, failOn: 'high' }), io, new AbortController().signal)).toBe(1);
    const report = JSON.parse(await readFile(json, 'utf8')) as AnalysisReport;
    expect(report.findings.find((f) => f.ruleId === 'dependencies/vulnerable')?.title).toBe('Vulnerabilidad conocida en lodash@4.17.20');
    expect([...hosts].sort()).toEqual(['api.osv.dev', 'registry.npmjs.org']);
    expect(report.coverage.find((c) => c.area === 'Dependencias')?.status).toBe('analyzed');
  });

  it('rechaza objetivos que no son carpeta ni repositorio de GitHub', async () => {
    await expect(run(opts('no/existe/aqui'), io, new AbortController().signal)).rejects.toThrow(/ni es una referencia válida/);
  });
});
