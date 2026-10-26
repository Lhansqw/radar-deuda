import type { Channel, IpcResult } from '../shared/ipc.js';
import { isAppUrl } from '../shared/origin.js';
import type { Handlers } from './handlers.js';
import { VALIDATORS } from './ipc-validation.js';

/**
 * Atiende un mensaje: comprueba que viene de la interfaz de la aplicación,
 * valida los argumentos y devuelve el resultado o el mensaje de error.
 * Separado de Electron para poder probarlo.
 */
export async function dispatch<C extends Channel>(
  channel: C,
  senderUrl: string | undefined,
  args: unknown[],
  handlers: Handlers,
  devServerUrl: string | null,
): Promise<IpcResult<unknown>> {
  if (!isAppUrl(senderUrl, devServerUrl)) return { ok: false, error: 'Remitente no autorizado.' };
  try {
    const parsed = VALIDATORS[channel](args);
    const handler = handlers[channel] as (...a: unknown[]) => unknown;
    return { ok: true, value: await handler(...(parsed as unknown[])) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!(err instanceof Error) || err.name === 'Error' || err.name === 'TypeError') console.error(`[ipc] ${channel}:`, err);
    return { ok: false, error: message };
  }
}
