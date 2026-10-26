import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/** Interfaz (renderer). Las rutas relativas (base './') funcionan con el protocolo app://. */
export default defineConfig({
  root: here('./src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: here('./dist/renderer'),
    emptyOutDir: true,
    target: 'chrome140',
    sourcemap: true,
    // Sin módulos precargados en línea: la CSP de producción no permite scripts en línea.
    modulePreload: { polyfill: false },
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: false },
});
