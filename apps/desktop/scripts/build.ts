/**
 * Compila la aplicación en apps/desktop/dist: procesos de Node con esbuild y la
 * interfaz con Vite. Uso: npm run desktop:build (o npm run desktop para
 * compilar y abrirla).
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { appDir, distDir, nodeBuildOptions } from './config.js';

const started = performance.now();
await rm(distDir, { recursive: true, force: true });
await esbuild(nodeBuildOptions(false));
await viteBuild({ configFile: path.join(appDir, 'vite.config.ts'), logLevel: 'warn' });
console.log(`Aplicación compilada en ${path.relative(process.cwd(), distDir) || distDir} (${Math.round(performance.now() - started)} ms).`);
