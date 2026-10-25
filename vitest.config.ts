import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string): string => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Igual que los "paths" de tsconfig.json: en pruebas se usa el código fuente.
    alias: { '@radar/engine': src('engine'), '@radar/sources': src('sources') },
  },
  test: {
    include: ['packages/**/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    pool: 'forks',
  },
});
