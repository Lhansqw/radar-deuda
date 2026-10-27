import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getRepoInfo, stripCredentials } from '../src/git/local.js';
import { GitError, hardenedArgs, runGit, sanitizedEnv } from '../src/git/run.js';
import { createGitRepo, type TestRepo } from './helpers/git-repo.js';

let repo: TestRepo | undefined;
const extra: string[] = [];
afterEach(async () => {
  await repo?.cleanup();
  repo = undefined;
  await Promise.all(extra.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('runGit', () => {
  it('antepone la configuración endurecida a cada comando', () => {
    const args = hardenedArgs(['status']);
    expect(args[0]).toBe('--no-pager');
    expect(args).toContain('core.fsmonitor=false');
    expect(args.at(-1)).toBe('status');
  });

  it('elimina las variables GIT_* heredadas y desactiva los prompts', () => {
    process.env['GIT_DIR'] = '/otro/repo';
    try {
      const env = sanitizedEnv();
      expect(env['GIT_DIR']).toBeUndefined();
      expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
    } finally {
      delete process.env['GIT_DIR'];
    }
  });

  it('informa del error de Git sin filtrar secretos', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'radar-nogit-'));
    extra.push(dir);
    const err = await runGit(['log', 'https://usuario:ghp_secreto123@github.com/x'], { cwd: dir, redact: ['ghp_secreto123'] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect(String((err as GitError).message)).not.toContain('ghp_secreto123');
  });

  it('respeta el límite de salida', async () => {
    repo = await createGitRepo();
    await repo.commit({ 'a.txt': 'x'.repeat(10_000) }, 'grande');
    await expect(runGit(['show', 'HEAD:a.txt'], { cwd: repo.root, maxOutputBytes: 100 })).rejects.toThrow(/límite/);
  });

  it('se puede cancelar', async () => {
    repo = await createGitRepo();
    const controller = new AbortController();
    controller.abort();
    await expect(runGit(['log'], { cwd: repo.root, signal: controller.signal })).rejects.toThrow();
  });
});

describe('protección frente a configuración maliciosa del repositorio', () => {
  it('core.fsmonitor del repositorio no se ejecuta (y sin endurecer, sí)', async () => {
    repo = await createGitRepo();
    await repo.commit({ 'a.txt': 'hola' }, 'inicial');
    const marker = path.join(repo.root, 'PWNED');
    const script = path.join(repo.root, 'monitor.cjs');
    await writeFile(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.stdout.write('/');`);
    const command = `"${process.execPath.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}"`;
    await repo.git('config', 'core.fsmonitor', command);

    // Con el ejecutor endurecido: no se lanza el programa.
    await runGit(['status', '--porcelain'], { cwd: repo.root });
    await getRepoInfo(repo.root);
    expect(existsSync(marker)).toBe(false);

    // Control: Git sin endurecer sí lo ejecuta, así que la prueba es significativa.
    spawnSync('git', ['status', '--porcelain'], { cwd: repo.root, env: sanitizedEnv() });
    expect(existsSync(marker)).toBe(true);
  });

  it('los hooks del repositorio no se ejecutan', async () => {
    repo = await createGitRepo();
    const marker = path.join(repo.root, 'HOOK');
    const hook = path.join(repo.root, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, `#!/bin/sh\necho x > "${marker.replace(/\\/g, '/')}"\n`, { mode: 0o755 });
    await repo.commit({ 'a.txt': 'hola' }, 'con hook');
    expect(existsSync(marker)).toBe(false);
  });
});

describe('getRepoInfo', () => {
  it('devuelve null fuera de un repositorio', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'radar-nogit-'));
    extra.push(dir);
    expect(await getRepoInfo(dir)).toBeNull();
  });

  it('describe HEAD, rama y remoto sin credenciales', async () => {
    repo = await createGitRepo();
    const sha = await repo.commit({ 'src/a.ts': 'x' }, 'inicial');
    await repo.git('remote', 'add', 'origin', 'https://x-access-token:ghp_abc123@github.com/Lhansqw/radar-deuda.git');
    const info = await getRepoInfo(path.join(repo.root, 'src'));
    expect(info).toMatchObject({ prefix: 'src', head: sha, branch: 'main', remoteUrl: 'https://github.com/Lhansqw/radar-deuda.git', shallow: false });
    // Git escribe la raíz a su manera (en Windows, sin nombres cortos como RUNNER~1): se compara la ruta real.
    expect(await realpath(info?.root ?? '')).toBe(await realpath(repo.root));
    expect((await getRepoInfo(repo.root))?.prefix).toBe('');
  });

  it('la carpeta relativa a la raíz es correcta aunque se llegue por un enlace', async () => {
    repo = await createGitRepo();
    await mkdir(path.join(repo.root, 'src', 'ui'), { recursive: true });
    const outside = await mkdtemp(path.join(os.tmpdir(), 'radar-enlace-'));
    extra.push(outside);
    const link = path.join(outside, 'enlace');
    await symlink(path.join(repo.root, 'src'), link, 'junction'); // una unión no pide permisos en Windows
    expect((await getRepoInfo(link))?.prefix).toBe('src');
    expect((await getRepoInfo(path.join(link, 'ui')))?.prefix).toBe('src/ui');
  });

  it('acepta un repositorio sin commits', async () => {
    repo = await createGitRepo();
    expect(await getRepoInfo(repo.root)).toMatchObject({ head: null, branch: 'main', remoteUrl: null });
  });
});

describe('stripCredentials', () => {
  it.each([
    ['https://user:pass@github.com/a/b.git', 'https://github.com/a/b.git'],
    ['https://token@github.com/a/b', 'https://github.com/a/b'],
    ['git@github.com:a/b.git', 'git@github.com:a/b.git'],
  ])('%s → %s', (input, expected) => {
    expect(stripCredentials(input)).toBe(expected);
  });
});
