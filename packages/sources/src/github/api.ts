import { HttpError, requestJson, type HttpOptions } from '../http.js';
import type { GitHubRepoRef } from './url.js';

export interface GitHubRepository {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  /** Tamaño aproximado según GitHub, en KB. */
  sizeKb: number;
  archived: boolean;
  pushedAt: string | null;
  language: string | null;
}

export interface TokenCheck {
  kind: 'fine-grained' | 'classic' | 'other';
  login: string;
  /** Avisos de permisos excesivos. */
  warnings: string[];
}

export interface GitHubClientOptions extends HttpOptions {
  token?: string;
  baseUrl?: string;
}

/** Token desde el entorno; nunca se lee de archivos del repositorio ni se guarda en disco. */
export function tokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const t = env['RADAR_GITHUB_TOKEN'] ?? env['GITHUB_TOKEN'] ?? env['GH_TOKEN'];
  return t && t.trim() !== '' ? t.trim() : undefined;
}

/** Ámbitos de tokens clásicos que dan más de lo necesario para leer código. */
const EXCESSIVE_SCOPES = ['repo', 'delete_repo', 'admin:org', 'admin:repo_hook', 'write:packages', 'workflow', 'admin:public_key', 'user'];

/**
 * Cliente de la API REST de GitHub limitado a lo que necesita la aplicación:
 * metadatos del repositorio y verificación del token. Solo lectura.
 */
export class GitHubClient {
  private readonly token: string | undefined;
  private readonly baseUrl: string;
  private readonly http: HttpOptions;

  constructor(options: GitHubClientOptions = {}) {
    const { token, baseUrl = 'https://api.github.com', ...http } = options;
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.http = http;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'radar-deuda',
    };
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }

  private async get<T>(path: string): Promise<{ data: T; headers: Headers }> {
    try {
      return await requestJson<T>(`${this.baseUrl}${path}`, { headers: this.headers() }, this.http);
    } catch (err) {
      throw this.explain(err);
    }
  }

  /** Traduce errores de la API a mensajes accionables, sin incluir el token. */
  private explain(err: unknown): Error {
    if (!(err instanceof HttpError)) return err instanceof Error ? err : new Error(String(err));
    if (err.status === 401) return new Error('El token de GitHub no es válido o ha caducado.', { cause: err });
    const remaining = err.headers.get('x-ratelimit-remaining');
    if ((err.status === 403 || err.status === 429) && remaining === '0') {
      const reset = Number(err.headers.get('x-ratelimit-reset') ?? '0');
      const when = reset ? new Date(reset * 1000).toLocaleTimeString() : 'más tarde';
      const hint = this.token ? '' : ' Sin token el límite es de 60 peticiones por hora; con un token, 5 000.';
      return new Error(`Se alcanzó el límite de peticiones de la API de GitHub; vuelve a intentarlo a las ${when}.${hint}`, { cause: err });
    }
    if (err.status === 404) {
      return new Error(
        this.token
          ? 'El repositorio no existe o el token no tiene acceso a él (revisa que esté incluido en el token fine-grained).'
          : 'El repositorio no existe o es privado. Para repositorios privados define RADAR_GITHUB_TOKEN.',
        { cause: err },
      );
    }
    return new Error(`Error de la API de GitHub (HTTP ${err.status}).`, { cause: err });
  }

  async getRepository(ref: GitHubRepoRef): Promise<GitHubRepository> {
    const { data } = await this.get<{
      full_name: string;
      private: boolean;
      default_branch: string;
      size: number;
      archived: boolean;
      pushed_at: string | null;
      language: string | null;
    }>(`/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`);
    return {
      fullName: data.full_name,
      private: data.private,
      defaultBranch: data.default_branch,
      sizeKb: data.size,
      archived: data.archived,
      pushedAt: data.pushed_at,
      language: data.language,
    };
  }

  /**
   * Comprueba el token y avisa si concede más de lo necesario. Los tokens
   * clásicos devuelven sus ámbitos en `x-oauth-scopes`; los fine-grained no,
   * y son los recomendados (lectura de contenidos y metadatos).
   */
  async checkToken(): Promise<TokenCheck> {
    if (!this.token) throw new Error('No hay token de GitHub configurado.');
    const { data, headers } = await this.get<{ login: string }>('/user');
    const kind = this.token.startsWith('github_pat_') ? 'fine-grained' : this.token.startsWith('ghp_') ? 'classic' : 'other';
    const warnings: string[] = [];
    const scopes = (headers.get('x-oauth-scopes') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const excessive = scopes.filter((s) => EXCESSIVE_SCOPES.includes(s));
    if (excessive.length > 0) {
      warnings.push(`El token tiene permisos de escritura o administración (${excessive.join(', ')}). Usa un token fine-grained con "Contents: Read-only" y "Metadata: Read-only".`);
    } else if (kind === 'classic') {
      warnings.push('Es un token clásico. Se recomienda uno fine-grained limitado a los repositorios que quieras analizar.');
    }
    return { kind, login: data.login, warnings };
  }
}
