import { contextBridge, ipcRenderer } from 'electron';
import type { RadarApi } from '../shared/api.js';
import { JOB_EVENT_CHANNEL, type ArgsOf, type Channel, type IpcResult, type ResultOf } from '../shared/ipc.js';
import type { JobState } from '../shared/jobs.js';

/**
 * Puente entre la interfaz (sin acceso a Node) y el proceso principal. Solo
 * expone funciones concretas, nunca ipcRenderer ni otros módulos de Electron.
 * Con sandbox, el preload solo puede cargar 'electron': esbuild empaqueta
 * aquí el código compartido que importa.
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
    compare: (beforeId, afterId) => invoke('analyses:compare', beforeId, afterId),
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
  files: {
    snippet: (analysisId, file, start, end) => invoke('files:snippet', analysisId, file, start, end),
    reveal: (analysisId, file) => invoke('files:reveal', analysisId, file),
  },
  ai: {
    explain: (analysisId, findingId) => invoke('ai:explain', analysisId, findingId),
    models: () => invoke('ai:models'),
    checkKey: () => invoke('ai:checkKey'),
  },
  jobs: {
    start: (projectId) => invoke('jobs:start', projectId),
    cancel: (jobId) => invoke('jobs:cancel', jobId),
    list: () => invoke('jobs:list'),
    onEvent: (cb) => {
      // Solo se entrega el estado, nunca el objeto del evento de Electron.
      const listener = (_event: unknown, state: JobState): void => cb(state);
      ipcRenderer.on(JOB_EVENT_CHANNEL, listener);
      return () => {
        ipcRenderer.removeListener(JOB_EVENT_CHANNEL, listener);
      };
    },
  },
};

contextBridge.exposeInMainWorld('radar', api);
