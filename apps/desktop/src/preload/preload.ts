import { contextBridge } from 'electron';
import type { RadarApi } from '../shared/api.js';

/**
 * Puente entre la interfaz (sin acceso a Node) y el proceso principal. Solo
 * expone funciones concretas, nunca ipcRenderer ni otros módulos de Electron.
 */
const api: RadarApi = {
  versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
};

contextBridge.exposeInMainWorld('radar', api);
