import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';
import { APP_SCHEME } from '../shared/origin.js';
import { contentSecurityPolicy, resolveAppPath } from './policy.js';

/** Debe llamarse antes de que la aplicación esté lista. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

/** Sirve la interfaz compilada desde app://radar/ con la cabecera CSP. */
export function serveRenderer(rendererDir: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveAppPath(rendererDir, request.url);
    if (!file) return new Response('No encontrado', { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', contentSecurityPolicy(null));
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, { status: res.status, headers });
  });
}
