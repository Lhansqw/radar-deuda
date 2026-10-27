/**
 * Conexión con Supabase (fase 13): la URL del proyecto y su clave publicable.
 *
 * Ninguna de las dos es secreta: la clave publicable está pensada para ir en
 * aplicaciones de escritorio y móviles, y lo que protege los datos son las
 * reglas de seguridad por filas de la base de datos. Aun así no se guardan en
 * el repositorio: llegan por variables de entorno, al ejecutar o al compilar
 * (scripts/config.ts las incrusta en el paquete si están definidas).
 *
 * La clave secreta (sb_secret_…, o la antigua service_role) salta esas reglas:
 * se rechaza siempre.
 */

export const ENV_URL = 'RADAR_SUPABASE_URL';
export const ENV_KEY = 'RADAR_SUPABASE_PUBLISHABLE_KEY';

export interface CloudConfig {
  /** https://<proyecto>.supabase.co, sin barra final. */
  url: string;
  publishableKey: string;
}

export type CloudConfigResult = { ok: true; config: CloudConfig } | { ok: false; message: string };

/** Valores incrustados al compilar, si los había (ver scripts/config.ts). */
export interface BuiltCloudConfig {
  url: string;
  publishableKey: string;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const PUBLISHABLE = /^sb_publishable_[A-Za-z0-9_-]{10,}$/;
const JWT = /^[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/;

/**
 * Lee la configuración: primero las variables de entorno (desarrollo y
 * pruebas) y, si no hay, la incrustada al compilar.
 */
export function cloudConfig(env: NodeJS.ProcessEnv, built: BuiltCloudConfig | null): CloudConfigResult {
  const url = (env[ENV_URL] ?? '').trim() || built?.url || '';
  const key = (env[ENV_KEY] ?? '').trim() || built?.publishableKey || '';
  if (url === '' && key === '') {
    return {
      ok: false,
      message: `Define ${ENV_URL} y ${ENV_KEY} (la URL y la clave publicable de tu proyecto de Supabase) antes de abrir o de compilar la aplicación. Ver docs/CUENTAS.md.`,
    };
  }
  if (url === '') return { ok: false, message: `Falta ${ENV_URL}: la URL de tu proyecto de Supabase (https://<proyecto>.supabase.co).` };
  if (key === '') return { ok: false, message: `Falta ${ENV_KEY}: la clave publicable de tu proyecto de Supabase (sb_publishable_…).` };
  const urlProblem = checkUrl(url);
  if (urlProblem) return { ok: false, message: urlProblem };
  const keyProblem = checkKey(key);
  if (keyProblem) return { ok: false, message: keyProblem };
  return { ok: true, config: { url: url.replace(/\/+$/, ''), publishableKey: key } };
}

function checkUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `${ENV_URL} no es una URL válida.`;
  }
  if (u.username !== '' || u.password !== '') return `${ENV_URL} no debe incluir usuario ni contraseña.`;
  if (u.pathname.replace(/\/+$/, '') !== '' || u.search !== '' || u.hash !== '') return `${ENV_URL} debe ser solo la dirección del proyecto, por ejemplo https://abcd1234.supabase.co.`;
  // Sin cifrar solo en el propio equipo (Supabase local, npx supabase start).
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) return `${ENV_URL} debe empezar por https://.`;
  return null;
}

function checkKey(key: string): string | null {
  const secret = `${ENV_KEY} contiene una clave secreta. Esa clave salta las reglas de seguridad de la base de datos y nunca debe ir en una aplicación: usa la clave publicable (sb_publishable_…).`;
  if (key.startsWith('sb_secret_')) return secret;
  if (PUBLISHABLE.test(key)) return null;
  // Claves antiguas (JWT): solo la «anon» es pública.
  const jwt = JWT.exec(key);
  if (jwt?.[1]) {
    const role = jwtRole(jwt[1]);
    if (role === 'anon') return null;
    if (role === 'service_role') return secret;
  }
  return `${ENV_KEY} no tiene el formato de una clave publicable de Supabase (sb_publishable_…).`;
}

function jwtRole(payload: string): string | null {
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { role?: unknown };
    return typeof claims.role === 'string' ? claims.role : null;
  } catch {
    return null;
  }
}
