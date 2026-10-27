import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { forgetTypeScriptForTests, isTypeScriptLoaded } from '../src/analyzers/ts-runtime.js';
import { analyzeRepository } from '../src/engine.js';
import { createTmpRepo, type TmpRepo } from './helpers/tmp-repo.js';

const tmps: Array<TmpRepo | string> = [];
afterEach(async () => {
  for (const t of tmps.splice(0)) await (typeof t === 'string' ? rm(t, { recursive: true, force: true }) : t.cleanup());
});

const CODE = `export function f(a: number[], b: boolean) {\n  for (const x of a) { if (b) { if (x > 1) { while (x) { if (x % 2) { break; } } } } }\n}\n`;

describe('carga perezosa del compilador de TypeScript', () => {
  it('con la caché caliente no se carga; al cambiar un archivo, sí', async () => {
    const repo = await createTmpRepo({ 'a.ts': CODE, 'b.ts': CODE, 'c.ts': 'export const c = 1;' });
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'radar-ts-cache-'));
    tmps.push(repo, cacheDir);
    const cold = await analyzeRepository(repo.root, { cacheDir });
    expect(isTypeScriptLoaded()).toBe(true);

    forgetTypeScriptForTests();
    const warm = await analyzeRepository(repo.root, { cacheDir });
    expect(isTypeScriptLoaded()).toBe(false);
    expect(warm.findings.map((f) => f.id).sort()).toEqual(cold.findings.map((f) => f.id).sort());

    await writeFile(path.join(repo.root, 'c.ts'), 'export const c = 2;\n');
    await analyzeRepository(repo.root, { cacheDir });
    expect(isTypeScriptLoaded()).toBe(true);
  });
});
