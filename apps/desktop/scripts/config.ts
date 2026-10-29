import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildOptions } from 'esbuild';
import { cloudConfig, ENV_KEY, ENV_URL, type BuiltCloudConfig } from '../src/main/cloud-config.js';

/** apps/desktop */
export const appDir = fileURLToPath(new URL('..', import.meta.url));
export const distDir = path.join(appDir, 'dist');
const repoDir = path.resolve(appDir, '../..');
const pkg = (name: string): string => path.join(repoDir, 'packages', name, 'src', 'index.ts');

/** Conexión del proyecto, en el repositorio: la que usan todas las copias por defecto. */
export const projectCloudFile = path.join(appDir, 'nube.json');

/**
 * Lee nube.json (null si no existe). Solo admite la URL y la clave publicable:
 * una clave secreta detiene la compilación.
 */
export function projectCloud(file: string = projectCloudFile): BuiltCloudConfig | null {
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { url?: unknown; publishableKey?: unknown };
  const r = cloudConfig({ [ENV_URL]: typeof raw.url === 'string' ? raw.url : '', [ENV_KEY]: typeof raw.publishableKey === 'string' ? raw.publishableKey : '' }, null);
  if (!r.ok) throw new Error(`${path.basename(file)} no es válido: ${r.message}`);
  return r.config;
}

/**
 * Conexión con Supabase que se incrusta en la aplicación al compilar: la de
 * RADAR_SUPABASE_URL y RADAR_SUPABASE_PUBLISHABLE_KEY si están definidas (para
 * usar otro proyecto) o, si no, la del proyecto (nube.json). Ninguna es
 * secreta: la clave publicable está hecha para ir dentro de la aplicación, y
 * los datos los protegen las reglas de seguridad por filas. Una clave secreta
 * detiene la compilación.
 */
export function cloudForBuild(env: NodeJS.ProcessEnv = process.env, project: BuiltCloudConfig | null = projectCloud()): BuiltCloudConfig | null {
  if ((env[ENV_URL] ?? '').trim() === '' && (env[ENV_KEY] ?? '').trim() === '') return project;
  const r = cloudConfig(env, null);
  if (!r.ok) throw new Error(`No se puede incrustar la conexión con Supabase: ${r.message}`);
  return r.config;
}

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
    // src/main/main.ts: conexión con Supabase incrustada (o null).
    define: { __RADAR_NUBE__: JSON.stringify(cloudForBuild()) },
  };
}
