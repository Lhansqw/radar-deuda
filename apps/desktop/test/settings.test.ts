import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings, validateSettings, type AppSettings } from '../src/shared/settings.js';

const withAi = (ai: Partial<AppSettings['ai']>): AppSettings => ({ ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, ...ai } });
const errorsOf = (v: unknown): string[] => {
  const r = validateSettings(v);
  return r.ok ? [] : r.errors;
};

describe('ajustes', () => {
  it('los valores por defecto son válidos', () => {
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual({ ok: true, value: DEFAULT_SETTINGS });
  });

  it('valida OpenRouter: formato de modelos, respaldos y opciones de retención', () => {
    expect(errorsOf(withAi({ model: 'sin-proveedor' }))).toEqual(['Modelo: en OpenRouter el formato es proveedor/modelo.']);
    expect(errorsOf(withAi({ model: 'a/b:free', fallbackModels: ['c/d:free', 'x'] }))).toEqual(['Modelo de respaldo no válido: x (formato proveedor/modelo).']);
    expect(errorsOf(withAi({ model: 'a/b', fallbackModels: ['c/d', 'e/f', 'g/h', 'i/j'] }))).toEqual(['Modelos de respaldo: como mucho 3.']);
    expect(errorsOf(withAi({ allowDataCollection: true, zeroDataRetention: true }))).toHaveLength(1);
    expect(errorsOf(withAi({ auto: true }))).toEqual(['Para usar la IA automáticamente con OpenRouter, elige un modelo.']);
    expect(errorsOf(withAi({ auto: true, model: 'nvidia/nemotron-3.5-super-vl:free', fallbackModels: ['  dots-studio/dots-3-note-preview:free '] }))).toEqual([]);
  });

  it('limpia espacios y descarta respaldos vacíos', () => {
    const r = validateSettings(withAi({ model: '  a/b  ', fallbackModels: [' c/d ', ''] }));
    expect(r.ok && r.value.ai).toMatchObject({ model: 'a/b', fallbackModels: ['c/d'] });
  });

  it('otros proveedores: sin respaldos, privacidad coherente y URL local válida', () => {
    expect(errorsOf(withAi({ provider: 'anthropic', fallbackModels: ['a/b'] }))).toEqual(['Los modelos de respaldo solo existen en OpenRouter.']);
    expect(errorsOf(withAi({ provider: 'anthropic', privacy: 'local' }))).toEqual(['Privacidad "local" impide usar un proveedor en la nube.']);
    expect(errorsOf(withAi({ provider: 'lmstudio', privacy: 'local', model: 'qwen2.5-coder:7b' }))).toEqual([]);
    expect(errorsOf(withAi({ provider: 'ollama', localUrl: 'http://localhost:11434/v1' }))).toEqual([]);
    expect(errorsOf(withAi({ provider: 'ollama', localUrl: 'ftp://x' }))).toHaveLength(1);
    expect(errorsOf(withAi({ provider: 'ollama', localUrl: 'http://usuario:clave@localhost/' }))).toHaveLength(1);
  });

  it('rechaza tipos y rangos incorrectos y devuelve todos los errores a la vez', () => {
    const bad = { analysis: { history: 'sí', historyMonths: 0, online: false, memoryLimitMb: 100 }, ai: { ...DEFAULT_SETTINGS.ai, limit: 51, budgetUsd: 0, provider: 'otro' }, cloud: { sync: 1 } };
    expect(errorsOf(bad)).toEqual([
      'Historial de Git: debe ser sí o no.',
      'Meses de historial: debe ser un número entero entre 1 y 120.',
      'Memoria del análisis (MB): debe ser un número entero entre 512 y 4096.',
      'Proveedor de IA: valor no válido.',
      'Presupuesto: debe ser mayor que 0 y como mucho 50 USD.',
      'Hallazgos a explicar: debe ser un número entero entre 1 y 50.',
      'Copia en la nube: debe ser sí o no.',
    ]);
    expect(errorsOf(null)).toEqual(['Formato de ajustes no válido.']);
  });

  it('normaliza lo guardado: completa campos nuevos y repone las secciones dañadas', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    // Ajustes de una versión anterior, sin campos nuevos: se completan.
    expect(normalizeSettings({ analysis: { online: true }, ai: { provider: 'anthropic' } })).toEqual({
      analysis: { ...DEFAULT_SETTINGS.analysis, online: true },
      ai: { ...DEFAULT_SETTINGS.ai, provider: 'anthropic' },
      cloud: { sync: true },
    });
    // Una sección inválida no arrastra a las otras.
    expect(normalizeSettings({ analysis: { online: true }, ai: { limit: 999 }, cloud: { sync: false } })).toEqual({
      analysis: { ...DEFAULT_SETTINGS.analysis, online: true },
      ai: DEFAULT_SETTINGS.ai,
      cloud: { sync: false },
    });
    expect(normalizeSettings({ analysis: { online: true }, cloud: { sync: 'no' } })).toEqual({ ...DEFAULT_SETTINGS, analysis: { ...DEFAULT_SETTINGS.analysis, online: true } });
    // Nunca devuelve el mismo objeto que los valores por defecto (se puede modificar sin efectos laterales).
    expect(normalizeSettings(null)).not.toBe(DEFAULT_SETTINGS);
  });
});
