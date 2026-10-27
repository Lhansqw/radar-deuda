import { symlink } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { classify, discoverFiles, isTestPath, looksBinary, looksMinified, resolveRoot } from '../src/discovery.js';
import { createTmpRepo, type TmpRepo } from './helpers/tmp-repo.js';

let repo: TmpRepo | undefined;
afterEach(async () => {
  await repo?.cleanup();
  repo = undefined;
});

describe('classify', () => {
  it.each([
    ['src/a.ts', 'typescript', true, true],
    ['src/a.tsx', 'typescript', true, true],
    ['src/a.mjs', 'javascript', true, true],
    ['main.py', 'other', true, true],
    ['config.yml', 'other', false, true],
    ['.env.production', 'other', false, true],
    ['Dockerfile', 'other', false, true],
    ['package-lock.json', 'other', false, false],
    ['logo.png', 'other', false, false],
  ] as const)('%s → %s, código=%s, incluido=%s', (rel, language, isCode, include) => {
    expect(classify(rel)).toEqual({ language, isCode, include });
  });
});

describe('isTestPath', () => {
  it.each(['src/a.test.ts', 'src/a.spec.js', '__tests__/x.ts', 'test/x.ts', 'pkg/tests/x.py', 'x_test.go', 'test_x.py'])('%s es prueba', (p) => {
    expect(isTestPath(p)).toBe(true);
  });
  it.each(['src/testing.ts', 'src/contest.ts', 'src/a.ts'])('%s no es prueba', (p) => {
    expect(isTestPath(p)).toBe(false);
  });
});

describe('discoverFiles', () => {
  it('poda directorios excluidos, respeta .gitignore y omite lockfiles', async () => {
    repo = await createTmpRepo({
      '.gitignore': 'generado/\n*.log\n',
      'src/a.ts': 'export const a = 1;',
      'src/b.test.ts': 'test',
      'node_modules/lib/index.js': 'x',
      'dist/out.js': 'x',
      'generado/c.ts': 'x',
      'debug.log': 'x',
      'package-lock.json': '{}',
      'package.json': '{}',
      'README.md': '# hola',
      'img.png': 'x',
    });
    const { files } = await discoverFiles(repo.root, resolveConfig());
    expect(files.map((f) => f.relPath)).toEqual(['package.json', 'README.md', 'src/a.ts', 'src/b.test.ts']);
    expect(files.find((f) => f.relPath === 'src/b.test.ts')?.isTest).toBe(true);
  });

  it('.radarignore excluye además lo que indique, aunque no se respete .gitignore', async () => {
    repo = await createTmpRepo({ '.radarignore': '# generado\nvendor/\n\n*.gen.ts\n', 'src/a.ts': 'x', 'src/b.gen.ts': 'x', 'vendor/lib.ts': 'x' });
    for (const respectGitignore of [true, false]) {
      const r = await discoverFiles(repo.root, resolveConfig({ respectGitignore }));
      expect(r.files.map((f) => f.relPath)).toEqual(['src/a.ts']);
      expect(r.radarignore).toBe(2);
    }
    repo = await createTmpRepo({ 'src/a.ts': 'x' });
    expect((await discoverFiles(repo.root, resolveConfig())).radarignore).toBeNull();
  });

  it('no respeta .gitignore si se desactiva', async () => {
    repo = await createTmpRepo({ '.gitignore': 'generado/\n', 'generado/c.ts': 'x' });
    const { files } = await discoverFiles(repo.root, resolveConfig({ respectGitignore: false }));
    expect(files.map((f) => f.relPath)).toEqual(['generado/c.ts']);
  });

  it('omite archivos por encima del límite duro', async () => {
    repo = await createTmpRepo({ 'grande.ts': 'x'.repeat(2048), 'ok.ts': 'x' });
    const { files, skipped } = await discoverFiles(repo.root, resolveConfig({ maxFileSizeBytes: 512, hardMaxFileSizeBytes: 1024 }));
    expect(files.map((f) => f.relPath)).toEqual(['ok.ts']);
    expect(skipped).toEqual([{ relPath: 'grande.ts', reason: 'too-large' }]);
  });

  it('no sigue enlaces simbólicos (no puede salir de la raíz)', async () => {
    repo = await createTmpRepo({ 'src/a.ts': 'x' });
    const outside = await createTmpRepo({ 'secreto.ts': 'x' });
    try {
      try {
        await symlink(outside.root, path.join(repo.root, 'enlace'), 'dir');
      } catch {
        return; // Windows sin permisos para crear enlaces: no aplica
      }
      const { files } = await discoverFiles(repo.root, resolveConfig());
      expect(files.map((f) => f.relPath)).toEqual(['src/a.ts']);
    } finally {
      await outside.cleanup();
    }
  });

  it('se puede cancelar', async () => {
    repo = await createTmpRepo({ 'a.ts': 'x' });
    const controller = new AbortController();
    controller.abort();
    await expect(discoverFiles(repo.root, resolveConfig(), controller.signal)).rejects.toThrow();
  });
});

describe('resolveRoot', () => {
  it('rechaza rutas inexistentes, archivos y la raíz de la unidad', async () => {
    repo = await createTmpRepo({ 'a.ts': 'x' });
    await expect(resolveRoot(path.join(repo.root, 'no-existe'))).rejects.toThrow(/no existe/);
    await expect(resolveRoot(path.join(repo.root, 'a.ts'))).rejects.toThrow(/no es un directorio/);
    await expect(resolveRoot(path.parse(repo.root).root)).rejects.toThrow(/raíz de una unidad/);
    await expect(resolveRoot('')).rejects.toThrow(/inválida/);
    await expect(resolveRoot('a\0b')).rejects.toThrow(/inválida/);
  });
});

describe('heurísticas de contenido', () => {
  it('looksBinary detecta bytes nulos', () => {
    expect(looksBinary(Buffer.from([0x50, 0x00, 0x41]))).toBe(true);
    expect(looksBinary(Buffer.from('texto normal'))).toBe(false);
  });

  it('looksMinified detecta líneas extremadamente largas', () => {
    const minified = ['x'.repeat(6000)];
    expect(looksMinified(minified, 6000)).toBe(true);
    const normal = Array.from({ length: 200 }, () => 'const a = 1;');
    expect(looksMinified(normal, 200 * 13)).toBe(false);
  });
});
