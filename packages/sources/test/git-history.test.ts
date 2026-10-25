import { afterEach, describe, expect, it } from 'vitest';
import { analyzeRepository } from '@radar/engine';
import { changedFiles, fileChurn, resolveCommit, unquoteGitPath } from '../src/git/history.js';
import { computeHotspots } from '../src/git/hotspots.js';
import { createGitRepo, type TestRepo } from './helpers/git-repo.js';

let repo: TestRepo | undefined;
afterEach(async () => {
  await repo?.cleanup();
  repo = undefined;
});

const SINCE = '2020-01-01';
const DAY = 86_400;
const T0 = 1_700_000_000;

/** Función con complejidad cognitiva alta (genera un hallazgo de complejidad). */
const complex = (n: number) => `
export function f${n}(a: number[], b: boolean, c: boolean) {
  for (const x of a) { if (b) { if (c) { if (x > ${n}) { while (x) { if (x % 2) { break; } } } } } }
  return ${n};
}`;

describe('resolveCommit', () => {
  it('rechaza referencias que parecen opciones (inyección de argumentos)', async () => {
    repo = await createGitRepo();
    await repo.commit({ 'a.txt': '1' }, 'c1');
    await expect(resolveCommit(repo.root, '--output=/tmp/x')).rejects.toThrow(/no válida/);
    await expect(resolveCommit(repo.root, 'HEAD; rm -rf /')).rejects.toThrow(/no válida/);
    await expect(resolveCommit(repo.root, 'no-existe')).rejects.toThrow(/no existe/);
    expect(await resolveCommit(repo.root, 'HEAD')).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('changedFiles', () => {
  it('lista altas, modificaciones y bajas entre dos commits', async () => {
    repo = await createGitRepo();
    const c1 = await repo.commit({ 'a.ts': '1', 'b.ts': '1', 'c.ts': '1' }, 'c1');
    await repo.commit({ 'a.ts': '2', 'c.ts': null, 'd/e.ts': 'nuevo', 'ñandú con espacio.ts': 'x' }, 'c2');
    expect(await changedFiles(repo.root, c1)).toEqual([
      { status: 'modified', path: 'a.ts' },
      { status: 'deleted', path: 'c.ts' },
      { status: 'added', path: 'd/e.ts' },
      { status: 'added', path: 'ñandú con espacio.ts' },
    ]);
  });
});

describe('fileChurn', () => {
  it('cuenta commits, líneas y autores por archivo', async () => {
    repo = await createGitRepo();
    await repo.commit({ 'a.ts': 'l1\nl2\n', 'b.ts': 'x\n' }, 'c1', { date: T0, author: 'ana@x.co' });
    await repo.commit({ 'a.ts': 'l1\nl2\nl3\n' }, 'c2', { date: T0 + DAY, author: 'luis@x.co' });
    await repo.commit({ 'a.ts': 'l1\n' }, 'c3', { date: T0 + 2 * DAY, author: 'ANA@x.co' });
    const churn = await fileChurn(repo.root, { since: SINCE });
    expect(churn.get('a.ts')).toEqual({ file: 'a.ts', commits: 3, added: 3, deleted: 2, authors: 2, lastChange: T0 + 2 * DAY });
    expect(churn.get('b.ts')?.commits).toBe(1);
  });

  it('respeta la fecha de inicio, el límite de commits y la subcarpeta', async () => {
    repo = await createGitRepo();
    await repo.commit({ 'app/a.ts': '1', 'otro/b.ts': '1' }, 'viejo', { date: T0 });
    await repo.commit({ 'app/a.ts': '2', 'otro/b.ts': '2' }, 'nuevo', { date: T0 + 30 * DAY });
    const recent = await fileChurn(repo.root, { since: new Date((T0 + DAY) * 1000).toISOString() });
    expect(recent.get('app/a.ts')?.commits).toBe(1);
    expect((await fileChurn(repo.root, { since: SINCE, maxCommits: 1 })).get('app/a.ts')?.commits).toBe(1);
    const sub = await fileChurn(repo.root, { since: SINCE, pathPrefix: 'app' });
    expect([...sub.keys()]).toEqual(['app/a.ts']);
  });

  it('no guarda correos de los autores', async () => {
    repo = await createGitRepo();
    await repo.commit({ 'a.ts': '1' }, 'c1', { author: 'privado@empresa.co' });
    expect(JSON.stringify([...(await fileChurn(repo.root, { since: SINCE })).values()])).not.toContain('privado');
  });

  it('un repositorio sin commits no tiene historial', async () => {
    repo = await createGitRepo();
    expect((await fileChurn(repo.root, { since: SINCE })).size).toBe(0);
  });
});

describe('unquoteGitPath', () => {
  it('decodifica rutas entrecomilladas por Git', () => {
    expect(unquoteGitPath('"con\\ttab.ts"')).toBe('con\ttab.ts');
    expect(unquoteGitPath('"\\303\\261.ts"')).toBe('ñ.ts');
    expect(unquoteGitPath('normal.ts')).toBe('normal.ts');
  });
});

describe('computeHotspots', () => {
  it('prioriza archivos que cambian a menudo y además tienen deuda', async () => {
    repo = await createGitRepo();
    // caliente.ts: complejo y cambia 5 veces · frio.ts: complejo, 1 cambio · limpio.ts: cambia mucho, sin deuda
    await repo.commit({ 'src/caliente.ts': complex(0), 'src/frio.ts': complex(100), 'src/limpio.ts': 'export const v = 0;' }, 'c0', { date: T0 });
    for (let i = 1; i <= 4; i++) {
      await repo.commit({ 'src/caliente.ts': complex(i), 'src/limpio.ts': `export const v = ${i};` }, `c${i}`, { date: T0 + i * DAY });
    }
    const report = await analyzeRepository(repo.root, { cacheDir: null });
    const hotspots = computeHotspots(report, await fileChurn(repo.root, { since: SINCE }));
    expect(hotspots.map((h) => h.file)).toEqual(['src/caliente.ts']);
    expect(hotspots[0]).toMatchObject({ commits: 5, authors: 1, score: 100 });
    expect(hotspots[0]?.findingIds.length).toBeGreaterThan(0);
  });

  it('convierte las rutas cuando se analiza una subcarpeta del repositorio', async () => {
    repo = await createGitRepo();
    await repo.commit({ 'app/src/x.ts': complex(1) }, 'c1', { date: T0 });
    await repo.commit({ 'app/src/x.ts': complex(2) }, 'c2', { date: T0 + DAY });
    const report = await analyzeRepository(`${repo.root}/app`, { cacheDir: null });
    const hotspots = computeHotspots(report, await fileChurn(repo.root, { since: SINCE, pathPrefix: 'app' }), { prefix: 'app' });
    expect(hotspots.map((h) => h.file)).toEqual(['src/x.ts']);
  });
});
