import { randomUUID } from 'node:crypto';

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
    const route = `${method} ${url.pathname}${url.searchParams.get('grant_type') ? `?${url.searchParams.get('grant_type')}` : ''}`;
    this.requests.push({ method, path: url.pathname, body });
    const headers = new Headers(init?.headers);
    if (headers.get('apikey') !== FAKE_KEY) return json({ message: 'Invalid API key' }, 401);
    const email = typeof body['email'] === 'string' ? body['email'] : '';
    const password = typeof body['password'] === 'string' ? body['password'] : '';
    switch (route) {
      case 'POST /auth/v1/signup':
        return this.signUp(email, password);
      case 'POST /auth/v1/token?password': {
        const u = this.users.get(email);
        if (!u || u.password !== password) return error('invalid_credentials', 400);
        if (!u.confirmed) return error('email_not_confirmed', 400);
        return json(this.session(u));
      }
      case 'POST /auth/v1/token?refresh_token': {
        const id = this.refresh.get(String(body['refresh_token']));
        const u = [...this.users.values()].find((x) => x.id === id);
        if (!u) return error('refresh_token_not_found', 400);
        return json(this.session(u));
      }
      case 'POST /auth/v1/verify': {
        const pending = this.codes.get(email);
        const type = body['type'] === 'recovery' ? 'recovery' : 'signup';
        const u = this.users.get(email);
        if (!u || pending?.type !== type || pending.code !== body['token']) return error('otp_expired', 403);
        this.codes.delete(email);
        u.confirmed = true;
        return json(this.session(u));
      }
      case 'POST /auth/v1/resend':
        this.codes.set(email, { type: 'signup', code: CODES.signup });
        return json({});
      case 'POST /auth/v1/recover':
        if (this.users.has(email)) this.codes.set(email, { type: 'recovery', code: CODES.recovery });
        return json({});
      case 'PUT /auth/v1/user': {
        const u = this.bearer(headers);
        if (!u) return error('session_not_found', 403);
        if (password === u.password) return error('same_password', 422);
        if (password.length < (this.options.minPassword ?? 6)) return json({ error_code: 'weak_password', msg: 'Password is too weak', weak_password: { reasons: ['length'] } }, 422);
        u.password = password;
        return json(publicUser(u));
      }
      case 'GET /auth/v1/user': {
        const u = this.bearer(headers);
        return u ? json(publicUser(u)) : error('session_not_found', 403);
      }
      case 'POST /auth/v1/logout': {
        const token = headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
        this.access.delete(token);
        return new Response(null, { status: 204 });
      }
      default:
        return json({ message: `Ruta no simulada: ${route}` }, 404);
    }
  };

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
    const id = this.access.get(headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
    return [...this.users.values()].find((u) => u.id === id);
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
