import type { RadarApi } from '../../shared/api.js';

/** Mismos límites que valida el proceso principal (ipc-validation.ts). */
const MAX_MESSAGE = 5000;
const MAX_STACK = 20_000;

/** Mensaje y pila de cualquier cosa que se lance (un Error, un texto, un objeto…). */
export function describeError(err: unknown): { message: string; stack: string | null } {
  const e = err instanceof Error ? err : null;
  const message = (e ? `${e.name === 'Error' ? '' : `${e.name}: `}${e.message}` : String(err)).trim() || 'Error sin mensaje';
  return { message: message.slice(0, MAX_MESSAGE), stack: e?.stack ? e.stack.slice(0, MAX_STACK) : null };
}

/**
 * Envía al registro local de errores (proceso principal) los errores sin
 * capturar de la interfaz. React 19 también los pasa por el evento `error` de
 * la ventana. Si el envío falla, no hay nada más que hacer: no se reintenta.
 */
export function reportErrors(target: Window, api: Pick<RadarApi['app'], 'reportError'>): void {
  const send = (err: unknown): void => {
    const { message, stack } = describeError(err);
    void api.reportError(message, stack).catch(() => undefined);
  };
  target.addEventListener('error', (e) => send(e.error ?? e.message));
  target.addEventListener('unhandledrejection', (e) => send(e.reason));
}
