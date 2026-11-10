import { CHANNELS, PUBLIC_CHANNELS, type AccountChannel, type Channel } from '../shared/ipc.js';
import type { LanguageSetting } from '../shared/settings.js';
import type { AccountService } from './account-service.js';
import type { ThemeSetting } from '../shared/settings.js';
import { errorHandlers, type HandlerDeps, type Handlers, type WorkspaceHandlers } from './handlers.js';
import { tr } from './i18n.js';

/** Lo que los canales de la cuenta necesitan del servicio (se sustituye en las pruebas). */
export type AccountApi = Pick<
  AccountService,
  'state' | 'signIn' | 'signUp' | 'resendConfirmation' | 'requestPasswordReset' | 'resetPassword' | 'setNewPassword' | 'signOut'
>;

export class SignedOutError extends Error {
  constructor() {
    super(tr('Inicia sesión para continuar.', 'Sign in to continue.'));
    this.name = 'SignedOutError';
  }
}

export function createAccountHandlers(account: AccountApi): Pick<Handlers, AccountChannel> {
  return {
    'account:state': () => account.state(),
    'account:signIn': (email, password, remember) => account.signIn(email, password, remember),
    'account:signUp': (email, password) => account.signUp(email, password),
    'account:resendConfirmation': (email) => account.resendConfirmation(email),
    'account:requestPasswordReset': (email) => account.requestPasswordReset(email),
    'account:resetPassword': (email, code, password) => account.resetPassword(email, code, password),
    'account:setNewPassword': (password) => account.setNewPassword(password),
    'account:signOut': () => account.signOut(),
  };
}

/** Manejadores con sesión: los del espacio de trabajo del usuario más los de la cuenta. */
export function signedInHandlers(workspace: WorkspaceHandlers, account: Pick<Handlers, AccountChannel>): Handlers {
  return { ...workspace, ...account };
}

/**
 * Manejadores sin sesión: la cuenta, la versión de la aplicación, el tema, el diagnóstico y abrir
 * enlaces. Cualquier otro canal responde «Inicia sesión para continuar»; no
 * hay base de datos abierta a la que llegar.
 */
export function signedOutHandlers(
  account: Pick<Handlers, AccountChannel>,
  app: Pick<HandlerDeps, 'info' | 'openExternal' | 'setLanguage' | 'theme' | 'setTheme' | 'diagnostics' | 'clearErrors' | 'reportError'>,
): Handlers {
  const open: Partial<Record<Channel, unknown>> = {
    ...account,
    'app:info': () => app.info(),
    'app:openExternal': (url: string) => app.openExternal(url),
    'app:setLanguage': (language: LanguageSetting) => app.setLanguage(language),
    'app:theme': () => app.theme(),
    'app:setTheme': (theme: ThemeSetting) => app.setTheme(theme),
    ...errorHandlers(app),
  };
  const locked = () => {
    throw new SignedOutError();
  };
  return Object.fromEntries(CHANNELS.map((c) => [c, PUBLIC_CHANNELS.includes(c) ? open[c] : locked])) as Handlers;
}
