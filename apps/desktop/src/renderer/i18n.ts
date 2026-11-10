import type { Locale } from '../shared/settings.js';

/**
 * Idioma de la interfaz. Cada texto se escribe en los dos idiomas a la vez,
 * `tr('Hallazgos', 'Findings')`, para que nunca falte uno. El idioma es una
 * preferencia del equipo que guarda el proceso principal (también sin sesión).
 *
 * `tr` lee el idioma actual al llamarse: al cambiarlo, LanguageRoot (language.tsx) vuelve a
 * pintar toda la interfaz (ningún componente usa memo) sin perder su estado.
 */
let current: Locale = 'es';

export function tr(es: string, en: string): string {
  return current === 'en' ? en : es;
}

export function currentLocale(): Locale {
  return current;
}

/** Lo cambia LanguageRoot (y las pruebas). */
export function setLocale(locale: Locale): void {
  current = locale;
}
