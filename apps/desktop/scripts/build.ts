/**
 * Compila la aplicación en apps/desktop/dist. Uso: npm run desktop:build (o
 * npm run desktop para compilar y abrirla).
 */
import path from 'node:path';
import { compileApp } from './compile.js';
import { distDir } from './config.js';

const started = performance.now();
const packages = await compileApp();
console.log(`Aplicación compilada en ${path.relative(process.cwd(), distDir) || distDir} (${Math.round(performance.now() - started)} ms).`);
console.log(`Software de terceros incluido: ${packages.join(', ')}.`);
