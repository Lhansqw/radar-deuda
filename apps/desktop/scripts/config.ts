import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildOptions } from 'esbuild';

/** apps/desktop */
export const appDir = fileURLToPath(new URL('..', import.meta.url));
export const distDir = path.join(appDir, 'dist');
const repoDir = path.resolve(appDir, '../..');
const pkg = (name: string): string => path.join(repoDir, 'packages', name, 'src', 'index.ts');

/**
 * Procesos de Node (principal, preload y el de análisis). Se
 * empaqueta todo salvo Electron: los paquetes del monorepo desde su código
 * fuente y sus dependencias (typescript, ignore, semver), para que la
 * aplicación no dependa de node_modules en tiempo de ejecución.
 * Formato CommonJS: el preload con sandbox no admite módulos ES.
 */
export function nodeBuildOptions(dev: boolean): BuildOptions {
  return {
    entryPoints: {
      main: path.join(appDir, 'src/main/main.ts'),
      preload: path.join(appDir, 'src/preload/preload.ts'),
      worker: path.join(appDir, 'src/worker/analysis-worker.ts'),
    },
    outdir: distDir,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    alias: { '@radar/engine': pkg('engine'), '@radar/sources': pkg('sources'), '@radar/ai': pkg('ai'), '@radar/pipeline': pkg('pipeline') },
    sourcemap: true,
    minify: !dev,
    legalComments: 'none',
    logLevel: 'warning',
  };
}
