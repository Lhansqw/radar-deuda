import { fileURLToPath } from 'node:url';
import { defineConfig, type ViteUserConfig } from 'vitest/config';

const src = (pkg: string, file = 'index.ts'): string => fileURLToPath(new URL(`./packages/${pkg}/src/${file}`, import.meta.url));

/**
 * Igual que los "paths" de tsconfig.json: en pruebas se usa el código fuente.
 * Nombres exactos, para que `@radar/engine` no capture `@radar/engine/refs`
 * (el módulo sin Node que importa la interfaz, como en apps/desktop/vite.config.ts).
 */
export const resolve: ViteUserConfig['resolve'] = {
  alias: [
    { find: /^@radar\/engine\/refs$/, replacement: src('engine', 'refs.ts') },
    ...['engine', 'sources', 'ai', 'pipeline'].map((pkg) => ({ find: new RegExp(`^@radar/${pkg}$`), replacement: src(pkg) })),
  ],
};

export const baseTest = {
  // Las pruebas de la interfaz (*.test.tsx) declaran su entorno: // @vitest-environment happy-dom
  include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts', 'apps/**/test/**/*.test.tsx', 'supabase/functions/**/*.test.ts'],
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
  // Mínimos por debajo de lo medido: una bajada notable hace fallar la comprobación.
  // En la interfaz, lo que no tiene pruebas propias (test/renderer) se cubre con la de extremo a extremo.
  thresholds: {
    'packages/*/src/**': { lines: 95, functions: 92, branches: 78 },
    'apps/desktop/src/{main,shared,worker}/**': { lines: 80, functions: 70 },
    'apps/desktop/src/renderer/**': { lines: 35, functions: 25, branches: 25 },
  },
} as const;

export default defineConfig({
  resolve,
  test: { ...baseTest, env: Object.fromEntries(LIVE_VARIABLES.map((v) => [v, ''])), coverage },
});
