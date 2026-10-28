import { createClient, type Session, type SupabaseClient, type User } from '@supabase/supabase-js';
import { emailProblem, newPasswordProblem, normalizeEmail, type AccountState, type SignUpResult } from '../shared/account.js';
import { AccountError, accountError, isOfflineError } from './account-errors.js';
import type { CloudConfigResult } from './cloud-config.js';
import type { Database } from './cloud-schema.js';
import type { EncryptedSessionStorage } from './session-storage.js';

/** Clave con la que Supabase Auth guarda la sesión en EncryptedSessionStorage. */
export const SESSION_KEY = 'radar-deuda-sesion';

/** Identificadores de usuario de Supabase (UUID): dan nombre a su carpeta de datos. */
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface SignedInUser {
  id: string;
  email: string;
}

/** Lo que el proceso principal necesita saber en cada cambio: el estado y, con sesión, de quién es. */
export interface AccountChange {
  state: AccountState;
  user: SignedInUser | null;
}

export interface AccountServiceDeps {
  config: CloudConfigResult;
  storage: EncryptedSessionStorage;
  onChange: (change: AccountChange) => void;
  /** Para las pruebas; por defecto, el fetch global en el momento de cada petición. */
  fetch?: typeof fetch;
  /** Reintentar las lecturas de la base de datos que fallan por la red (por defecto sí; las pruebas no esperan). */
  retryReads?: boolean;
}

/**
 * Cuentas de usuario con Supabase Auth (correo y contraseña), en el proceso
 * principal. La interfaz solo recibe AccountState: nunca los tokens.
 *
 * Una aplicación de escritorio no puede abrir los enlaces de los correos de
 * Supabase, así que la confirmación del registro y la recuperación de la
 * contraseña usan el código de un solo uso de esos correos ({{ .Token }} en
 * las plantillas, ver docs/CUENTAS.md).
 */
export class AccountService {
  private readonly client: SupabaseClient<Database> | null;
  private current: AccountChange;
  private readonly ready: Promise<void>;
  private validation: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly d: AccountServiceDeps) {
    if (d.config.ok) {
      const fetchNow = d.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
      this.client = createClient<Database>(d.config.config.url, d.config.config.publishableKey, {
        auth: { storage: d.storage, storageKey: SESSION_KEY, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
        global: { fetch: fetchNow },
        db: { retry: d.retryReads ?? true },
      });
      this.current = { state: { status: 'signed-out' }, user: null };
    } else {
      this.client = null;
      this.current = { state: { status: 'unconfigured', message: d.config.message }, user: null };
    }
    this.ready = this.restore();
  }

  /** Estado actual, después de recuperar la sesión guardada (si la había). */
  async state(): Promise<AccountState> {
    await this.ready;
    return this.current.state;
  }

  /** Usuario con la sesión iniciada, o null. */
  async user(): Promise<SignedInUser | null> {
    await this.ready;
    return this.current.user;
  }

  /**
   * La base de datos de la nube con la sesión del usuario (sus peticiones
   * llevan su token y las políticas de seguridad por filas lo identifican), o
   * null sin sesión iniciada.
   */
  async database(): Promise<SupabaseClient<Database> | null> {
    await this.ready;
    return this.current.state.status === 'signed-in' ? this.client : null;
  }

  /**
   * Inicia sesión. Con `remember`, la sesión sobrevive al cierre de la
   * aplicación (cifrada). Si la cuenta aún no confirmó su correo, no es un
   * error: hay que pedir el código.
   */
  async signIn(email: string, password: string, remember: boolean): Promise<SignUpResult> {
    const auth = await this.auth();
    this.d.storage.setPersist(remember);
    const { data, error } = await auth.signInWithPassword({ email: normalizeEmail(email), password });
    if (error) {
      if (error.code === 'email_not_confirmed') return { confirmEmail: true };
      throw accountError(error);
    }
    this.signedIn(data.user, email, false);
    return { confirmEmail: false };
  }

  /** Crea la cuenta. Si el proyecto pide confirmar el correo, Supabase envía un código. */
  async signUp(email: string, password: string): Promise<SignUpResult> {
    check(emailProblem(email) ?? newPasswordProblem(password));
    const auth = await this.auth();
    this.d.storage.setPersist(true);
    const { data, error } = await auth.signUp({ email: normalizeEmail(email), password });
    if (error) throw accountError(error);
    if (data.session) {
      this.signedIn(data.session.user, email, false);
      return { confirmEmail: false };
    }
    return { confirmEmail: true };
  }

  /** Confirma el correo con el código del mensaje de Supabase y entra. */
  async confirmEmail(email: string, code: string): Promise<AccountState> {
    const auth = await this.auth();
    this.d.storage.setPersist(true);
    const { data, error } = await auth.verifyOtp({ email: normalizeEmail(email), token: code.trim(), type: 'email' });
    if (error || !data.session) throw accountError(error ?? new AccountError('Supabase no devolvió ninguna sesión.'));
    this.signedIn(data.session.user, email, false);
    return this.current.state;
  }

  /** Vuelve a enviar el código de confirmación del registro. */
  async resendConfirmation(email: string): Promise<null> {
    const auth = await this.auth();
    const { error } = await auth.resend({ type: 'signup', email: normalizeEmail(email) });
    if (error) throw accountError(error);
    return null;
  }

  /** Pide el código para elegir una contraseña nueva. Supabase no dice si la cuenta existe. */
  async requestPasswordReset(email: string): Promise<null> {
    const auth = await this.auth();
    const { error } = await auth.resetPasswordForEmail(normalizeEmail(email));
    if (error) throw accountError(error);
    return null;
  }

  /**
   * Comprueba el código de recuperación y cambia la contraseña. Si el código
   * vale pero Supabase rechaza la contraseña (p. ej. por débil), el estado
   * pasa a 'password-reset' para elegir otra sin pedir un código nuevo.
   */
  async resetPassword(email: string, code: string, password: string): Promise<AccountState> {
    check(newPasswordProblem(password));
    const auth = await this.auth();
    // La sesión de recuperación no se guarda en el disco hasta tener la contraseña nueva.
    this.d.storage.setPersist(false);
    const { data, error } = await auth.verifyOtp({ email: normalizeEmail(email), token: code.trim(), type: 'recovery' });
    if (error || !data.session) throw accountError(error ?? new AccountError('Supabase no devolvió ninguna sesión.'));
    this.set({ state: { status: 'password-reset', email: normalizeEmail(email) }, user: null });
    return this.setNewPassword(password);
  }

  /** Contraseña nueva tras un código de recuperación válido. */
  async setNewPassword(password: string): Promise<AccountState> {
    check(newPasswordProblem(password));
    const auth = await this.auth();
    const state = this.current.state;
    if (state.status !== 'password-reset') throw new AccountError('Primero escribe el código de recuperación que llegó a tu correo.');
    const { data, error } = await auth.updateUser({ password });
    if (error) throw accountError(error);
    this.d.storage.setPersist(true);
    this.signedIn(data.user, state.email, false);
    return this.current.state;
  }

  /**
   * Cierra la sesión en este equipo (las de otros equipos siguen abiertas).
   * Sin conexión, se olvida aquí igualmente.
   */
  async signOut(): Promise<AccountState> {
    const auth = await this.auth();
    await auth.signOut({ scope: 'local' }).catch(() => undefined);
    this.d.storage.clear();
    this.set({ state: { status: 'signed-out' }, user: null });
    return this.current.state;
  }

  /** Al cerrar la aplicación: detiene la renovación automática de la sesión. */
  dispose(): void {
    this.unsubscribe?.();
    void this.client?.auth.stopAutoRefresh();
  }

  /** Termina la comprobación con Supabase de la sesión guardada (para las pruebas). */
  async settled(): Promise<void> {
    await this.ready;
    await this.validation;
  }

  /**
   * Recupera la sesión guardada sin esperar a la red: la aplicación abre al
   * instante con los datos de este equipo, también sin conexión. Después
   * se comprueba con Supabase (validate).
   */
  private async restore(): Promise<void> {
    if (!this.client) return;
    const stored = storedUser(await this.d.storage.getItem(SESSION_KEY));
    if (stored) this.set({ state: { status: 'signed-in', email: stored.email, offline: false }, user: stored });
    this.watch(this.client.auth);
    this.validation = this.validate(this.client.auth, stored);
  }

  /** Cambios que no inicia el usuario: la sesión caduca o se revoca, o vuelve la conexión. */
  private watch(auth: SupabaseClient<Database>['auth']): void {
    const { data } = auth.onAuthStateChange((event, session) => {
      try {
        if (event === 'SIGNED_OUT' && this.current.state.status === 'signed-in') this.set({ state: { status: 'signed-out' }, user: null });
        if ((event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') && session && this.current.state.status === 'signed-in') this.signedIn(session.user, '', false);
      } catch {
        /* un usuario no válido se ignora: la sesión actual sigue igual */
      }
    });
    this.unsubscribe = () => data.subscription.unsubscribe();
  }

  /**
   * Renueva la sesión guardada si hace falta. Si Supabase la rechaza
   * (caducada, revocada o contraseña cambiada en otro equipo), se cierra; sin
   * conexión sigue valiendo y se marca como tal hasta que vuelva la red
   * (Supabase Auth reintenta solo).
   */
  private async validate(auth: SupabaseClient<Database>['auth'], stored: SignedInUser | null): Promise<void> {
    const { data, error } = await auth.getSession().catch((err: unknown) => ({ data: { session: null as Session | null }, error: err }));
    // Solo si mientras tanto nadie inició ni cerró otra sesión.
    if (stored && this.current.user?.id === stored.id) {
      if (data.session) this.signedIn(data.session.user, stored.email, false);
      else if (error && isOfflineError(error)) this.set({ state: { status: 'signed-in', email: stored.email, offline: true }, user: stored });
      else this.set({ state: { status: 'signed-out' }, user: null });
    }
  }

  private async auth(): Promise<SupabaseClient<Database>['auth']> {
    await this.ready;
    if (!this.client) throw new AccountError(this.current.state.status === 'unconfigured' ? this.current.state.message : 'Falta la conexión con Supabase.');
    return this.client.auth;
  }

  private signedIn(user: User | null, fallbackEmail: string, offline: boolean): void {
    if (!user || !USER_ID.test(user.id)) throw new AccountError('Supabase devolvió un usuario no válido.');
    const email = user.email ?? (normalizeEmail(fallbackEmail) || (this.current.user?.email ?? ''));
    this.set({ state: { status: 'signed-in', email, offline }, user: { id: user.id, email } });
  }

  private set(next: AccountChange): void {
    const before = this.current;
    this.current = next;
    if (JSON.stringify(before) !== JSON.stringify(next)) this.d.onChange(next);
  }
}

function check(problem: string | null): void {
  if (problem) throw new AccountError(problem);
}

/** Usuario de una sesión guardada (para trabajar sin conexión). */
function storedUser(raw: string | null): SignedInUser | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as { user?: { id?: unknown; email?: unknown } };
    const id = s.user?.id;
    const email = s.user?.email;
    return typeof id === 'string' && USER_ID.test(id) && typeof email === 'string' ? { id, email } : null;
  } catch {
    return null;
  }
}
