/**
 * Claves falsas con el formato de cada proveedor. Se construyen por partes y
 * usan caracteres que no son hexadecimales para que ningún detector de
 * secretos (ni el propio motor) las tome por claves reales.
 */
export const FAKE_KEYS = {
  openrouter: ['sk', 'or', 'v1', 'x'.repeat(64)].join('-'),
  anthropic: ['sk', 'ant', 'prueba', 'x'.repeat(40)].join('-'),
  openai: ['sk', 'prueba', 'x'.repeat(30)].join('-'),
};
