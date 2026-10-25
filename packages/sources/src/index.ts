/**
 * Fuentes con efectos externos (procesos Git, red). Separadas del motor para
 * que este siga siendo determinista, sin red y fácil de probar.
 */
export { runGit, GitError, hardenedArgs, sanitizedEnv, HARDENING_CONFIG, type GitRunOptions } from './git/run.js';
export { getRepoInfo, stripCredentials, type RepoInfo } from './git/local.js';
export { changedFiles, fileChurn, resolveCommit, unquoteGitPath, type ChangedFile, type ChangeStatus, type ChurnOptions, type FileChurn } from './git/history.js';
export { computeHotspots, type HotspotOptions } from './git/hotspots.js';
export { requestJson, requestText, HttpError, type FetchLike, type HttpOptions } from './http.js';
export { parseGitHubRepo, cloneUrl, webUrl, type GitHubRepoRef } from './github/url.js';
export { GitHubClient, tokenFromEnv, type GitHubClientOptions, type GitHubRepository, type TokenCheck } from './github/api.js';
export { cloneOrUpdate, defaultReposDir, listClones, authEnv, type CloneOptions, type CloneResult } from './github/clone.js';
