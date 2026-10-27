import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authEnv, cloneInternal, cloneOrUpdate, defaultReposDir, removeClone } from '../src/github/clone.js';
import { runGit } from '../src/git/run.js';
import { createGitRepo, type TestRepo } from './helpers/git-repo.js';

const dirs: string[] = [];
let origin: TestRepo | undefined;
afterEach(async () => {
  await origin?.cleanup();
  origin = undefined;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'radar-clones-'));
  dirs.push(d);
  return d;
};

/** Las pruebas usan un "remoto" local: hay que permitir el protocolo file solo aquí. */
const LOCAL = ['protocol.file.allow=always'];
const ref = { owner: 'Prueba', repo: 'Demo' };

describe('defaultReposDir', () => {
  it('con RADAR_CACHE_DIR, los clones van en su subcarpeta repos', () => {
    const custom = path.resolve('cache-radar');
    expect(defaultReposDir({ RADAR_CACHE_DIR: custom })).toBe(path.join(custom, 'repos'));
    expect(defaultReposDir({ LOCALAPPDATA: path.resolve('local'), XDG_CACHE_HOME: path.resolve('xdg') })).toMatch(/radar-deuda[\\/]repos$/);
  });
});

describe('authEnv', () => {
  it('pasa el token como cabecera en variables de entorno, nunca como argumento', () => {
    const env = authEnv('github_pat_x');
    expect(env['GIT_CONFIG_KEY_0']).toBe('http.https://github.com/.extraheader');
    expect(Buffer.from((env['GIT_CONFIG_VALUE_0'] ?? '').split(' ').pop() ?? '', 'base64').toString()).toBe('x-access-token:github_pat_x');
    expect(authEnv(undefined)).toEqual({});
  });
});

describe('cloneOrUpdate', () => {
  it('por defecto rechaza protocolos distintos de https', async () => {
    origin = await createGitRepo();
    await origin.commit({ 'a.ts': '1' }, 'c1');
    await expect(cloneInternal(ref, { baseDir: await tmp(), url: origin.root })).rejects.toThrow();
  });

  it('clona superficialmente, sin hooks ni enlaces simbólicos, y no deja temporales', async () => {
    origin = await createGitRepo();
    await origin.commit({ 'a.ts': 'v1' }, 'c1');
    const head = await origin.commit({ 'a.ts': 'v2' }, 'c2');
    const base = await tmp();
    const r = await cloneInternal(ref, { baseDir: base, url: `file://${origin.root}`, extraConfig: LOCAL });
    expect(r).toMatchObject({ head, updated: false });
    expect(path.basename(r.dir)).toBe('prueba__demo');
    expect(await readFile(path.join(r.dir, 'a.ts'), 'utf8')).toBe('v2');
    expect((await runGit(['rev-list', '--count', 'HEAD'], { cwd: r.dir })).trim()).toBe('1'); // --depth 1
    expect(await readdir(base)).toEqual(['prueba__demo']);
    // Quitar el clon (al quitar el proyecto de la aplicación).
    expect(await removeClone(ref, base)).toBe(true);
    expect(await readdir(base)).toEqual([]);
    expect(await removeClone(ref, base)).toBe(false);
  });

  it('con shallowSince descarga solo el historial del periodo (y basta con el último si no hay ninguno)', async () => {
    origin = await createGitRepo();
    await origin.commit({ 'a.ts': 'v1' }, 'antiguo', { date: Date.parse('2020-01-01') / 1000 });
    await origin.commit({ 'a.ts': 'v2' }, 'reciente-1', { date: Date.parse('2026-03-01') / 1000 });
    await origin.commit({ 'a.ts': 'v3' }, 'reciente-2', { date: Date.parse('2026-04-01') / 1000 });
    const url = `file://${origin.root}`;
    const r = await cloneInternal(ref, { baseDir: await tmp(), url, extraConfig: LOCAL, shallowSince: '2026-01-01' });
    expect((await runGit(['rev-list', '--count', 'HEAD'], { cwd: r.dir })).trim()).toBe('2');
    const none = await cloneInternal(ref, { baseDir: await tmp(), url, extraConfig: LOCAL, shallowSince: '2030-01-01' });
    expect((await runGit(['rev-list', '--count', 'HEAD'], { cwd: none.dir })).trim()).toBe('1');
    await expect(cloneOrUpdate(ref, { baseDir: await tmp(), shallowSince: 'ayer' })).rejects.toThrow(/Fecha no válida/);
  });

  it('actualiza un clon existente y elimina archivos ajenos', async () => {
    origin = await createGitRepo();
    await origin.commit({ 'a.ts': 'v1' }, 'c1');
    const base = await tmp();
    const url = `file://${origin.root}`;
    const first = await cloneInternal(ref, { baseDir: base, url, extraConfig: LOCAL });
    await writeFile(path.join(first.dir, 'basura.tmp'), 'x');
    const head = await origin.commit({ 'a.ts': 'v2', 'b.ts': 'nuevo' }, 'c2');
    const second = await cloneInternal(ref, { baseDir: base, url, extraConfig: LOCAL });
    expect(second).toMatchObject({ dir: first.dir, head, updated: true });
    expect(await readFile(path.join(second.dir, 'a.ts'), 'utf8')).toBe('v2');
    expect(existsSync(path.join(second.dir, 'basura.tmp'))).toBe(false);
  });

  it('si el clon falla no deja carpetas a medias', async () => {
    const base = await tmp();
    await expect(cloneInternal(ref, { baseDir: base, url: 'file:///no/existe', extraConfig: LOCAL })).rejects.toThrow();
    expect(await readdir(base)).toEqual([]);
  });

  it('rechaza repositorios demasiado grandes y ramas no válidas antes de clonar', async () => {
    const base = await tmp();
    await expect(cloneOrUpdate(ref, { baseDir: base, sizeKb: 3_000_000, maxSizeKb: 1_000_000 })).rejects.toThrow(/supera el límite/);
    await expect(cloneOrUpdate(ref, { baseDir: base, branch: '--upload-pack=evil' })).rejects.toThrow(/no válido/);
  });

  it.runIf(process.env['RADAR_LIVE'] === '1')('en vivo: clona un repositorio público pequeño de GitHub', async () => {
    const r = await cloneOrUpdate({ owner: 'jonschlinkert', repo: 'is-number' }, { baseDir: await tmp() });
    expect(r.head).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(path.join(r.dir, 'package.json'))).toBe(true);
  });
});
