import { defineConfig } from 'vitest/config';
import { baseTest, resolve } from './vitest.config.js';

/**
 * Solo las pruebas "en vivo", con las variables de entorno de la terminal.
 * Cada una sigue requiriendo su variable (RADAR_LIVE=1, RADAR_LIVE_LLM=…);
 * sin ella se omite. Uso: npm run test:live [-- archivo]
 */
export default defineConfig({
  resolve,
  test: { ...baseTest, testNamePattern: /en vivo/ },
});
