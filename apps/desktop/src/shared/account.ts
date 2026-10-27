/**
 * Cuenta del usuario (fase 13): tipos y reglas que comparten la interfaz y el
 * proceso principal. Las cuentas viven en Supabase Auth; la interfaz nunca
 * recibe los tokens de la sesión, solo este estado.
 */

export type AccountState =
  /** La aplicación no tiene configurada la conexión con Supabase. */
  | { status: 'unconfigured'; message: string }
  | { status: 'signed-out' }
  /** El código de recuperación es válido: falta elegir la contraseña nueva antes de entrar. */
  | { status: 'password-reset'; email: string }
  | { status: 'signed-in'; email: string; offline: boolean };

export interface SignUpResult {
  /** Supabase pide confirmar el correo con el código que acaba de enviar. */
  confirmEmail: boolean;
}

/** Longitud mínima que exige la aplicación (Supabase puede exigir más). */
export const MIN_PASSWORD = 8;
/** Supabase guarda la contraseña con bcrypt, que solo usa los primeros 72 bytes. */
export const MAX_PASSWORD = 72;
export const MAX_EMAIL = 254;

/** Formato razonable de correo: el servidor hace la comprobación definitiva. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Códigos de un solo uso de Supabase: 6 dígitos por defecto (configurable hasta 10). */
const CODE = /^\d{6,10}$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Problema del correo para mostrarlo junto al campo, o null si es válido. */
export function emailProblem(email: string): string | null {
  const e = normalizeEmail(email);
  if (e === '') return 'Escribe tu correo.';
  if (e.length > MAX_EMAIL || !EMAIL.test(e)) return 'Ese correo no parece válido.';
  return null;
}

/** Problema de una contraseña nueva, o null si cumple la longitud. */
export function newPasswordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD) return `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`;
  if (new TextEncoder().encode(password).length > MAX_PASSWORD) return `La contraseña no puede tener más de ${MAX_PASSWORD} caracteres.`;
  return null;
}

export function codeProblem(code: string): string | null {
  return CODE.test(code.trim()) ? null : 'El código son los dígitos que llegaron a tu correo.';
}
