import { CHANNELS, PUBLIC_CHANNELS, type AccountChannel, type Channel } from '../shared/ipc.js';
import type { AccountService } from './account-service.js';
import type { HandlerDeps, Handlers, WorkspaceHandlers } from './handlers.js';

/** Lo que los canales de la cuenta necesitan del servicio (se sustituye en las pruebas). */
export type AccountApi = Pick<
  AccountService,
  'state' | 'signIn' | 'signUp' | 'confirmEmail' | 'resendConfirmation' | 'requestPasswordReset' | 'resetPassword' | 'setNewPassword' | 'signOut'
>;

export class SignedOutError extends Error {
  constructor() {
    super('Inicia sesión para continuar.');
    this.name = 'SignedOutError';
  }
}

export function createAccountHandlers(account: AccountApi): Pick<Handlers, AccountChannel> {
  return {
    'account:state': () => account.state(),
    'account:signIn': (email, password, remember) => account.signIn(email, password, remember),
    'account:signUp': (email, password) => account.signUp(email, password),
    'account:confirmEmail': (email, code) => account.confirmEmail(email, code),
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
 * Manejadores sin sesión: la cuenta, la versión de la aplicación y abrir
 * enlaces. Cualquier otro canal responde «Inicia sesión para continuar»; no
 * hay base de datos abierta a la que llegar.
 */
export function signedOutHandlers(account: Pick<Handlers, AccountChannel>, app: Pick<HandlerDeps, 'info' | 'openExternal'>): Handlers {
  const open: Partial<Record<Channel, unknown>> = { ...account, 'app:info': () => app.info(), 'app:openExternal': (url: string) => app.openExternal(url) };
  const locked = () => {
    throw new SignedOutError();
  };
  return Object.fromEntries(CHANNELS.map((c) => [c, PUBLIC_CHANNELS.includes(c) ? open[c] : locked])) as Handlers;
}
