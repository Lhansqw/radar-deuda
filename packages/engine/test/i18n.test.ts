import { afterEach, describe, expect, it } from 'vitest';
import { configHash, resolveConfig } from '../src/config.js';
import { analyzeRepository } from '../src/engine.js';
import { translator } from '../src/i18n.js';
import { createTmpRepo, type TmpRepo } from './helpers/tmp-repo.js';

const tmps: TmpRepo[] = [];
afterEach(async () => {
  await Promise.all(tmps.splice(0).map((t) => t.cleanup()));
});

// Una función con exceso de parámetros y un TODO: dos hallazgos con texto propio.
const FILES = {
  'src/a.ts': 'export function f(a: number, b: number, c: number, d: number, e: number, g: number) {\n  // TODO: revisar\n  return a + b + c + d + e + g;\n}\n',
};

describe('idioma de los hallazgos', () => {
  it('por defecto en español; en inglés si se pide, con las mismas reglas y métricas', async () => {
    const repo = await createTmpRepo(FILES);
    tmps.push(repo);
    const es = await analyzeRepository(repo.root, { cacheDir: null });
    const en = await analyzeRepository(repo.root, { cacheDir: null, config: { locale: 'en' } });

    const fn = (r: typeof es) => r.findings.find((f) => f.ruleId === 'complexity/function');
    expect(fn(es)?.title).toBe('Función difícil de mantener: f');
    expect(fn(en)?.title).toBe('Hard-to-maintain function: f');
    expect(fn(en)?.message).toContain('6 parameters (threshold 5)');

    // Los identificadores no dependen del idioma: los análisis se comparan igual.
    expect(en.findings.map((f) => f.id)).toEqual(es.findings.map((f) => f.id));
    expect(en.findings.map((f) => f.evidence.map((e) => e.metric?.value))).toEqual(es.findings.map((f) => f.evidence.map((e) => e.metric?.value)));
    expect(en.coverage.map((c) => c.area)).toContain('Secrets');
    expect(es.coverage.map((c) => c.area)).toContain('Secretos');
  });

  it('el idioma forma parte de la huella de la caché', () => {
    expect(configHash(resolveConfig({ locale: 'en' }))).not.toBe(configHash(resolveConfig()));
    expect(resolveConfig().locale).toBe('es');
  });

  it('translator elige el texto del idioma', () => {
    expect(translator('en')('hola', 'hello')).toBe('hello');
    expect(translator('es')('hola', 'hello')).toBe('hola');
    expect(translator()('hola', 'hello')).toBe('hola');
  });
});
