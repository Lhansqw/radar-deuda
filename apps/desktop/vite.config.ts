import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/** Interfaz (renderer). Las rutas relativas (base './') funcionan con el protocolo app://. */
export default defineConfig({
  root: here('./src/renderer'),
  base: './',
  plugins: [react()],
  // La interfaz solo puede usar módulos puros del motor (sin Node): sus tipos y las referencias H1, H2…
  resolve: {
    alias: [
      { find: /^@radar\/engine$/, replacement: here('../../packages/engine/src/types.ts') },
      { find: /^@radar\/engine\/refs$/, replacement: here('../../packages/engine/src/refs.ts') },
    ],
  },
  build: {
    outDir: here('./dist/renderer'),
    emptyOutDir: true,
    target: 'chrome140',
    sourcemap: true,
    // Nada en línea como data: (la CSP no lo permite para fuentes): todo como archivo.
    assetsInlineLimit: 0,
    // Sin módulos precargados en línea: la CSP de producción no permite scripts en línea.
    modulePreload: { polyfill: false },
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: false },
});
