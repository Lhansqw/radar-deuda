import { isAuthApiError, isAuthError, isAuthRetryableFetchError, isAuthWeakPasswordError } from '@supabase/supabase-js';
import { tr } from './i18n.js';

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

const noConnection = (): string => tr('No se pudo conectar con Supabase. Comprueba tu conexión a internet e inténtalo de nuevo.', 'Could not connect to Supabase. Check your internet connection and try again.');
const sessionInvalid = (): string => tr('La sesión ya no es válida: vuelve a iniciar sesión.', 'The session is no longer valid: sign in again.');
const sessionExpired = (): string => tr('La sesión caducó: vuelve a iniciar sesión.', 'The session expired: sign in again.');
const alreadyExists = (): string => tr('Ya hay una cuenta con ese correo: inicia sesión o recupera la contraseña.', 'There is already an account with that email: sign in or reset the password.');

/** Se evalúa en cada error, en el idioma actual. */
const BY_CODE: Readonly<Record<string, () => string>> = {
  invalid_credentials: () => tr('El correo o la contraseña no son correctos.', 'The email or password is incorrect.'),
  user_already_exists: alreadyExists,
  email_exists: alreadyExists,
  otp_expired: () => tr('El código no es correcto o ya caducó. Pide uno nuevo.', 'The code is wrong or has expired. Request a new one.'),
  same_password: () => tr('La contraseña nueva debe ser distinta de la anterior.', 'The new password must be different from the previous one.'),
  over_email_send_rate_limit: () => tr('Se enviaron demasiados correos en poco tiempo. Espera unos minutos y vuelve a intentarlo.', 'Too many emails were sent in a short time. Wait a few minutes and try again.'),
  over_request_rate_limit: () => tr('Demasiados intentos seguidos. Espera unos minutos y vuelve a intentarlo.', 'Too many attempts in a row. Wait a few minutes and try again.'),
  email_address_not_authorized: () =>
    tr(
      'El correo de Supabase no puede escribir a esa dirección. El que trae de serie solo envía a los miembros del proyecto: configura un servidor de correo propio (ver docs/CUENTAS.md).',
      'Supabase email cannot send to that address. The built-in one only sends to project members: set up your own mail server (see docs/CUENTAS.md).',
    ),
  email_address_invalid: () => tr('Ese correo no parece válido.', 'That email does not look valid.'),
  signup_disabled: () => tr('El registro de cuentas nuevas está desactivado en este proyecto de Supabase.', 'New account sign-up is disabled in this Supabase project.'),
  email_provider_disabled: () => tr('El acceso con correo y contraseña está desactivado en este proyecto de Supabase.', 'Email and password sign-in is disabled in this Supabase project.'),
  user_banned: () => tr('Esta cuenta está bloqueada.', 'This account is blocked.'),
  user_not_found: sessionInvalid,
  session_not_found: sessionInvalid,
  session_expired: sessionExpired,
  refresh_token_not_found: sessionExpired,
  refresh_token_already_used: sessionExpired,
  request_timeout: noConnection,
  validation_failed: () => tr('Supabase rechazó los datos: revisa el correo y la contraseña.', 'Supabase rejected the data: check the email and password.'),
};

const WEAK_REASONS: Readonly<Record<string, () => string>> = {
  length: () => tr('es demasiado corta', 'is too short'),
  characters: () => tr('le faltan tipos de caracteres (mayúsculas, minúsculas, números o símbolos)', 'is missing character types (uppercase, lowercase, numbers or symbols)'),
  pwned: () => tr('aparece en filtraciones de contraseñas conocidas', 'appears in known password leaks'),
};

export function accountError(err: unknown): AccountError {
  if (err instanceof AccountError) return err;
  if (isAuthWeakPasswordError(err)) {
    const reasons = err.reasons.map((r) => WEAK_REASONS[r]?.()).filter((r): r is string => r !== undefined);
    const detail = reasons.length > 0 ? `: ${reasons.join('; ')}` : '';
    return new AccountError(tr(`La contraseña no es lo bastante segura${detail}.`, `The password is not strong enough${detail}.`));
  }
  if (isAuthRetryableFetchError(err)) return new AccountError(noConnection());
  if (isAuthApiError(err) || isAuthError(err)) {
    const known = err.code ? BY_CODE[err.code]?.() : undefined;
    if (known) return new AccountError(known);
    if (err.status === 401 && /api ?key/i.test(err.message)) {
      return new AccountError(tr('Supabase no acepta la clave publicable configurada: revisa RADAR_SUPABASE_PUBLISHABLE_KEY.', 'Supabase does not accept the configured publishable key: check RADAR_SUPABASE_PUBLISHABLE_KEY.'));
    }
    const code = err.code ?? `HTTP ${err.status ?? '?'}`;
    return new AccountError(tr(`Supabase no pudo completar la operación (${code}).`, `Supabase could not complete the operation (${code}).`));
  }
  return new AccountError(noConnection());
}

/** El error significa «sin conexión» (no que las credenciales sean malas). */
export function isOfflineError(err: unknown): boolean {
  return isAuthRetryableFetchError(err);
}
