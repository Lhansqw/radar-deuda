import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { CHANNELS } from '../shared/ipc.js';
import type { Handlers } from './handlers.js';
import { dispatch } from './ipc-dispatch.js';

/**
 * `handlers` se consulta en cada mensaje: cambian al iniciar o cerrar sesión.
 * `onUnexpected`: errores que no son de validación ni previstos (van al registro de errores).
 */
export function registerIpc(handlers: () => Handlers, devServerUrl: string | null, onUnexpected?: (channel: string, err: unknown) => void): void {
  for (const channel of CHANNELS) {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => dispatch(channel, event.senderFrame?.url, args, handlers(), { devServerUrl, ...(onUnexpected ? { onUnexpected } : {}) }));
  }
}
