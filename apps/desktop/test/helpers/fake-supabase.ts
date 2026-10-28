import { randomUUID } from 'node:crypto';
import { FakePostgrest } from './fake-postgrest.js';

/**
 * Supabase Auth simulado (la parte de su API HTTP que usa la aplicación):
 * registro, inicio de sesión, códigos de confirmación y de recuperación,
 * cambio de contraseña, renovación y cierre de sesión. Se pasa como `fetch`
 * a AccountService. Los códigos son siempre los de CODES.
 */
export const CODES = { signup: '123456', recovery: '654321' } as const;
export const FAKE_URL = 'https://prueba.supabase.co';
export const FAKE_KEY = 'sb_publishable_prueba_0123456789';

interface FakeUser {
  id: string;
  email: string;
  password: string;
  confirmed: boolean;
}

interface FakeRequest {
  body: Record<string, unknown>;
  headers: Headers;
  email: string;
  password: string;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

export interface FakeSupabaseOptions {
  /** El proyecto pide confirmar el correo al registrarse (lo normal en Supabase). */
  confirmEmail?: boolean;
  /** Longitud mínima de contraseña que exige el servidor. */
  minPassword?: number;
}

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

export class FakeSupabase {
  readonly users = new Map<string, FakeUser>();
  readonly requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  private readonly refresh = new Map<string, string>();
  private readonly access = new Map<string, string>();
  private readonly codes = new Map<string, { type: 'signup' | 'recovery'; code: string }>();
  /** Sin conexión: cada petición falla como si no hubiera red. */
  offline = false;
  /** Si devuelve true, la petición se atiende pero la respuesta «se pierde» por la red (una sola vez por llamada). */
  loseResponse: ((method: string, path: string) => boolean) | null = null;
  /** La base de datos (las tablas de supabase/migrations), con las reglas de cada usuario. */
  readonly db = new FakePostgrest((headers) => this.bearer(headers)?.id);
  /** Duración de los tokens de acceso que emite (segundos). */
  expiresIn = 3600;

  constructor(private readonly options: FakeSupabaseOptions = {}) {}

  addUser(email: string, password: string, confirmed = true): FakeUser {
    const user = { id: randomUUID(), email, password, confirmed };
    this.users.set(email, user);
    return user;
  }

  /** Revoca todas las sesiones (como si caducaran o se cerraran desde otro equipo). */
  revokeAll(): void {
    this.refresh.clear();
    this.access.clear();
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (this.offline) throw new TypeError('fetch failed');
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const grant = url.searchParams.get('grant_type');
    const route = `${method} ${url.pathname}${grant ? `?${grant}` : ''}`;
    this.requests.push({ method, path: url.pathname, body });
    const headers = new Headers(init?.headers);
    if (headers.get('apikey') !== FAKE_KEY) return json({ message: 'Invalid API key' }, 401);
    if (url.pathname.startsWith('/rest/v1/')) {
      const response = this.db.handle(url, method, headers, body);
      if (this.loseResponse?.(method, url.pathname)) throw new TypeError('fetch failed');
      return response;
    }
    const handler = this.routes[route];
    if (!handler) return json({ message: `Ruta no simulada: ${route}` }, 404);
    return handler({ body, headers, email: text(body['email']), password: text(body['password']) });
  };

  /** Cada ruta de la API de Supabase Auth que usa la aplicación. */
  private readonly routes: Record<string, (r: FakeRequest) => Response> = {
    'POST /auth/v1/signup': (r) => this.signUp(r.email, r.password),
    'POST /auth/v1/token?password': (r) => {
      const u = this.users.get(r.email);
      if (!u || u.password !== r.password) return error('invalid_credentials', 400);
      return u.confirmed ? json(this.session(u)) : error('email_not_confirmed', 400);
    },
    'POST /auth/v1/token?refresh_token': (r) => {
      const u = this.byId(this.refresh.get(text(r.body['refresh_token'])));
      return u ? json(this.session(u)) : error('refresh_token_not_found', 400);
    },
    'POST /auth/v1/verify': (r) => this.verify(r),
    'POST /auth/v1/resend': (r) => {
      this.codes.set(r.email, { type: 'signup', code: CODES.signup });
      return json({});
    },
    'POST /auth/v1/recover': (r) => {
      if (this.users.has(r.email)) this.codes.set(r.email, { type: 'recovery', code: CODES.recovery });
      return json({});
    },
    'PUT /auth/v1/user': (r) => this.updatePassword(r),
    'GET /auth/v1/user': (r) => {
      const u = this.bearer(r.headers);
      return u ? json(publicUser(u)) : error('session_not_found', 403);
    },
    'POST /auth/v1/logout': (r) => {
      this.access.delete(r.headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
      return new Response(null, { status: 204 });
    },
  };

  private verify(r: FakeRequest): Response {
    const pending = this.codes.get(r.email);
    const type = r.body['type'] === 'recovery' ? 'recovery' : 'signup';
    const u = this.users.get(r.email);
    if (!u || pending?.type !== type || pending.code !== r.body['token']) return error('otp_expired', 403);
    this.codes.delete(r.email);
    u.confirmed = true;
    return json(this.session(u));
  }

  private updatePassword(r: FakeRequest): Response {
    const u = this.bearer(r.headers);
    if (!u) return error('session_not_found', 403);
    if (r.password === u.password) return error('same_password', 422);
    if (r.password.length < (this.options.minPassword ?? 6)) return json({ error_code: 'weak_password', msg: 'Password is too weak', weak_password: { reasons: ['length'] } }, 422);
    u.password = r.password;
    return json(publicUser(u));
  }

  private byId(id: string | undefined): FakeUser | undefined {
    return [...this.users.values()].find((u) => u.id === id);
  }

  private signUp(email: string, password: string): Response {
    const existing = this.users.get(email);
    if (this.options.confirmEmail === false) {
      if (existing) return error('user_already_exists', 422);
      return json(this.session(this.addUser(email, password, true)));
    }
    // Con confirmación, Supabase no dice si la cuenta ya existía: responde igual.
    const u = existing ?? this.addUser(email, password, false);
    if (!u.confirmed) this.codes.set(email, { type: 'signup', code: CODES.signup });
    return json({ ...publicUser(u), identities: existing ? [] : [{ provider: 'email' }] });
  }

  private session(u: FakeUser): object {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: u.id, email: u.email, role: 'authenticated', exp: now + this.expiresIn })}.firma`;
    const refreshToken = randomUUID();
    this.access.set(accessToken, u.id);
    this.refresh.set(refreshToken, u.id);
    return { access_token: accessToken, token_type: 'bearer', expires_in: this.expiresIn, expires_at: now + this.expiresIn, refresh_token: refreshToken, user: publicUser(u) };
  }

  private bearer(headers: Headers): FakeUser | undefined {
    return this.byId(this.access.get(headers.get('authorization')?.replace(/^Bearer /, '') ?? ''));
  }
}

function publicUser(u: FakeUser): object {
  return { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: u.confirmed ? new Date().toISOString() : null, app_metadata: { provider: 'email' }, user_metadata: {}, created_at: new Date().toISOString() };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function error(code: string, status: number): Response {
  return json({ code: status, error_code: code, msg: code }, status);
}
