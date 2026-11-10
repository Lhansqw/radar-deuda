import { setLocale } from '../../src/renderer/i18n.js';
import * as format from '../../src/renderer/lib/format.js';
import type { Locale } from '../../src/shared/settings.js';

/** Los formateadores de la interfaz en un idioma (el resto de pruebas sigue en español). */
export function createFormat(locale: Locale) {
  const wrap =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      setLocale(locale);
      try {
        return fn(...args);
      } finally {
        setLocale('es');
      }
    };
  return { formatEffort: wrap(format.formatEffort), formatRelative: wrap(format.formatRelative) };
}
