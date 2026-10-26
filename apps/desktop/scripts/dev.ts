/**
 * Desarrollo: servidor de Vite con recarga en caliente para la interfaz, y
 * recompilación de los procesos de Node con reinicio de Electron al guardar.
 * Uso: npm run desktop:dev
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { context } from 'esbuild';
import { createServer } from 'vite';
import { appDir, nodeBuildOptions } from './config.js';

const electronPath = createRequire(import.meta.url)('electron') as string;
const server = await createServer({ configFile: path.join(appDir, 'vite.config.ts') });
await server.listen();
const url = server.resolvedUrls?.local[0];
if (!url) throw new Error('El servidor de Vite no devolvió ninguna URL.');
console.log(`Interfaz en ${url}`);

let child: ChildProcess | null = null;
let restarting = false;

function launch(): void {
  restarting = true;
  child?.kill();
  child = spawn(electronPath, ['.'], { cwd: appDir, stdio: 'inherit', env: { ...process.env, RADAR_DEV_SERVER_URL: url } });
  restarting = false;
  child.on('exit', (code) => {
    if (restarting) return;
    void server.close();
    process.exit(code ?? 0);
  });
}

const ctx = await context({
  ...nodeBuildOptions(true),
  plugins: [{ name: 'reiniciar-electron', setup: (b) => b.onEnd((r) => (r.errors.length === 0 ? launch() : undefined)) }],
});
await ctx.watch();
