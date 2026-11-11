/**
 * Idioma de los textos que genera el motor (títulos, mensajes, impacto,
 * justificación del esfuerzo y notas de cobertura). Los identificadores, las
 * reglas y las métricas no cambian con el idioma.
 */
export type Locale = 'es' | 'en';

/** Devuelve el texto del idioma elegido; los dos se escriben juntos para que no falte ninguno. */
export type Translate = (es: string, en: string) => string;

const spanish: Translate = (es) => es;
const english: Translate = (_es, en) => en;

export function translator(locale: Locale = 'es'): Translate {
  return locale === 'en' ? english : spanish;
}

export const SPANISH = spanish;
