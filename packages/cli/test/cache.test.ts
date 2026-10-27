import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatBytes, parseCacheArgs, runCache } from '../src/cache.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('npm run cache', () => {
  it('interpreta las opciones', () => {
    expect(parseCacheArgs([])).toEqual({ kind: 'show' });
    expect(parseCacheArgs(['--limpiar'])).toEqual({ kind: 'prune', days: 90 });
    expect(parseCacheArgs(['--limpiar', '30'])).toEqual({ kind: 'prune', days: 30 });
    expect(parseCacheArgs(['--vaciar'])).toEqual({ kind: 'clear' });
    expect(parseCacheArgs(['--limpiar', '0']).kind).toBe('error');
    expect(parseCacheArgs(['--limpiar', '--vaciar']).kind).toBe('error');
    expect(parseCacheArgs(['otra']).kind).toBe('error');
  });

  it('muestra el uso y vacía la caché', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'radar-cli-cache-'));
    dirs.push(base);
    await mkdir(path.join(base, 'ai'));
    await writeFile(path.join(base, 'ai', `${'a'.repeat(40)}.json`), 'x'.repeat(2048));
    expect(await runCache({ kind: 'show' }, base)).toMatch(/: 2,0 KB en 1 archivo\(s\)\.\n {2}Análisis por archivo/);
    expect(await runCache({ kind: 'clear' }, base)).toBe('Caché vaciada: 1 archivo(s), 2,0 KB liberados.');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3,0 MB');
  });
});
