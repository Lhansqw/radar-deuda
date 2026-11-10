import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isLanguageSetting, resolveLocale, type LanguageSetting, type Locale } from '../shared/settings.js';

/**
 * Idioma del proceso principal: mensajes de error, textos de los hallazgos y
 * respuestas de la IA. Es una preferencia del equipo, no de la cuenta: se
 * elige también en la pantalla de acceso, antes de iniciar sesión, y se
 * guarda en <carpeta de datos>/idioma.json.
 */
export const LANGUAGE_FILE = 'idioma.json';

let language: LanguageSetting = 'auto';
let systemLang = 'es';
let file: string | null = null;

/** Lee la preferencia guardada. `system`: app.getLocale() (p. ej. "es-ES", "en-US"). */
export function initLanguage(dataDir: string, system: string): void {
  systemLang = system;
  file = path.join(dataDir, LANGUAGE_FILE);
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const value = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['language'] : undefined;
    language = isLanguageSetting(value) ? value : 'auto';
  } catch {
    language = 'auto';
  }
}

export function languageSetting(): LanguageSetting {
  return language;
}

export function currentLocale(): Locale {
  return resolveLocale(language, systemLang);
}

/** Guarda la preferencia (si se llamó a initLanguage) y devuelve el idioma resultante. */
export function setLanguage(value: LanguageSetting): Locale {
  language = value;
  if (file) {
    if (!existsSync(path.dirname(file))) mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ language: value }), 'utf8');
  }
  return currentLocale();
}

/** El texto en el idioma actual. */
export function tr(es: string, en: string): string {
  return currentLocale() === 'en' ? en : es;
}
