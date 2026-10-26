import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { CHANNELS } from '../shared/ipc.js';
import type { Handlers } from './handlers.js';
import { dispatch } from './ipc-dispatch.js';

export function registerIpc(handlers: Handlers, devServerUrl: string | null): void {
  for (const channel of CHANNELS) {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => dispatch(channel, event.senderFrame?.url, args, handlers, devServerUrl));
  }
}
