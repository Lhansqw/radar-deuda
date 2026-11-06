import { readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Dónde deja electron-builder la aplicación empaquetada (sin instalador) y qué
 * hay dentro, según el sistema:
 *
 * - Windows: release/win-unpacked/radar-deuda.exe y resources/app.asar.
 * - Linux:   release/linux-unpacked/radar-deuda (linux-arm64-unpacked en ARM) y resources/app.asar.
 * - macOS:   release/mac/<nombre>.app (mac-arm64 en Apple Silicon), con el
 *            ejecutable en Contents/MacOS y el ASAR en Contents/Resources.
 */
export interface PackageLayout {
  /** Carpeta que se copia entera para la prueba del ASAR alterado. */
  unpacked: string;
  /** Ejecutable de la aplicación. */
  exe: string;
  /** app.asar, relativo a `unpacked`. */
  asar: string;
}

export function unpackedDir(releaseDir: string, platform: NodeJS.Platform, arch: string): string {
  const suffix = arch === 'x64' ? '' : `-${arch}`;
  if (platform === 'win32') return path.join(releaseDir, `win${suffix}-unpacked`);
  if (platform === 'darwin') return path.join(releaseDir, `mac${suffix}`);
  return path.join(releaseDir, `linux${suffix}-unpacked`);
}

/** Para macOS lee la carpeta: el nombre del .app y del ejecutable los decide electron-builder. */
export function packageLayout(
  releaseDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  list: (dir: string) => string[] = (dir) => readdirSync(dir),
): PackageLayout {
  const unpacked = unpackedDir(releaseDir, platform, arch);
  if (platform === 'win32') return { unpacked, exe: path.join(unpacked, 'radar-deuda.exe'), asar: path.join('resources', 'app.asar') };
  if (platform !== 'darwin') return { unpacked, exe: path.join(unpacked, 'radar-deuda'), asar: path.join('resources', 'app.asar') };
  const bundle = list(unpacked).find((f) => f.endsWith('.app'));
  if (!bundle) throw new Error(`No se encontró la aplicación (.app) en ${unpacked}.`);
  const macos = path.join(unpacked, bundle, 'Contents', 'MacOS');
  const [exe] = list(macos);
  if (!exe) throw new Error(`No se encontró el ejecutable en ${macos}.`);
  return { unpacked, exe: path.join(macos, exe), asar: path.join(bundle, 'Contents', 'Resources', 'app.asar') };
}
