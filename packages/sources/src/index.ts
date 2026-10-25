/**
 * Fuentes con efectos externos (procesos Git, red). Separadas del motor para
 * que este siga siendo determinista, sin red y fácil de probar.
 */
export { runGit, GitError, hardenedArgs, sanitizedEnv, HARDENING_CONFIG, type GitRunOptions } from './git/run.js';
export { getRepoInfo, stripCredentials, type RepoInfo } from './git/local.js';
