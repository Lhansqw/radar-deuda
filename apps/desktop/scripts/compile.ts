import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { appDir, distDir, nodeBuildOptions } from './config.js';
import { collectModules, thirdPartyNotices } from './licenses.js';

/**
 * Compila la aplicación en apps/desktop/dist: procesos de Node con esbuild y la
 * interfaz con Vite. También escribe dist/THIRD_PARTY_LICENSES.txt con las
 * licencias de lo que se ha empaquetado desde node_modules (el instalador lo
 * copia junto al ejecutable). Devuelve los paquetes de terceros incluidos.
 */
export async function compileApp(): Promise<string[]> {
  await rm(distDir, { recursive: true, force: true });
  const node = await esbuild({ ...nodeBuildOptions(false), metafile: true });
  const rendererModules = new Set<string>();
  await viteBuild({ configFile: path.join(appDir, 'vite.config.ts'), logLevel: 'warn', plugins: [collectModules(rendererModules)] });
  const notices = await thirdPartyNotices([...Object.keys(node.metafile.inputs).map((p) => path.resolve(p)), ...rendererModules]);
  await writeFile(path.join(distDir, 'THIRD_PARTY_LICENSES.txt'), notices.text, 'utf8');
  return notices.packages;
}
