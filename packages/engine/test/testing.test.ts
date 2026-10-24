import { afterEach, describe, expect, it } from 'vitest';
import { testingAnalyzer } from '../src/analyzers/testing.js';
import { projectContext } from './helpers/project-context.js';
import { createTmpRepo, type TmpRepo } from './helpers/tmp-repo.js';

let repo: TmpRepo | undefined;
afterEach(async () => {
  await repo?.cleanup();
  repo = undefined;
});

const sources = (n: number): Record<string, string> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`src/m${i}.ts`, `export const v${i} = ${i};`]));

async function run(files: Record<string, string>) {
  repo = await createTmpRepo(files);
  return testingAnalyzer.analyzeProject(await projectContext(repo.root));
}

describe('testingAnalyzer', () => {
  it('reporta la ausencia total de pruebas', async () => {
    const findings = await run(sources(6));
    expect(findings.map((f) => [f.ruleId, f.severity, f.confidence])).toEqual([['testing/no-tests', 'high', 'medium']]);
  });

  it('reporta una proporción baja de archivos de prueba', async () => {
    const findings = await run({ ...sources(12), 'src/m0.test.ts': 'test' });
    expect(findings.map((f) => f.ruleId)).toEqual(['testing/low-ratio']);
    expect(findings[0]?.evidence[0]?.metric?.value).toBeCloseTo(1 / 12, 2);
  });

  it('no reporta con una proporción suficiente', async () => {
    const findings = await run({ ...sources(10), 'test/a.test.ts': 'x', 'test/b.test.ts': 'x' });
    expect(findings).toEqual([]);
  });

  it('no opina sobre proyectos muy pequeños ni cuenta archivos de configuración', async () => {
    const findings = await run({ ...sources(4), 'vite.config.ts': 'x', '.eslintrc.cjs': 'x' });
    expect(findings).toEqual([]);
  });
});
