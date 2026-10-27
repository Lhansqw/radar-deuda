/**
 * Empaqueta la aplicación y genera el instalador. Uso (desde la raíz):
 *
 *   npm run dist              # Windows: instalador NSIS en apps/desktop/release
 *   npm run dist -- --carpeta # solo la aplicación empaquetada, sin instalador (más rápido)
 *
 * En Linux genera siempre la carpeta (linux-unpacked), para probar el paquete.
 * Al terminar comprueba el paquete (scripts/verify-package.ts): los fuses, que
 * arranca desde el ASAR y que no se puede usar como Node ni inyectarle código.
 * Con --sin-prueba no se comprueba.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { build, Platform } from 'electron-builder';
import { compileApp } from './compile.js';
import { appDir } from './config.js';
import { verifyPackage } from './verify-package.js';

const args = new Set(process.argv.slice(2));
const onlyFolder = args.has('--carpeta') || process.platform !== 'win32';
const platform = process.platform === 'win32' ? Platform.WINDOWS : process.platform === 'darwin' ? Platform.MAC : Platform.LINUX;
const releaseDir = path.join(appDir, 'release');

const started = performance.now();
const packages = await compileApp();
console.log(`Compilado. Software de terceros incluido: ${packages.join(', ')}.`);

await build({
  projectDir: appDir,
  targets: platform.createTarget(onlyFolder ? 'dir' : undefined),
  publish: 'never',
});

const unpacked = path.join(releaseDir, process.platform === 'win32' ? 'win-unpacked' : 'linux-unpacked');
const exe = path.join(unpacked, process.platform === 'win32' ? 'radar-deuda.exe' : 'radar-deuda');
console.log(`Aplicación empaquetada en ${path.relative(process.cwd(), unpacked)}${onlyFolder ? '' : ` e instalador en ${path.relative(process.cwd(), releaseDir)}`} (${Math.round((performance.now() - started) / 1000)} s).`);

if (args.has('--sin-prueba')) process.exit(0);
if (!existsSync(exe)) throw new Error(`No se encontró el ejecutable empaquetado: ${exe}`);
if (process.platform === 'linux' && !process.env['DISPLAY']) {
  console.log('Comprobación del paquete omitida: no hay pantalla (en Linux, usa xvfb-run).');
  process.exit(0);
}
await verifyPackage(unpacked, exe);
console.log('Paquete comprobado.');
