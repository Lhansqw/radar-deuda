import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpError, runGit, type CloneOptions, type GitHubRepoRef } from '@radar/sources';
import { createProvider, historyStart, keysFromEnv, resolveTarget, runPipeline, type PipelineEvent, type TargetDeps } from '../src/index.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'radar-pipeline-'));
  dirs.push(d);
  return d;
}
const silent = { info: () => undefined, warn: () => undefined };

const complex = (n: number) => `export function f(a: number[], b: boolean, c: boolean) {
  for (const x of a) { if (b) { if (c) { if (x > ${n}) { while (x) { if (x % 2) { break; } } } } } }
}`;

async function gitRepo(): Promise<string> {
  const root = await tmp();
  const git = (...a: string[]) => runGit(['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@x.co', ...a], { cwd: root });
  await git('init', '-q', '-b', 'main');
  for (let i = 0; i < 2; i++) {
    await writeFile(path.join(root, 'caliente.ts'), complex(i));
    await git('add', '-A');
    await git('commit', '-q', '-m', `c${i}`);
  }
  return root;
}

describe('runPipeline', () => {
  it('analiza una carpeta, añade el contexto de Git e informa de cada etapa en orden', async () => {
    const root = await gitRepo();
    const events: PipelineEvent[] = [];
    const { report, aiLabel } = await runPipeline(
      { target: root, history: true, since: '2000-01-01', online: false, noCache: true },
      { ...silent, progress: (e) => events.push(e) },
      new AbortController().signal,
    );
    expect(aiLabel).toBeUndefined();
    expect(report.vcs?.branch).toBe('main');
    expect(report.hotspots?.map((h) => h.file)).toEqual(['caliente.ts']);
    const phases = events.map((e) => e.phase).filter((p, i, all) => p !== all[i - 1]);
    expect(phases).toEqual(['discovery', 'files', 'cross-file', 'project', 'history', 'done']);
    expect(events.find((e) => e.phase === 'files')).toMatchObject({ total: 1 });
  });

  it('sin historial no lee el historial de Git', async () => {
    const root = await gitRepo();
    const events: PipelineEvent[] = [];
    const { report } = await runPipeline({ target: root, history: false, online: false, noCache: true }, { ...silent, progress: (e) => events.push(e) }, new AbortController().signal);
    expect(report.vcs?.head).toBeTruthy();
    expect(report.hotspots).toBeUndefined();
    expect(events.some((e) => e.phase === 'history')).toBe(false);
  });

  it('se puede cancelar', async () => {
    const root = await gitRepo();
    const controller = new AbortController();
    controller.abort();
    await expect(runPipeline({ target: root, history: false, online: false, noCache: true }, silent, controller.signal)).rejects.toThrow();
  });
});

describe('origen', () => {
  it('una carpeta existente se analiza tal cual y lo demás debe ser un repositorio de GitHub', async () => {
    const root = await tmp();
    expect(await resolveTarget({ target: root, history: false }, silent, new AbortController().signal)).toEqual({ dir: root, github: null });
    await expect(resolveTarget({ target: 'no/es/valido', history: false }, silent, new AbortController().signal)).rejects.toThrow(/ni es una referencia válida a GitHub/);
  });

  /** GitHub simulado: metadatos (o un error) y un clonado que solo registra sus opciones. */
  function github(meta: { defaultBranch: string; sizeKb: number } | Error, warnings: string[] = []) {
    const clones: Array<{ ref: GitHubRepoRef; options: CloneOptions }> = [];
    const tokens: Array<string | undefined> = [];
    const deps: TargetDeps = {
      client: (token) => {
        tokens.push(token);
        return {
          getRepository: async () => {
            if (meta instanceof Error) throw meta;
            return { fullName: 'ana/tienda', private: false, archived: false, pushedAt: null, language: 'TypeScript', ...meta };
          },
          checkToken: async () => ({ kind: 'fine-grained', login: 'ana', warnings }),
        };
      },
      clone: async (ref, options) => {
        clones.push({ ref, options });
        return { dir: '/clones/ana__tienda', head: 'abc', updated: false };
      },
    };
    return { deps, clones, tokens };
  }
  const recorder = () => {
    const log: string[] = [];
    return { log, hooks: { info: (m: string) => log.push(`info: ${m}`), warn: (m: string) => log.push(`aviso: ${m}`) } };
  };
  const signal = new AbortController().signal;

  it('un repositorio de GitHub se clona con la rama principal, el periodo del historial y el tamaño', async () => {
    const gh = github({ defaultBranch: 'develop', sizeKb: 2048 });
    const { log, hooks } = recorder();
    const r = await resolveTarget({ target: 'ana/tienda', history: true, since: '2026-01-01' }, hooks, signal, gh.deps);
    expect(r).toEqual({ dir: '/clones/ana__tienda', github: { owner: 'ana', repo: 'tienda' } });
    expect(gh.clones[0]?.options).toMatchObject({ branch: 'develop', shallowSince: '2026-01-01', sizeKb: 2048 });
    expect(gh.clones[0]?.options).not.toHaveProperty('token');
    expect(log).toEqual(['info: Clonando ana/tienda (2 MB, rama develop)…', 'info: Clonado en /clones/ana__tienda']);
  });

  it('la rama indicada manda; sin historial no se limita el periodo; los avisos del token llegan al usuario', async () => {
    const gh = github({ defaultBranch: 'main', sizeKb: 10 }, ['El token puede escribir en el repositorio.']);
    const { log, hooks } = recorder();
    await resolveTarget({ target: 'https://github.com/ana/tienda', history: false, branch: 'v2', githubToken: 'github_pat_x' }, hooks, signal, gh.deps);
    expect(gh.tokens).toEqual(['github_pat_x']);
    expect(gh.clones[0]?.options).toMatchObject({ branch: 'v2', token: 'github_pat_x' });
    expect(gh.clones[0]?.options).not.toHaveProperty('shallowSince');
    expect(log).toContain('aviso: El token puede escribir en el repositorio.');
  });

  it('un repositorio que no existe (o sin acceso) no se intenta clonar', async () => {
    for (const status of [401, 404]) {
      const gh = github(new Error('GitHub respondió con un error', { cause: new HttpError(`HTTP ${status}`, status, new Headers(), '') }));
      await expect(resolveTarget({ target: 'ana/tienda', history: false }, silent, signal, gh.deps)).rejects.toThrow(/error/);
      expect(gh.clones).toEqual([]);
    }
  });

  it('sin metadatos (límite de peticiones, red) avisa y clona igualmente', async () => {
    const gh = github(new Error('límite de peticiones', { cause: new HttpError('HTTP 403', 403, new Headers(), '') }));
    const { log, hooks } = recorder();
    await resolveTarget({ target: 'ana/tienda', history: false }, hooks, signal, gh.deps);
    expect(log[0]).toMatch(/^aviso: No se pudieron obtener los metadatos de GitHub \(límite de peticiones\)/);
    expect(gh.clones[0]?.options).not.toHaveProperty('branch');
    expect(gh.clones[0]?.options).not.toHaveProperty('sizeKb');
  });

  it('el historial empieza en la fecha indicada o hace 12 meses', () => {
    expect(historyStart({ since: '2024-05-01' })).toBe('2024-05-01');
    expect(historyStart({}, Date.parse('2026-10-26T12:00:00Z'))).toBe('2025-10-26');
  });
});

describe('claves de IA', () => {
  it('se leen de las variables de entorno sin espacios y se omiten las vacías', () => {
    expect(keysFromEnv({ RADAR_OPENROUTER_API_KEY: '  sk-or-x \r\n', RADAR_ANTHROPIC_API_KEY: '   ', RADAR_OPENAI_API_KEY: 'sk-y' })).toEqual({ openrouter: 'sk-or-x', openai: 'sk-y' });
    expect(keysFromEnv({})).toEqual({});
  });

  it('el proveedor usa solo las claves que recibe e indica dónde configurarlas', () => {
    expect(() => createProvider({ provider: 'openrouter', model: 'a/b', limit: 1, budgetUsd: 1, plan: false }, {})).toThrow(/RADAR_OPENROUTER_API_KEY/);
    expect(() => createProvider({ provider: 'openai', model: 'x', limit: 1, budgetUsd: 1, plan: false }, {})).toThrow(/RADAR_OPENAI_API_KEY/);
    expect(createProvider({ provider: 'lmstudio', limit: 1, budgetUsd: 1, plan: false }, {}).locality).toBe('local');
  });

  it('la IA incluida usa la función de Supabase con el token de la sesión, y sin sesión lo dice', () => {
    const url = 'https://prueba.supabase.co/functions/v1/ia';
    const p = createProvider({ provider: 'incluida', url, limit: 1, budgetUsd: 1, plan: false }, { incluida: 'token-de-sesion' });
    expect({ id: p.id, label: p.label, locality: p.locality }).toEqual({ id: 'incluida', label: 'IA incluida', locality: 'cloud' });
    expect(() => createProvider({ provider: 'incluida', url, limit: 1, budgetUsd: 1, plan: false }, {})).toThrow('Inicia sesión para usar la IA incluida.');
    expect(() => createProvider({ provider: 'incluida', limit: 1, budgetUsd: 1, plan: false }, { incluida: 't' })).toThrow(/conexión con Supabase/);
  });
});

describe('caché del historial', () => {
  it('reutiliza la frecuencia de cambio mientras HEAD no cambie y la recalcula si cambia', async () => {
    const { cachedFileChurn } = await import('../src/git-context.js');
    const { getRepoInfo } = await import('@radar/sources');
    const { readdir, writeFile: write } = await import('node:fs/promises');
    const root = await gitRepo();
    const cacheBase = await tmp();
    const signal = new AbortController().signal;
    const opts = async () => {
      const info = await getRepoInfo(root);
      return { head: info?.head ?? '', shallow: false, since: '2000-01-01', prefix: '', cacheBase };
    };
    const first = await cachedFileChurn(root, await opts(), signal);
    expect(first.fromCache).toBe(false);
    expect(first.churn.get('caliente.ts')?.commits).toBe(2);
    const second = await cachedFileChurn(root, await opts(), signal);
    expect(second.fromCache).toBe(true);
    expect([...second.churn.values()]).toEqual([...first.churn.values()]);
    // Una caché por repositorio, en su carpeta.
    expect(await readdir(path.join(cacheBase, 'git'))).toHaveLength(1);

    // Otro commit: se recalcula y sustituye a la anterior.
    await writeFile(path.join(root, 'caliente.ts'), complex(9));
    await runGit(['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@x.co', 'commit', '-qam', 'c2'], { cwd: root });
    const third = await cachedFileChurn(root, await opts(), signal);
    expect(third.fromCache).toBe(false);
    expect(third.churn.get('caliente.ts')?.commits).toBe(3);
    expect(await readdir(path.join(cacheBase, 'git'))).toHaveLength(1);

    // Dañada: se recalcula sin error.
    const [name] = await readdir(path.join(cacheBase, 'git'));
    await write(path.join(cacheBase, 'git', name as string), '{no es json');
    expect((await cachedFileChurn(root, await opts(), signal)).fromCache).toBe(false);
    // Sin caché, nunca escribe.
    expect((await cachedFileChurn(root, { ...(await opts()), cacheBase: null }, signal)).fromCache).toBe(false);
  });
});
