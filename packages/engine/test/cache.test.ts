import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AnalysisCache } from '../src/cache.js';
import type { FileAnalysisResult, FileMeta } from '../src/types.js';
import { createTmpRepo, type TmpRepo } from './helpers/tmp-repo.js';

let dir: TmpRepo | undefined;
afterEach(async () => {
  await dir?.cleanup();
  dir = undefined;
});

const meta = (over: Partial<FileMeta> = {}): FileMeta => ({
  absPath: '/r/a.ts',
  relPath: 'a.ts',
  size: 10,
  mtimeMs: 1000,
  language: 'typescript',
  isCode: true,
  isTest: false,
  ...over,
});
const result: FileAnalysisResult = { findings: [], artifact: { codeLines: 3 } };

describe('AnalysisCache', () => {
  it('persiste resultados y los recupera por metadatos sin leer el archivo', async () => {
    dir = await createTmpRepo();
    const c1 = await AnalysisCache.open(dir.root, '/repo', 'cfg');
    c1.store(meta(), 'hash1', 'size@1.0.0', result);
    await c1.save();

    const c2 = await AnalysisCache.open(dir.root, '/repo', 'cfg');
    expect(c2.lookupByMeta(meta(), 'size@1.0.0')).toEqual(result);
    expect(c2.lookupByMeta(meta({ mtimeMs: 2000 }), 'size@1.0.0')).toBeUndefined();
    expect(c2.lookupByMeta(meta(), 'size@2.0.0')).toBeUndefined(); // otra versión del analizador
  });

  it('reutiliza resultados si el contenido es idéntico aunque cambie la fecha', async () => {
    dir = await createTmpRepo();
    const c = await AnalysisCache.open(dir.root, '/repo', 'cfg');
    c.store(meta(), 'hash1', 'size@1.0.0', result);
    const touched = meta({ mtimeMs: 5000 });
    expect(c.lookupByHash(touched, 'hash1', 'size@1.0.0')).toEqual(result);
    expect(c.lookupByMeta(touched, 'size@1.0.0')).toEqual(result); // metadatos actualizados
    expect(c.lookupByHash(meta(), 'hash2', 'size@1.0.0')).toBeUndefined();
  });

  it('descarta todo si cambia la configuración', async () => {
    dir = await createTmpRepo();
    const c1 = await AnalysisCache.open(dir.root, '/repo', 'cfg-a');
    c1.store(meta(), 'h', 'size@1.0.0', result);
    await c1.save();
    const c2 = await AnalysisCache.open(dir.root, '/repo', 'cfg-b');
    expect(c2.lookupByMeta(meta(), 'size@1.0.0')).toBeUndefined();
  });

  it('elimina entradas de archivos borrados', async () => {
    dir = await createTmpRepo();
    const c = await AnalysisCache.open(dir.root, '/repo', 'cfg');
    c.store(meta(), 'h', 'size@1.0.0', result);
    c.store(meta({ relPath: 'b.ts' }), 'h', 'size@1.0.0', result);
    c.prune(new Set(['b.ts']));
    expect(c.lookupByMeta(meta(), 'size@1.0.0')).toBeUndefined();
    expect(c.lookupByMeta(meta({ relPath: 'b.ts' }), 'size@1.0.0')).toEqual(result);
  });

  it('se recupera de un archivo de caché corrupto', async () => {
    dir = await createTmpRepo();
    const c1 = await AnalysisCache.open(dir.root, '/repo', 'cfg');
    c1.store(meta(), 'h', 'size@1.0.0', result);
    await c1.save();
    const [file] = await readdir(dir.root);
    await writeFile(path.join(dir.root, file as string), '{ corrupto');
    const c2 = await AnalysisCache.open(dir.root, '/repo', 'cfg');
    expect(c2.lookupByMeta(meta(), 'size@1.0.0')).toBeUndefined();
  });

  it('guarda de forma atómica y no deja temporales', async () => {
    dir = await createTmpRepo();
    const c = await AnalysisCache.open(dir.root, '/repo', 'cfg');
    c.store(meta(), 'h', 'size@1.0.0', result);
    await c.save();
    const files = await readdir(dir.root);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.json$/);
    expect(JSON.parse(await readFile(path.join(dir.root, files[0] as string), 'utf8'))).toMatchObject({ format: 1, configHash: 'cfg' });
  });

  it('desactivada no escribe nada', async () => {
    const c = AnalysisCache.disabled('cfg');
    c.store(meta(), 'h', 'size@1.0.0', result);
    await expect(c.save()).resolves.toBeUndefined();
  });
});
