/**
 * API que el preload expone a la interfaz en window.radar. La interfaz solo
 * conoce este tipo; nunca accede a Node ni a Electron. Cada función envía un
 * mensaje por un canal de shared/ipc.ts y lanza un Error con el mensaje del
 * proceso principal si algo falla.
 */
import type { ArgsOf, Channel, ResultOf } from './ipc.js';
import type { JobState } from './jobs.js';

type Fn<C extends Channel> = (...args: ArgsOf<C>) => Promise<ResultOf<C>>;

export interface RadarApi {
  app: { info: Fn<'app:info'>; openExternal: Fn<'app:openExternal'> };
  projects: { list: Fn<'projects:list'>; addFolder: Fn<'projects:addFolder'>; addGithub: Fn<'projects:addGithub'>; remove: Fn<'projects:remove'> };
  analyses: { list: Fn<'analyses:list'>; report: Fn<'analyses:report'>; compare: Fn<'analyses:compare'> };
  settings: { get: Fn<'settings:get'>; set: Fn<'settings:set'> };
  secrets: { status: Fn<'secrets:status'>; set: Fn<'secrets:set'>; delete: Fn<'secrets:delete'> };
  files: { snippet: Fn<'files:snippet'>; reveal: Fn<'files:reveal'> };
  jobs: {
    start: Fn<'jobs:start'>;
    cancel: Fn<'jobs:cancel'>;
    list: Fn<'jobs:list'>;
    /** Avisa de cada cambio de estado de un análisis. Devuelve la función para dejar de escuchar. */
    onEvent: (cb: (state: JobState) => void) => () => void;
  };
}
