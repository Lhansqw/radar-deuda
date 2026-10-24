import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveConfig } from '../../src/config.js';
import { discoverFiles } from '../../src/discovery.js';
import type { ProjectContext } from '../../src/types.js';

/** Contexto de proyecto real sobre un directorio (como lo construye el motor). */
export async function projectContext(root: string): Promise<ProjectContext> {
  const config = resolveConfig();
  const { root: resolved, files } = await discoverFiles(root, config);
  return {
    root: resolved,
    files,
    config,
    readText: (rel) => readFile(path.join(resolved, rel), 'utf8').catch(() => null),
    exists: (rel) =>
      access(path.join(resolved, rel)).then(
        () => true,
        () => false,
      ),
  };
}
