import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';
import { APP_SCHEME } from '../shared/origin.js';
import { contentSecurityPolicy, resolveAppPath } from './policy.js';

/** Debe llamarse antes de que la aplicación esté lista. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
}

/** Sirve la interfaz compilada desde app://radar/ con la cabecera CSP. */
export function serveRenderer(rendererDir: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveAppPath(rendererDir, request.url);
    if (!file) return new Response('No encontrado', { status: 404 });
    // Chromium pide el video de introducción por rangos: se pasa la cabecera Range.
    const range = request.headers.get('Range');
    const res = await net.fetch(pathToFileURL(file).toString(), range ? { headers: { Range: range } } : undefined);
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', contentSecurityPolicy(null));
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, { status: res.status, headers });
  });
}
