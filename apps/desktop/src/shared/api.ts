/**
 * API que el preload expone a la interfaz en window.radar. La interfaz solo
 * conoce este tipo; nunca accede a Node ni a Electron. Cada función envía un
 * mensaje por un canal de shared/ipc.ts y lanza un Error con el mensaje del
 * proceso principal si algo falla.
 */
import type { AccountState } from './account.js';
import type { ArgsOf, Channel, ResultOf } from './ipc.js';
import type { JobState } from './jobs.js';

type Fn<C extends Channel> = (...args: ArgsOf<C>) => Promise<ResultOf<C>>;

export interface RadarApi {
  account: {
    state: Fn<'account:state'>;
    signIn: Fn<'account:signIn'>;
    signUp: Fn<'account:signUp'>;
    confirmEmail: Fn<'account:confirmEmail'>;
    resendConfirmation: Fn<'account:resendConfirmation'>;
    requestPasswordReset: Fn<'account:requestPasswordReset'>;
    resetPassword: Fn<'account:resetPassword'>;
    setNewPassword: Fn<'account:setNewPassword'>;
    signOut: Fn<'account:signOut'>;
    /** Avisa de cada cambio de la cuenta (también si la sesión caduca). Devuelve la función para dejar de escuchar. */
    onChange: (cb: (state: AccountState) => void) => () => void;
  };
  app: { info: Fn<'app:info'>; openExternal: Fn<'app:openExternal'>; copyText: Fn<'app:copyText'>; storage: Fn<'app:storage'>; clearCache: Fn<'app:clearCache'> };
  projects: { list: Fn<'projects:list'>; addFolder: Fn<'projects:addFolder'>; addGithub: Fn<'projects:addGithub'>; remove: Fn<'projects:remove'> };
  analyses: { list: Fn<'analyses:list'>; report: Fn<'analyses:report'>; compare: Fn<'analyses:compare'> };
  settings: { get: Fn<'settings:get'>; set: Fn<'settings:set'> };
  secrets: { status: Fn<'secrets:status'>; set: Fn<'secrets:set'>; delete: Fn<'secrets:delete'> };
  files: { snippet: Fn<'files:snippet'>; reveal: Fn<'files:reveal'>; savePatch: Fn<'files:savePatch'> };
  ai: {
    explain: Fn<'ai:explain'>;
    models: Fn<'ai:models'>;
    checkKey: Fn<'ai:checkKey'>;
    fixPreview: Fn<'ai:fixPreview'>;
    proposeFix: Fn<'ai:proposeFix'>;
    getFix: Fn<'ai:getFix'>;
  };
  chat: { list: Fn<'chat:list'>; ask: Fn<'chat:ask'>; clear: Fn<'chat:clear'> };
  jobs: {
    start: Fn<'jobs:start'>;
    cancel: Fn<'jobs:cancel'>;
    list: Fn<'jobs:list'>;
    /** Avisa de cada cambio de estado de un análisis. Devuelve la función para dejar de escuchar. */
    onEvent: (cb: (state: JobState) => void) => () => void;
  };
}
