/// <reference types="vite/client" />
import type { RadarApi } from '../shared/api.js';

declare global {
  interface Window {
    /** API expuesta por el preload (ver src/preload/preload.ts). */
    readonly radar: RadarApi;
  }
}
