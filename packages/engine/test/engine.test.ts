import { readdir, utimes } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_FILE_ANALYZERS } from '../src/analyzers/index.js';
import { analyzeRepository, safeJoin } from '../src/engine.js';
import type { AnalysisReport, FileAnalyzer } from '../src/types.js';
import { createTmpRepo, type TmpRepo } from './helpers/tmp-repo.js';

const tmps: TmpRepo[] = [];
afterEach(async () => {
  await Promise.all(tmps.splice(0).map((t) => t.cleanup()));
});
async function tmp(files: Record<string, string | Buffer> = {}): Promise<TmpRepo> {
  const t = await createTmpRepo(files);
  tmps.push(t);
  return t;
}

const NESTED = `
export function enredada(a: number[], b: boolean, c: boolean, d: boolean) {
  for (const x of a) {
    if (b) {
      if (c) {
        if (d) {
          while (x > 0) { if (x % 2) { break; } }
        } else if (x) { return 1; }
      }
    }
  }
  return 0;
}`;

const CLONE = Array.from({ length: 10 }, (_, i) => `  if (valor === ${i}) { resultado.push('caso ${i}', valor * ${i + 1}); }`).join('\n');

const DEMO: Record<string, string> = {
  'package.json': JSON.stringify({ dependencies: { express: '*' } }),
  'src/enredada.ts': NESTED,
  'src/a.ts': `import { b } from './b';\nexport function copiaA(valor: number, resultado: unknown[]) {\n${CLONE}\n}\nexport const a = b;`,
  'src/b.ts': `import { a } from './a';\nexport function copiaB(valor: number, resultado: unknown[]) {\n${CLONE}\n}\nexport const b = a;`,
  'src/config.ts': 'export const API_TOKEN = "Zq8vT2mW9xLp4RbN7cYd";\n// FIXME: mover a variables de entorno',
  'src/c.ts': 'export const c = 1;',
  'src/d.ts': 'export const d = 1;',
};

/** Informe sin los campos que dependen del momento o del estado de la caché. */
const stable = (r: AnalysisReport) => ({ findings: r.findings, score: r.score, summary: r.summary, coverage: r.coverage, errors: r.errors });

describe('analyzeRepository', () => {
  it('detecta cada categoría de deuda del repositorio de ejemplo', async () => {
    const repo = await tmp(DEMO);
    const report = await analyzeRepository(repo.root, { cacheDir: null });
    const rules = new Set(report.findings.map((f) => f.ruleId));
    expect(rules).toEqual(
      new Set([
        'complexity/function',
        'duplication/clone',
        'architecture/cycle',
        'security/secret/generic-assignment',
        'maintainability/markers',
        'dependencies/no-lockfile',
        'dependencies/unbounded-range',
        'testing/no-tests',
      ]),
    );
    expect(report.errors).toEqual([]);
    expect(report.score.codeLines).toBeGreaterThan(20);
    expect(report.stats.filesDiscovered).toBe(7);
    // Cada hallazgo tiene evidencia, ubicación y una estimación justificada.
    for (const f of report.findings) {
      expect(f.evidence.length).toBeGreaterThan(0);
      expect(f.locations.length).toBeGreaterThan(0);
      expect(f.effort.rationale.length).toBeGreaterThan(0);
    }
    // Ordenados por severidad descendente.
    const order = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
    const sev = report.findings.map((f) => order[f.severity]);
    expect([...sev].sort((x, y) => y - x)).toEqual(sev);
  });

  it('el segundo análisis sale entero de la caché y da el mismo resultado', async () => {
    const repo = await tmp(DEMO);
    const cache = await tmp();
    const cold = await analyzeRepository(repo.root, { cacheDir: cache.root });
    const warm = await analyzeRepository(repo.root, { cacheDir: cache.root });
    expect(cold.stats.cacheHits).toBe(0);
    expect(warm.stats.cacheHits).toBe(warm.stats.filesDiscovered);
    expect(warm.stats.filesAnalyzed).toBe(0);
    expect(stable(warm)).toEqual(stable(cold));
  });

  it('tras modificar un archivo solo se reanaliza ese archivo', async () => {
    const repo = await tmp(DEMO);
    const cache = await tmp();
    await analyzeRepository(repo.root, { cacheDir: cache.root });
    await repo.write('src/c.ts', 'export const c = 2; // FIXME: valor provisional');
    const report = await analyzeRepository(repo.root, { cacheDir: cache.root });
    expect(report.stats.filesAnalyzed).toBe(1);
    expect(report.findings.some((f) => f.ruleId === 'maintainability/markers' && f.locations[0]?.file === 'src/c.ts')).toBe(true);
  });

  it('un cambio de fecha sin cambio de contenido se resuelve por hash', async () => {
    const repo = await tmp(DEMO);
    const cache = await tmp();
    await analyzeRepository(repo.root, { cacheDir: cache.root });
    const future = new Date(Date.now() + 60_000);
    await utimes(path.join(repo.root, 'src', 'c.ts'), future, future);
    const report = await analyzeRepository(repo.root, { cacheDir: cache.root });
    expect(report.stats.filesAnalyzed).toBe(0);
  });

  it('nunca escribe dentro del repositorio analizado', async () => {
    const repo = await tmp(DEMO);
    const cache = await tmp();
    const before = await readdir(repo.root, { recursive: true });
    await analyzeRepository(repo.root, { cacheDir: cache.root });
    expect(await readdir(repo.root, { recursive: true })).toEqual(before);
  });

  it('reduce la severidad de complejidad en código de pruebas', async () => {
    const repo = await tmp({ 'src/enredada.ts': NESTED, 'test/enredada.test.ts': NESTED });
    const report = await analyzeRepository(repo.root, { cacheDir: null });
    const bySeverity = Object.fromEntries(
      report.findings.filter((f) => f.ruleId === 'complexity/function').map((f) => [f.locations[0]?.file, f.severity]),
    );
    expect(bySeverity['src/enredada.ts']).toBe('medium'); // cognitiva 22 sobre 15
    expect(bySeverity['test/enredada.test.ts']).toBe('low');
  });

  it('omite binarios y minificados, y mide sin analizar los archivos grandes', async () => {
    const big = Array.from({ length: 3000 }, (_, i) => `export const v${i} = ${i};`).join('\n');
    const repo = await tmp({
      'src/datos.ts': Buffer.from([0x63, 0x6f, 0x00, 0x6e]),
      'src/app.min.ts': `var a=1;${'b=2;'.repeat(2000)}`,
      'src/grande.ts': big,
    });
    const report = await analyzeRepository(repo.root, { cacheDir: null, config: { maxFileSizeBytes: 10_000 } });
    expect(report.stats.skipped).toEqual([
      { relPath: 'src/app.min.ts', reason: 'minified' },
      { relPath: 'src/datos.ts', reason: 'binary' },
      { relPath: 'src/grande.ts', reason: 'too-large' },
    ]);
    const large = report.findings.find((f) => f.ruleId === 'size/large-file');
    expect(large?.message).toMatch(/No se analizó en profundidad/);
    expect(large?.locations[0]?.endLine).toBe(3000);
    expect(report.score.codeLines).toBe(3000);
  });

  it('un analizador que falla no detiene el análisis y queda registrado', async () => {
    const repo = await tmp({ 'src/a.ts': 'export const a = 1;' });
    const roto: FileAnalyzer = {
      id: 'roto',
      version: '0.0.1',
      description: 'falla siempre',
      supports: () => true,
      analyze: () => {
        throw new Error('boom');
      },
    };
    const report = await analyzeRepository(repo.root, { cacheDir: null, fileAnalyzers: [...DEFAULT_FILE_ANALYZERS, roto] });
    expect(report.errors).toEqual([{ analyzer: 'roto@0.0.1', file: 'src/a.ts', message: 'boom' }]);
    expect(report.score.codeLines).toBe(1);
  });

  it('la cobertura declarada por un analizador de proyecto sustituye a la del motor', async () => {
    const repo = await tmp({ 'src/a.ts': 'export const a = 1;' });
    const report = await analyzeRepository(repo.root, {
      cacheDir: null,
      projectAnalyzers: [
        {
          id: 'vulns',
          version: '1.0.0',
          description: 'prueba',
          analyzeProject: async () => [],
          coverage: () => [{ area: 'Dependencias', status: 'analyzed', detail: 'Consultado OSV.' }],
        },
      ],
    });
    expect(report.coverage.filter((c) => c.area === 'Dependencias')).toEqual([{ area: 'Dependencias', status: 'analyzed', detail: 'Consultado OSV.' }]);
  });

  it('se puede cancelar', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 200; i++) files[`src/m${i}.ts`] = NESTED;
    const repo = await tmp(files);
    const controller = new AbortController();
    const run = analyzeRepository(repo.root, {
      cacheDir: null,
      config: { concurrency: 1 },
      signal: controller.signal,
      onProgress: (e) => {
        if (e.phase === 'files' && e.done >= 25) controller.abort();
      },
    });
    await expect(run).rejects.toThrow();
  });

  it('informa del progreso por fases', async () => {
    const repo = await tmp(DEMO);
    const phases: string[] = [];
    await analyzeRepository(repo.root, { cacheDir: null, onProgress: (e) => phases.push(e.phase) });
    expect([...new Set(phases)]).toEqual(['discovery', 'files', 'cross-file', 'project', 'done']);
  });
});

describe('safeJoin', () => {
  const root = path.resolve('/repo');
  it.each(['../fuera.ts', '..\\fuera.ts', 'a/../../fuera.ts', path.resolve('/etc/passwd'), 'a\0b'])('rechaza %j', (rel) => {
    expect(safeJoin(root, rel)).toBeNull();
  });
  it('acepta rutas internas', () => {
    expect(safeJoin(root, 'src/a.ts')).toBe(path.join(root, 'src', 'a.ts'));
  });
});
