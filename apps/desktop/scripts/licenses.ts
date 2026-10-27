import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * Avisos de licencia del software de terceros que va dentro de la aplicación
 * (lo que esbuild y Vite empaquetan desde node_modules). Las licencias de
 * Electron y Chromium las añade electron-builder junto al ejecutable.
 */

/** Archivos de licencia y avisos que se copian enteros. */
const NOTICE_FILE = /^(?:licen[cs]e|copying|notice|thirdpartynotice)/i;

interface PackageInfo {
  name: string;
  version: string;
  license: string;
  dir: string;
}

/** Carpeta del paquete de node_modules al que pertenece un módulo, o null si es código propio. */
export function packageDirOf(file: string): string | null {
  const normalized = file.replaceAll('\\', '/').replace(/^\0/, '').split('?')[0] ?? '';
  const at = normalized.lastIndexOf('/node_modules/');
  if (at === -1) return null;
  const rest = normalized.slice(at + '/node_modules/'.length).split('/');
  const name = rest[0]?.startsWith('@') ? `${rest[0]}/${rest[1] ?? ''}` : rest[0];
  return name ? `${normalized.slice(0, at)}/node_modules/${name}` : null;
}

/** Plugin de Vite que anota los módulos y recursos (fuentes) que acaban en la interfaz, con su ruta absoluta. */
export function collectModules(into: Set<string>): Plugin {
  let root = process.cwd();
  return {
    name: 'radar-licencias',
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        const ids = chunk.type === 'chunk' ? Object.keys(chunk.modules) : chunk.originalFileNames;
        for (const id of ids) into.add(path.isAbsolute(id) ? id : path.resolve(root, id));
      }
    },
  };
}

async function packageInfo(dir: string): Promise<PackageInfo> {
  const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string; license?: unknown };
  return { name: pkg.name ?? path.basename(dir), version: pkg.version ?? '?', license: typeof pkg.license === 'string' ? pkg.license : 'consulta los archivos del paquete', dir };
}

async function noticeTexts(dir: string): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => NOTICE_FILE.test(f)).sort();
  return Promise.all(files.map(async (f) => (await readFile(path.join(dir, f), 'utf8')).trim()));
}

/** Texto con el nombre, la versión, la licencia y los avisos de cada paquete empaquetado. */
export async function thirdPartyNotices(modulePaths: Iterable<string>): Promise<{ text: string; packages: string[] }> {
  const dirs = new Set<string>();
  for (const p of modulePaths) {
    const dir = packageDirOf(p);
    if (dir) dirs.add(dir);
  }
  const infos = (await Promise.all([...dirs].map(packageInfo))).sort((a, b) => a.name.localeCompare(b.name));
  const unique = infos.filter((info, i) => i === 0 || info.name !== infos[i - 1]?.name || info.version !== infos[i - 1]?.version);
  const sections = await Promise.all(
    unique.map(async (info) => {
      const texts = await noticeTexts(info.dir);
      const title = `${info.name} ${info.version} (${info.license})`;
      return [title, '-'.repeat(title.length), texts.length > 0 ? texts.join('\n\n') : 'Sin archivo de licencia en el paquete; ver su licencia en el registro de npm.'].join('\n');
    }),
  );
  const intro = [
    'Radar de Deuda Técnica incluye el siguiente software de terceros.',
    'Las licencias de Electron y Chromium están en LICENSE.electron.txt y LICENSES.chromium.html, junto al ejecutable.',
  ].join('\n');
  return { text: `${[intro, ...sections].join('\n\n\n')}\n`, packages: unique.map((i) => `${i.name}@${i.version}`) };
}
