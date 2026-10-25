import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runGit } from '../../src/git/run.js';

export interface TestRepo {
  root: string;
  git(...args: string[]): Promise<string>;
  /** Escribe archivos y crea un commit con fecha opcional (segundos Unix). */
  commit(files: Record<string, string | null>, message: string, opts?: { date?: number; author?: string }): Promise<string>;
  cleanup(): Promise<void>;
}

/** Repositorio Git real en un directorio temporal, aislado de la configuración del usuario. */
export async function createGitRepo(): Promise<TestRepo> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'radar-git-'));
  const git = (...args: string[]): Promise<string> =>
    runGit(['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd: root });
  await git('init', '-q');
  return {
    root,
    git,
    async commit(files, message, opts = {}) {
      for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(root, ...rel.split('/'));
        if (content === null) {
          await rm(abs, { force: true });
          continue;
        }
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, content);
      }
      await git('add', '-A');
      const date = `${opts.date ?? 1_700_000_000} +0000`;
      const author = opts.author ?? 'dev@example.com';
      await runGit(['-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', message], {
        cwd: root,
        env: {
          GIT_AUTHOR_NAME: author.split('@')[0] ?? 'dev',
          GIT_AUTHOR_EMAIL: author,
          GIT_COMMITTER_NAME: 'ci',
          GIT_COMMITTER_EMAIL: 'ci@example.com',
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      });
      return (await git('rev-parse', 'HEAD')).trim();
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
