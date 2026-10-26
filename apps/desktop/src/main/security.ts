import { app, session, shell, type Session, type WebContents } from 'electron';
import { APP_SCHEME, isAppUrl } from '../shared/origin.js';
import { contentSecurityPolicy, isAllowedExternalUrl } from './policy.js';

export async function openExternal(url: string): Promise<boolean> {
  if (!isAllowedExternalUrl(url)) return false;
  await shell.openExternal(url);
  return true;
}

/** Ninguna página de la aplicación necesita cámara, micrófono, notificaciones, ubicación… */
function denyPermissions(s: Session): void {
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  s.setPermissionCheckHandler(() => false);
  s.setDevicePermissionHandler(() => false);
}

function hardenWebContents(contents: WebContents, devServerUrl: string | null): void {
  // Sin navegación fuera de la interfaz (un enlace o una redirección no puede sacarla de su origen).
  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url, devServerUrl)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url, devServerUrl)) event.preventDefault();
  });
  // Sin ventanas nuevas: los enlaces permitidos se abren en el navegador del sistema.
  contents.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: 'deny' };
  });
  // Sin <webview>.
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

/** Sandbox para todos los procesos de interfaz. Debe llamarse antes de que la aplicación esté lista. */
export function enableSandboxEverywhere(): void {
  app.enableSandbox();
}

/**
 * Endurecimiento global, antes de crear ninguna ventana. Sigue la lista de
 * comprobación de https://www.electronjs.org/docs/latest/tutorial/security.
 */
export function hardenApp(devServerUrl: string | null): void {
  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents, devServerUrl));
  const s = session.defaultSession;
  denyPermissions(s);
  // Cabecera CSP para las respuestas del servidor de desarrollo; las de app:// ya la llevan (protocol.ts).
  s.webRequest.onHeadersReceived((details, callback) => {
    if (details.url.startsWith(`${APP_SCHEME}:`)) return callback({});
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [contentSecurityPolicy(devServerUrl)] } });
  });
}
