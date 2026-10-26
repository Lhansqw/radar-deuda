import path from 'node:path';
import { APP_HOST, APP_SCHEME } from '../shared/origin.js';

/*
 * Reglas de seguridad sin dependencias de Electron, para poder probarlas de
 * forma aislada. Las aplican security.ts y protocol.ts.
 */

/**
 * Política de seguridad de contenido. La interfaz no carga nada de fuera: ni
 * scripts, ni estilos, ni fuentes, ni conexiones. En desarrollo se permite el
 * servidor de Vite (recarga en caliente) y los estilos que inyecta.
 */
export function contentSecurityPolicy(devServerUrl: string | null): string {
  const dev = devServerUrl ? new URL(devServerUrl) : null;
  return [
    "default-src 'none'",
    dev ? `script-src 'self' 'unsafe-inline'` : "script-src 'self'",
    dev ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    dev ? `connect-src 'self' ws://${dev.host}` : "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * Páginas externas que la aplicación puede abrir en el navegador del sistema
 * (crear claves, consultar modelos o documentación). Solo https y solo estos
 * dominios: un enlace de otro origen se ignora.
 */
const EXTERNAL_HOSTS = new Set(['openrouter.ai', 'github.com', 'platform.claude.com', 'console.anthropic.com', 'platform.openai.com', 'osv.dev', 'www.npmjs.com']);

export function isAllowedExternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.username === '' && u.password === '' && EXTERNAL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Archivo de la interfaz que corresponde a una URL app://radar/…, o null si la
 * URL no es de la aplicación o intenta salir de la carpeta (`..`, rutas
 * absolutas, barras invertidas codificadas).
 */
export function resolveAppPath(rendererDir: string, requestUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(requestUrl);
  } catch {
    return null;
  }
  if (u.protocol !== `${APP_SCHEME}:` || u.host !== APP_HOST) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  if (rel.includes('\0') || rel.includes('\\')) return null;
  if (rel === '/' || rel === '') rel = '/index.html';
  const root = path.resolve(rendererDir);
  const abs = path.resolve(root, `.${rel}`);
  return abs.startsWith(root + path.sep) ? abs : null;
}
