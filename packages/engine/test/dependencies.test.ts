import { afterEach, describe, expect, it } from 'vitest';
import { dependenciesAnalyzer } from '../src/analyzers/dependencies.js';
import { projectContext } from './helpers/project-context.js';
import { createTmpRepo, type TmpRepo } from './helpers/tmp-repo.js';

let repo: TmpRepo | undefined;
afterEach(async () => {
  await repo?.cleanup();
  repo = undefined;
});

const manifest = (o: object): string => JSON.stringify(o, null, 2);

async function run(files: Record<string, string>) {
  repo = await createTmpRepo(files);
  return dependenciesAnalyzer.analyzeProject(await projectContext(repo.root));
}

describe('dependenciesAnalyzer', () => {
  it('detecta lockfile ausente, rangos abiertos, fuentes externas y duplicados', async () => {
    const findings = await run({
      'package.json': manifest({
        dependencies: { express: '*', lodash: '^4.17.21', interno: 'github:empresa/interno', zod: '>=3' },
        devDependencies: { lodash: '^4.17.21' },
      }),
    });
    const byRule = Object.fromEntries(findings.map((f) => [f.ruleId, f]));
    expect(Object.keys(byRule).sort()).toEqual([
      'dependencies/duplicated',
      'dependencies/no-lockfile',
      'dependencies/non-registry',
      'dependencies/unbounded-range',
    ]);
    expect(byRule['dependencies/unbounded-range']?.locations.map((l) => l.symbol)).toEqual(['express', 'zod']);
    expect(byRule['dependencies/unbounded-range']?.locations[0]?.startLine).toBe(3);
  });

  it('acepta un lockfile en un directorio superior (monorepo)', async () => {
    const findings = await run({
      'package-lock.json': '{}',
      'packages/app/package.json': manifest({ dependencies: { react: '^19.0.0' } }),
    });
    expect(findings).toEqual([]);
  });

  it('los rangos acotados y peerDependencies no generan hallazgos', async () => {
    const findings = await run({
      'yarn.lock': '',
      'package.json': manifest({ dependencies: { a: '~1.2.0', b: '>=1 <2' }, peerDependencies: { react: '*' } }),
    });
    expect(findings).toEqual([]);
  });

  it('informa de un package.json inválido', async () => {
    const findings = await run({ 'package.json': '{ "name": ' });
    expect(findings.map((f) => f.ruleId)).toEqual(['dependencies/invalid-manifest']);
  });
});
