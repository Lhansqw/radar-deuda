import { fileURLToPath } from 'node:url';
import { defineConfig, type ViteUserConfig } from 'vitest/config';

const src = (pkg: string): string => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

/** Igual que los "paths" de tsconfig.json: en pruebas se usa el código fuente. */
export const resolve: ViteUserConfig['resolve'] = {
  alias: { '@radar/engine': src('engine'), '@radar/sources': src('sources'), '@radar/ai': src('ai'), '@radar/pipeline': src('pipeline') },
};

export const baseTest = {
  include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts', 'supabase/functions/**/*.test.ts'],
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

/**
 * Cobertura (npm run test:coverage): el código de los paquetes y de la
 * aplicación, sin los scripts de compilación ni los puntos de entrada que solo
 * arrancan procesos (se prueban de extremo a extremo).
 */
const coverage = {
  provider: 'v8',
  include: ['packages/*/src/**/*.ts', 'apps/desktop/src/**/*.{ts,tsx}'],
  exclude: ['**/*.d.ts', 'packages/*/src/index.ts', 'packages/cli/src/cli.ts', 'packages/cli/src/*-cli.ts', 'apps/desktop/src/main/main.ts', 'apps/desktop/src/preload/**', 'apps/desktop/src/worker/analysis-worker.ts', 'apps/desktop/src/renderer/main.tsx'],
  reporter: ['text-summary', 'html', 'json-summary'],
  reportsDirectory: 'coverage',
  // Mínimos por debajo de lo medido en la fase 11: una bajada notable hace fallar la comprobación.
  // La interfaz (vistas y componentes de React) se cubre con la prueba de extremo a extremo.
  thresholds: {
    'packages/*/src/**': { lines: 95, functions: 92, branches: 78 },
    'apps/desktop/src/{main,shared,worker}/**': { lines: 80, functions: 70 },
  },
} as const;

export default defineConfig({
  resolve,
  test: { ...baseTest, env: Object.fromEntries(LIVE_VARIABLES.map((v) => [v, ''])), coverage },
});
