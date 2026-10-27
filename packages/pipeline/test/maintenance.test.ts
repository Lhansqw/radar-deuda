import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cacheUsage, clearCache, folderSize, pruneCache } from '../src/maintenance.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const hex = (n: number, c = 'a'): string => c.repeat(n);

async function cache(): Promise<string> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'radar-cache-'));
  dirs.push(base);
  const files: Record<string, string> = {
    [`${hex(20)}.json`]: 'motor',
    [`${hex(20, 'b')}.json.123.tmp`]: 'resto',
    [`git/${hex(20)}.json`]: 'git',
    [`ai/${hex(40)}.json`]: 'respuesta de la IA',
    [`ai/${hex(40, 'c')}.json`]: 'otra',
    'osv/GHSA-aaaa-bbbb-cccc.json': 'osv',
    'npm/@scope__pkg.json': 'npm',
    // Ajenos: nunca se cuentan ni se borran.
    'notas.txt': 'mías',
    'config.json': '{}',
    'ai/leeme.txt': 'x',
    [`repos/owner__repo/${hex(20)}.json`]: 'código clonado',
  };
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(base, rel)), { recursive: true });
    await writeFile(path.join(base, rel), text);
  }
  return base;
}

describe('mantenimiento de la caché', () => {
  it('cuenta solo los archivos de la herramienta, por partes', async () => {
    const base = await cache();
    const u = await cacheUsage(base);
    expect(u.files).toBe(7);
    expect(u.parts.map((p) => [p.name, p.files])).toEqual([
      ['motor', 2],
      ['ia', 2],
      ['historial', 1],
      ['dependencias', 2],
    ]);
    expect(u.bytes).toBe('motor'.length + 'resto'.length + 'git'.length + 'respuesta de la IA'.length + 'otra'.length + 'osv'.length + 'npm'.length);
    expect(await cacheUsage(path.join(base, 'no-existe'))).toEqual({ parts: expect.any(Array), files: 0, bytes: 0 });
  });

  it('borra lo antiguo y los temporales, y vaciar no toca archivos ajenos ni clones', async () => {
    const base = await cache();
    const old = new Date(Date.now() - 100 * 24 * 3600 * 1000);
    await utimes(path.join(base, 'ai', `${hex(40)}.json`), old, old);
    await utimes(path.join(base, `${hex(20, 'b')}.json.123.tmp`), new Date(Date.now() - 2 * 24 * 3600 * 1000), new Date(Date.now() - 2 * 24 * 3600 * 1000));
    const pruned = await pruneCache(base, 90);
    expect(pruned).toEqual({ files: 2, bytes: 'respuesta de la IA'.length + 'resto'.length });
    expect((await cacheUsage(base)).files).toBe(5);

    expect((await clearCache(base)).files).toBe(5);
    expect((await cacheUsage(base)).files).toBe(0);
    expect((await readdir(base)).sort()).toEqual(['ai', 'config.json', 'git', 'notas.txt', 'npm', 'osv', 'repos']);
    expect(await readdir(path.join(base, 'ai'))).toEqual(['leeme.txt']);
    expect(await folderSize(path.join(base, 'repos'))).toEqual({ files: 1, bytes: Buffer.byteLength('código clonado') });
  });
});
