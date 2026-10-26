import { fileURLToPath } from 'node:url';
import { defineConfig, type ViteUserConfig } from 'vitest/config';

const src = (pkg: string): string => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

/** Igual que los "paths" de tsconfig.json: en pruebas se usa el código fuente. */
export const resolve: ViteUserConfig['resolve'] = {
  alias: { '@radar/engine': src('engine'), '@radar/sources': src('sources'), '@radar/ai': src('ai'), '@radar/pipeline': src('pipeline') },
};

export const baseTest = {
  include: ['packages/**/test/**/*.test.ts'],
  environment: 'node',
  testTimeout: 60_000,
  pool: 'forks',
} as const;

/**
 * Las pruebas "en vivo" (red real, modelos reales) se activan con variables de
 * entorno. En la ejecución normal (npm test, npm run check) se anulan para que
 * unas variables olvidadas en la terminal no hagan salir a la red ni gastar
 * cuota. Esas pruebas se lanzan a propósito con npm run test:live.
 */
export const LIVE_VARIABLES = ['RADAR_LIVE', 'RADAR_LIVE_LLM'] as const;

export default defineConfig({
  resolve,
  test: { ...baseTest, env: Object.fromEntries(LIVE_VARIABLES.map((v) => [v, ''])) },
});
