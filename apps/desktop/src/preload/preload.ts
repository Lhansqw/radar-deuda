import { contextBridge, ipcRenderer } from 'electron';
import type { RadarApi } from '../shared/api.js';
import type { ArgsOf, Channel, IpcResult, ResultOf } from '../shared/ipc.js';

/**
 * Puente entre la interfaz (sin acceso a Node) y el proceso principal. Solo
 * expone funciones concretas, nunca ipcRenderer ni otros módulos de Electron.
 */
async function invoke<C extends Channel>(channel: C, ...args: ArgsOf<C>): Promise<ResultOf<C>> {
  const r = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<ResultOf<C>>;
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const api: RadarApi = {
  app: {
    info: () => invoke('app:info'),
    openExternal: (url) => invoke('app:openExternal', url),
  },
  projects: {
    list: () => invoke('projects:list'),
    addFolder: () => invoke('projects:addFolder'),
    addGithub: (repo, branch) => invoke('projects:addGithub', repo, branch),
    remove: (id) => invoke('projects:remove', id),
  },
  analyses: {
    list: (projectId) => invoke('analyses:list', projectId),
    report: (analysisId) => invoke('analyses:report', analysisId),
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (settings) => invoke('settings:set', settings),
  },
  secrets: {
    status: () => invoke('secrets:status'),
    set: (name, value) => invoke('secrets:set', name, value),
    delete: (name) => invoke('secrets:delete', name),
  },
};

contextBridge.exposeInMainWorld('radar', api);
