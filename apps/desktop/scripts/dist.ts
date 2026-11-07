/**
 * Empaqueta la aplicación y genera el instalador. Uso (desde la raíz):
 *
 *   npm run dist              # instaladores del sistema actual en apps/desktop/release
 *   npm run dist -- --carpeta # solo la aplicación empaquetada, sin instalador (más rápido)
 *
 * Windows: instalador NSIS. Linux: AppImage y .deb. macOS: .dmg (Apple Silicon e Intel).
 * Cada sistema solo empaqueta para sí mismo (electron-builder.yml).
 * Al terminar comprueba el paquete (scripts/verify-package.ts): los fuses, que
 * arranca desde el ASAR y que no se puede usar como Node ni inyectarle código.
 * Con --sin-prueba no se comprueba.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { build, Platform } from 'electron-builder';
import { compileApp } from './compile.js';
import { appDir, cloudForBuild } from './config.js';
import { packageLayout } from './package-layout.js';
import { verifyPackage } from './verify-package.js';

const args = new Set(process.argv.slice(2));
const onlyFolder = args.has('--carpeta');
const platform = process.platform === 'win32' ? Platform.WINDOWS : process.platform === 'darwin' ? Platform.MAC : Platform.LINUX;
const releaseDir = path.join(appDir, 'release');

const started = performance.now();
const cloud = cloudForBuild();
const packages = await compileApp();
console.log(`Compilado. Software de terceros incluido: ${packages.join(', ')}.`);
console.log(
  cloud
    ? `Conexión con Supabase incluida: ${cloud.url}.`
    : 'Sin conexión con Supabase (no hay apps/desktop/nube.json ni RADAR_SUPABASE_URL y RADAR_SUPABASE_PUBLISHABLE_KEY): la aplicación instalada no permitirá iniciar sesión. Ver docs/CUENTAS.md.',
);

// macOS sin certificado de Apple: firma ad-hoc (sin ella, Apple Silicon no abre la
// aplicación tras escribir los fuses). El hardened runtime solo tiene sentido firmada de verdad.
const macSigned = Boolean(process.env['CSC_LINK'] ?? process.env['CSC_NAME']);
if (process.platform === 'darwin') {
  console.log(macSigned ? 'macOS: firma con el certificado de CSC_LINK / CSC_NAME.' : 'macOS: sin certificado de Apple, firma ad-hoc (ver docs/INSTALADOR.md).');
}

// En macOS el nombre del paquete y el de sus procesos ayudantes («<nombre> Helper») salen de productName.
// Con la tilde de «Técnica», Electron 44 aborta al arrancar (SIGTRAP, comprobado en macOS 15 con apps
// mínimas): el nombre interno va sin tilde y Finder y el Dock siguen mostrando el nombre con ella.
const MAC_BUNDLE_NAME = 'Radar de Deuda Tecnica';
const MAC_DISPLAY_NAME = 'Radar de Deuda Técnica';

await build({
  projectDir: appDir,
  targets: platform.createTarget(onlyFolder ? 'dir' : undefined),
  publish: 'never',
  ...(process.platform === 'darwin'
    ? {
        config: {
          productName: MAC_BUNDLE_NAME,
          mac: { ...(macSigned ? {} : { identity: '-', hardenedRuntime: false }), extendInfo: { CFBundleDisplayName: MAC_DISPLAY_NAME } },
        },
      }
    : {}),
});

const layout = packageLayout(releaseDir);
console.log(`Aplicación empaquetada en ${path.relative(process.cwd(), layout.unpacked)}${onlyFolder ? '' : ` e instaladores en ${path.relative(process.cwd(), releaseDir)}`} (${Math.round((performance.now() - started) / 1000)} s).`);

if (args.has('--sin-prueba')) process.exit(0);
if (!existsSync(layout.exe)) throw new Error(`No se encontró el ejecutable empaquetado: ${layout.exe}`);
if (process.platform === 'linux' && !process.env['DISPLAY']) {
  console.log('Comprobación del paquete omitida: no hay pantalla (en Linux, usa xvfb-run).');
  process.exit(0);
}
await verifyPackage(layout);
console.log('Paquete comprobado.');
