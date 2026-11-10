import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_THEME, THEME_SETTINGS, type ThemeSetting } from '../shared/settings.js';

/**
 * Tema de la interfaz, guardado en un archivo del equipo (no en la base de
 * datos del usuario): así la pantalla de acceso también se abre con el tema
 * elegido. Se lee de forma síncrona antes de crear la ventana para que no
 * destelle el tema por defecto.
 */
export const APPEARANCE_FILE = 'apariencia.json';

/** Un archivo que falta, está dañado o trae un valor desconocido vale el tema por defecto. */
export function readTheme(file: string): ThemeSetting {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    const theme = data && typeof data === 'object' ? (data as Record<string, unknown>)['theme'] : undefined;
    return THEME_SETTINGS.includes(theme as ThemeSetting) ? (theme as ThemeSetting) : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function writeTheme(file: string, theme: ThemeSetting): void {
  mkdirSync(path.dirname(file), { recursive: true });
  // Primero un temporal y después el cambio de nombre: nunca queda un archivo a medias.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ theme }));
  renameSync(tmp, file);
}

/** Color de fondo de la ventana mientras carga la interfaz (el de --pizarra en styles.css). */
export function windowBackground(dark: boolean): string {
  return dark ? '#131b26' : '#e9eef4';
}
