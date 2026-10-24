import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface TmpRepo {
  root: string;
  write(rel: string, content: string | Buffer): Promise<string>;
  cleanup(): Promise<void>;
}

/** Crea un repositorio temporal con los archivos indicados (rutas con `/`). */
export async function createTmpRepo(files: Record<string, string | Buffer> = {}): Promise<TmpRepo> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'radar-test-'));
  const write = async (rel: string, content: string | Buffer): Promise<string> => {
    const abs = path.join(root, ...rel.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
    return abs;
  };
  for (const [rel, content] of Object.entries(files)) await write(rel, content);
  return { root, write, cleanup: () => rm(root, { recursive: true, force: true }) };
}
