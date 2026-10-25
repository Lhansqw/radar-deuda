import { afterEach, describe, expect, it } from 'vitest';
import { compareReports, hasNewAtLeast, parseReport } from '../src/compare.js';
import { analyzeRepository } from '../src/engine.js';
import { formatComparison, formatReport } from '../src/report.js';
import { createTmpRepo, type TmpRepo } from './helpers/tmp-repo.js';

let repo: TmpRepo | undefined;
afterEach(async () => {
  await repo?.cleanup();
  repo = undefined;
});

const nested = (name: string) => `export function ${name}(a: number[], b: boolean, c: boolean) {
  for (const x of a) { if (b) { if (c) { if (x > 1) { while (x) { if (x % 2) { break; } } } } } }
}`;

describe('compareReports', () => {
  it('detecta deuda nueva y resuelta entre dos análisis, aunque cambien las líneas', async () => {
    repo = await createTmpRepo({ 'src/a.ts': nested('vieja'), 'src/b.ts': '// FIXME: arreglar\nexport const b = 1;' });
    const before = await analyzeRepository(repo.root, { cacheDir: null });
    // vieja se desplaza 5 líneas (mismo hallazgo), se arregla el FIXME y aparece otra función compleja.
    await repo.write('src/a.ts', `\n\n\n\n\n${nested('vieja')}\n${nested('nueva')}`);
    await repo.write('src/b.ts', 'export const b = 1;');
    const after = await analyzeRepository(repo.root, { cacheDir: null });

    const c = compareReports(before, after);
    expect(c.added.map((f) => f.locations[0]?.symbol)).toEqual(['nueva']);
    expect(c.resolved.map((f) => f.ruleId)).toEqual(['maintainability/markers']);
    expect(c.persisting).toBe(1);
    expect(hasNewAtLeast(c, 'medium')).toBe(true);
    expect(hasNewAtLeast(c, 'critical')).toBe(false);
    expect(formatComparison(c)).toMatch(/1 nuevos · 1 resueltos · 1 sin cambios/);
  });

  it('parseReport valida el formato y rechaza archivos ajenos', async () => {
    repo = await createTmpRepo({ 'a.ts': 'export const a = 1;' });
    const report = await analyzeRepository(repo.root, { cacheDir: null });
    expect(parseReport(JSON.stringify(report)).findings).toEqual(report.findings);
    expect(() => parseReport('{')).toThrow(/no es JSON/);
    expect(() => parseReport('{"name":"package"}')).toThrow(/no es un informe/);
    expect(() => parseReport(JSON.stringify({ ...report, findings: [{ id: 1 }] }))).toThrow(/formato no válido/);
  });
});

describe('formatReport', () => {
  it('muestra el commit y los puntos críticos si el informe los incluye', async () => {
    repo = await createTmpRepo({ 'a.ts': 'export const a = 1;' });
    const report = await analyzeRepository(repo.root, { cacheDir: null });
    report.vcs = { head: '0123456789abcdef', branch: 'main', remoteUrl: 'https://github.com/a/b.git', shallow: true };
    report.hotspots = [{ file: 'src/x.ts', commits: 12, linesChanged: 300, authors: 3, lastChangeAt: '', debtMinutes: 90, findingIds: [], score: 87 }];
    const text = formatReport(report);
    expect(text).toMatch(/Commit 0123456789 \(main\) · https:\/\/github.com\/a\/b.git · historial superficial/);
    expect(text).toMatch(/87 {2}src\/x.ts · 12 commits · 3 autor\(es\) · deuda ~1.5 h/);
  });
});
