/**
 * Origen de la interfaz. En producción se sirve con un protocolo propio
 * (app://radar/…) en lugar de file://, como recomienda la guía de seguridad de
 * Electron: así la interfaz tiene un origen fijo que se puede comprobar y no
 * puede leer otros archivos del disco.
 */
export const APP_SCHEME = 'app';
export const APP_HOST = 'radar';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_ENTRY = `${APP_ORIGIN}/index.html`;

/**
 * ¿Procede esta URL de la interfaz de la aplicación? Se usa para validar el
 * remitente de cada mensaje IPC y para impedir la navegación a otros sitios.
 * En desarrollo también se acepta el servidor de Vite (solo en localhost).
 */
export function isAppUrl(url: string | undefined | null, devServerUrl: string | null = null): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === `${APP_SCHEME}:` && u.host === APP_HOST) return true;
  if (devServerUrl) {
    const dev = new URL(devServerUrl);
    const local = dev.hostname === 'localhost' || dev.hostname === '127.0.0.1';
    return local && u.origin === dev.origin;
  }
  return false;
}
