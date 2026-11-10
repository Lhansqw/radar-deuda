import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import type { RadarApi } from '../../src/shared/api.js';
import type { AppInfo } from '../../src/shared/ipc.js';

/** Lo que una prueba simula de window.radar: solo las funciones que la vista necesita. */
export type RadarOverrides = { [K in keyof RadarApi]?: Partial<RadarApi[K]> };

/** Nunca se resuelve: lo que una prueba no simula se queda «cargando», sin errores sin capturar. */
const pending = (): Promise<never> => new Promise<never>(() => undefined);

/**
 * Sustituye window.radar (la API del preload) por un doble. Lo no simulado
 * queda pendiente para siempre y las suscripciones (`onChange`, `onEvent`) no
 * avisan nunca: así cada prueba declara exactamente qué datos ve la vista.
 */
export function mockRadar(overrides: RadarOverrides = {}): RadarApi {
  const api = new Proxy({} as RadarApi, {
    get: (_, ns: string) =>
      new Proxy(
        {},
        {
          get: (__, fn: string) => {
            const own = (overrides as Record<string, Record<string, unknown> | undefined>)[ns]?.[fn];
            if (own) return own;
            return fn.startsWith('on') ? () => () => undefined : pending;
          },
        },
      ),
  });
  Object.defineProperty(window, 'radar', { value: api, configurable: true });
  return api;
}

export const APP_INFO: AppInfo = {
  versions: { app: '0.1.0', electron: '45.2.3', chrome: '146', node: '24' },
  dataDir: 'C:/datos',
  cacheDir: 'C:/cache',
  reposDir: 'C:/cache/repos',
};

afterEach(() => cleanup());
