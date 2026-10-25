export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

/** Reglas de GitHub: usuario/organización de 1–39 caracteres, sin guiones al inicio. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Interpreta una referencia a un repositorio de GitHub. Acepta
 * `owner/repo`, `github:owner/repo`, `https://github.com/owner/repo[.git][/…]`
 * y `git@github.com:owner/repo.git`. Devuelve null si no es válida: el
 * resultado solo contiene caracteres permitidos, así que es seguro usarlo
 * para construir URLs y nombres de carpeta.
 */
export function parseGitHubRepo(input: string): GitHubRepoRef | null {
  const s = input.trim();
  let path: string | undefined;
  if (/^github:/i.test(s)) path = s.slice('github:'.length);
  else if (/^git@github\.com:/i.test(s)) path = s.slice('git@github.com:'.length);
  else if (/^https?:\/\//i.test(s)) {
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      return null;
    }
    if (url.hostname.toLowerCase() !== 'github.com' && url.hostname.toLowerCase() !== 'www.github.com') return null;
    if (url.username || url.password) return null; // nunca credenciales en la URL
    path = url.pathname.slice(1);
  } else if (/^[^/\\:]+\/[^/\\:]+$/.test(s)) path = s;
  if (!path) return null;

  const [owner, rawRepo] = path.split('/');
  if (!owner || !rawRepo) return null;
  const repo = rawRepo.replace(/\.git$/i, '');
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo };
}

export function cloneUrl(ref: GitHubRepoRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}.git`;
}

export function webUrl(ref: GitHubRepoRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}`;
}
