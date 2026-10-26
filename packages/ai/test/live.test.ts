import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '@radar/engine';
import { OpenAiCompatibleProvider, PRESETS } from '../src/providers/openai-compatible.js';
import { runAi } from '../src/tasks.js';

/**
 * Prueba en vivo contra un modelo real. No se ejecuta por defecto:
 *   $env:RADAR_LIVE_LLM = "lmstudio"   (o "ollama")
 *   npx vitest run packages/ai/test/live.test.ts
 */
const which = process.env['RADAR_LIVE_LLM'];
const DEMO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples', 'demo-repo');

describe.runIf(which === 'lmstudio' || which === 'ollama')('en vivo con un modelo local', () => {
  it('explica hallazgos reales del repositorio de ejemplo con respuestas validadas', async () => {
    const provider = new OpenAiCompatibleProvider(which === 'ollama' ? PRESETS.ollama : PRESETS.lmstudio);
    const models = (await provider.listModels()).filter((m) => !/embed/i.test(m));
    expect(models.length, 'No hay ningún modelo cargado en el servidor local').toBeGreaterThan(0);
    const report = await analyzeRepository(DEMO, { cacheDir: null });
    const ai = await runAi(report, {
      provider,
      model: process.env['RADAR_LIVE_MODEL'] ?? (models[0] as string),
      privacy: 'local',
      readText: (rel) => readFile(path.join(DEMO, rel), 'utf8').catch(() => null),
      cacheDir: null,
      limit: 2,
    });
    console.log(JSON.stringify(ai, null, 2));
    expect(ai.explanations.length + ai.errors.length).toBeGreaterThan(0);
    expect(ai.explanations.length, `Errores: ${ai.errors.map((e) => e.message).join(' | ')}`).toBeGreaterThan(0);
  }, 600_000);
});
