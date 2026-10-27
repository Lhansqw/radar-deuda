import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FuseV1Options, getCurrentFuseWire } from '@electron/fuses';

/**
 * Comprueba la aplicación empaquetada (lo que npm run dist acaba de generar):
 *
 * 1. Los fuses escritos en el binario son los de electron-builder.yml.
 * 2. Arranca: la interfaz y el proceso de análisis funcionan desde el ASAR
 *    (prueba de arranque, src/main/smoke.ts).
 * 3. Los fuses funcionan de verdad: ni ELECTRON_RUN_AS_NODE la convierte en un
 *    Node, ni NODE_OPTIONS inyecta código, ni --inspect abre el depurador.
 * 4. En Windows, un app.asar alterado no se carga (integridad del ASAR; en
 *    Linux Electron no la comprueba).
 */

/** Estado de un fuse en el binario: el carácter '0' o '1' (@electron/fuses no exporta su enumeración). */
const OFF = '0'.charCodeAt(0);
const ON = '1'.charCodeAt(0);

/**
 * Los fuses que fija electron-builder.yml. Las versiones nuevas de @electron/fuses
 * añaden fuses (como WasmTrapHandlers en la 2.x) que la configuración no toca y que
 * quedan con el valor de Electron: no se comprueban.
 */
const EXPECTED: Partial<Record<FuseV1Options, number>> = {
  [FuseV1Options.RunAsNode]: OFF,
  [FuseV1Options.EnableCookieEncryption]: ON,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: OFF,
  [FuseV1Options.EnableNodeCliInspectArguments]: OFF,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: ON,
  [FuseV1Options.OnlyLoadAppFromAsar]: ON,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: OFF,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: OFF,
};

const SMOKE_OK = 'Prueba de arranque superada';

interface Run {
  code: number;
  output: string;
}

/**
 * Ejecuta la aplicación con su propia carpeta de datos temporal, que se borra al
 * terminar (en Windows, la aplicación no puede borrarla ella misma: Chromium
 * tiene sus archivos abiertos hasta que el proceso sale).
 */
async function run(exe: string, args: string[], env: Record<string, string> = {}, timeoutMs = 180_000): Promise<Run> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'radar-datos-prueba-'));
  try {
    return await new Promise<Run>((resolve) => {
      const child = spawn(exe, args, { env: { ...process.env, RADAR_DATA_DIR: dataDir, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (d: Buffer) => (output += d.toString()));
      child.stderr.on('data', (d: Buffer) => (output += d.toString()));
      const timer = setTimeout(() => {
        output += `\n[la comprobación detuvo la aplicación: no terminó en ${timeoutMs / 1000} s]`;
        child.kill();
      }, timeoutMs);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, output });
      });
    });
  } finally {
    await removeTemp(dataDir);
  }
}

function check(ok: boolean, message: string, detail = ''): void {
  if (!ok) throw new Error(`${message}${detail ? `\n${detail.trim().split('\n').slice(-15).join('\n')}` : ''}`);
  console.log(`  ✓ ${message}`);
}

async function checkFuses(exe: string): Promise<void> {
  const wire = await getCurrentFuseWire(exe);
  const fuses = Object.keys(EXPECTED).map(Number) as FuseV1Options[];
  const wrong = fuses.filter((k) => (wire[k] as number | undefined) !== EXPECTED[k]).map((k) => FuseV1Options[k]);
  check(wrong.length === 0, 'Fuses escritos en el binario como en electron-builder.yml', wrong.length > 0 ? `Distintos: ${wrong.join(', ')}` : '');
}

/** Cambia un byte del código de la aplicación dentro de una copia de app.asar. */
async function tamperedCopy(unpacked: string): Promise<string> {
  const copy = await mkdtemp(path.join(os.tmpdir(), 'radar-alterado-'));
  await cp(unpacked, copy, { recursive: true });
  const asar = path.join(copy, 'resources', 'app.asar');
  const bytes = await readFile(asar);
  const at = bytes.indexOf(Buffer.from(SMOKE_OK));
  if (at === -1) throw new Error('No se encontró el texto que alterar en app.asar.');
  bytes[at] = 'p'.charCodeAt(0);
  await writeFile(asar, bytes);
  return copy;
}

export async function verifyPackage(unpacked: string, exe: string): Promise<void> {
  console.log('Comprobando el paquete:');
  await checkFuses(exe);

  const smoke = await run(exe, ['--prueba-arranque']);
  check(smoke.code === 0 && smoke.output.includes(SMOKE_OK), 'Arranca: la interfaz y el proceso de análisis funcionan desde el ASAR', smoke.output);

  // Si funcionara como Node, «--prueba-arranque» sería una opción desconocida de Node y no la aplicación.
  const asNode = await run(exe, ['--prueba-arranque'], { ELECTRON_RUN_AS_NODE: '1' });
  check(asNode.code === 0 && asNode.output.includes(SMOKE_OK), 'ELECTRON_RUN_AS_NODE no la convierte en un Node', asNode.output);

  const markerDir = await mkdtemp(path.join(os.tmpdir(), 'radar-inyeccion-'));
  try {
    const marker = path.join(markerDir, 'inyectado.txt');
    const payload = path.join(markerDir, 'inyectar.cjs');
    await writeFile(payload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'sí');\n`);
    // Barras normales: en NODE_OPTIONS la barra invertida escapa el carácter siguiente.
    const injected = await run(exe, ['--prueba-arranque'], { NODE_OPTIONS: `--require "${payload.replaceAll('\\', '/')}"` });
    const ran = await readFile(marker, 'utf8').then(() => true, () => false);
    check(injected.code === 0 && !ran, 'NODE_OPTIONS no inyecta código', injected.output);
  } finally {
    await removeTemp(markerDir);
  }

  const inspect = await run(exe, ['--inspect=0', '--prueba-arranque']);
  check(inspect.code === 0 && !/Debugger listening/i.test(inspect.output), '--inspect no abre el depurador del proceso principal', inspect.output);

  if (process.platform !== 'win32') {
    console.log('  – Integridad del ASAR: Electron solo la comprueba en Windows y macOS.');
    return;
  }
  const copy = await tamperedCopy(unpacked);
  try {
    const tampered = await run(path.join(copy, path.basename(exe)), ['--prueba-arranque'], {}, 60_000);
    check(tampered.code !== 0 && !tampered.output.includes(SMOKE_OK), 'Un app.asar alterado no se carga', tampered.output);
  } finally {
    await removeTemp(copy);
  }
}

/**
 * Borra una carpeta temporal de la comprobación. En Windows, los procesos de
 * Chromium pueden tener abiertos el ejecutable o sus archivos un momento
 * después de salir: se reintenta y, si no se puede, solo se avisa.
 */
async function removeTemp(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch((err: unknown) => {
    console.warn(`  (no se pudo borrar la carpeta temporal ${dir}: ${err instanceof Error ? err.message : String(err)})`);
  });
}
