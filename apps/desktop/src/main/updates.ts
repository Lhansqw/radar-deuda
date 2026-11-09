import { HttpError, requestJson, type FetchLike } from '@radar/sources';
import type { UpdateInfo } from '../shared/model.js';

/*
 * Aviso de versiones nuevas. Sin instaladores firmados, la aplicación no
 * descarga ni instala nada por su cuenta: solo consulta la última versión
 * publicada en GitHub Releases y, si es más reciente, enlaza a su página para
 * que el usuario la descargue. La consulta no lleva datos del usuario.
 */

export const RELEASES_REPO = 'Lhansqw/radar-deuda';
const LATEST_URL = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
/** Solo se enlaza a páginas de versiones de este repositorio. */
const RELEASE_PAGE = new RegExp(`^https://github\\.com/${RELEASES_REPO.replace('/', '\\/')}/releases/tag/[\\w.-]+$`);

/** «v1.2.3» o «1.2.3» → [1, 2, 3]; null si no es una versión estable. */
export function parseVersion(text: string): [number, number, number] | null {
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return false;
}

interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

/** Compara la versión instalada con la última publicada. Sin versiones publicadas, `latest` es null. */
export async function checkForUpdate(current: string, fetchImpl?: FetchLike): Promise<UpdateInfo> {
  const none: UpdateInfo = { current, latest: null, url: null, newer: false };
  let release: GitHubRelease;
  try {
    const r = await requestJson<GitHubRelease>(
      LATEST_URL,
      { headers: { accept: 'application/vnd.github+json', 'user-agent': 'radar-deuda' } },
      { timeoutMs: 10_000, retries: 1, maxBytes: 512 * 1024, ...(fetchImpl ? { fetch: fetchImpl } : {}) },
    );
    release = r.data;
  } catch (err) {
    // 404: el repositorio aún no tiene versiones publicadas.
    if (err instanceof HttpError && err.status === 404) return none;
    throw err;
  }
  const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
  const url = typeof release.html_url === 'string' && RELEASE_PAGE.test(release.html_url) ? release.html_url : null;
  if (release.draft === true || release.prerelease === true || !parseVersion(tag) || !url) return none;
  const latest = tag.replace(/^v/, '');
  return { current, latest, url, newer: isNewer(latest, current) };
}
