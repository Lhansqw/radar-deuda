import { isAuthApiError, isAuthError, isAuthRetryableFetchError, isAuthWeakPasswordError } from '@supabase/supabase-js';

/**
 * Errores de Supabase Auth traducidos a un mensaje para el usuario. El mensaje
 * nunca repite el correo, la contraseña ni el código, y no revela si una
 * cuenta existe salvo cuando Supabase ya lo dice (registro sin confirmación).
 */
export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountError';
  }
}

const NO_CONNECTION = 'No se pudo conectar con Supabase. Comprueba tu conexión a internet e inténtalo de nuevo.';

const BY_CODE: Readonly<Record<string, string>> = {
  invalid_credentials: 'El correo o la contraseña no son correctos.',
  user_already_exists: 'Ya hay una cuenta con ese correo: inicia sesión o recupera la contraseña.',
  email_exists: 'Ya hay una cuenta con ese correo: inicia sesión o recupera la contraseña.',
  otp_expired: 'El código no es correcto o ya caducó. Pide uno nuevo.',
  same_password: 'La contraseña nueva debe ser distinta de la anterior.',
  over_email_send_rate_limit: 'Se enviaron demasiados correos en poco tiempo. Espera unos minutos y vuelve a intentarlo.',
  over_request_rate_limit: 'Demasiados intentos seguidos. Espera unos minutos y vuelve a intentarlo.',
  email_address_not_authorized:
    'El correo de Supabase no puede escribir a esa dirección. El que trae de serie solo envía a los miembros del proyecto: configura un servidor de correo propio (ver docs/CUENTAS.md).',
  email_address_invalid: 'Ese correo no parece válido.',
  signup_disabled: 'El registro de cuentas nuevas está desactivado en este proyecto de Supabase.',
  email_provider_disabled: 'El acceso con correo y contraseña está desactivado en este proyecto de Supabase.',
  user_banned: 'Esta cuenta está bloqueada.',
  user_not_found: 'La sesión ya no es válida: vuelve a iniciar sesión.',
  session_not_found: 'La sesión ya no es válida: vuelve a iniciar sesión.',
  session_expired: 'La sesión caducó: vuelve a iniciar sesión.',
  refresh_token_not_found: 'La sesión caducó: vuelve a iniciar sesión.',
  refresh_token_already_used: 'La sesión caducó: vuelve a iniciar sesión.',
  request_timeout: NO_CONNECTION,
  validation_failed: 'Supabase rechazó los datos: revisa el correo y la contraseña.',
};

const WEAK_REASONS: Readonly<Record<string, string>> = {
  length: 'es demasiado corta',
  characters: 'le faltan tipos de caracteres (mayúsculas, minúsculas, números o símbolos)',
  pwned: 'aparece en filtraciones de contraseñas conocidas',
};

export function accountError(err: unknown): AccountError {
  if (err instanceof AccountError) return err;
  if (isAuthWeakPasswordError(err)) {
    const reasons = err.reasons.map((r) => WEAK_REASONS[r]).filter((r): r is string => r !== undefined);
    return new AccountError(`La contraseña no es lo bastante segura${reasons.length > 0 ? `: ${reasons.join('; ')}` : ''}.`);
  }
  if (isAuthRetryableFetchError(err)) return new AccountError(NO_CONNECTION);
  if (isAuthApiError(err) || isAuthError(err)) {
    const known = err.code ? BY_CODE[err.code] : undefined;
    if (known) return new AccountError(known);
    if (err.status === 401 && /api ?key/i.test(err.message)) {
      return new AccountError('Supabase no acepta la clave publicable configurada: revisa RADAR_SUPABASE_PUBLISHABLE_KEY.');
    }
    return new AccountError(`Supabase no pudo completar la operación (${err.code ?? `HTTP ${err.status ?? '?'}`}).`);
  }
  return new AccountError(NO_CONNECTION);
}

/** El error significa «sin conexión» (no que las credenciales sean malas). */
export function isOfflineError(err: unknown): boolean {
  return isAuthRetryableFetchError(err);
}
