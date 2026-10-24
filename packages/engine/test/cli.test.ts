import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnalysisReport } from '../src/types.js';
import { createTmpRepo, type TmpRepo } from './helpers/tmp-repo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'src', 'cli.ts');
const DEMO = path.join(here, '..', '..', '..', 'examples', 'demo-repo');

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

let out: TmpRepo | undefined;
afterEach(async () => {
  await out?.cleanup();
  out = undefined;
});

describe('CLI', () => {
  it('analiza el repositorio de ejemplo, muestra el resumen y guarda el JSON', async () => {
    out = await createTmpRepo();
    const json = path.join(out.root, 'informe.json');
    const r = cli(DEMO, '--no-cache', '--quiet', '--json', json);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Mantenibilidad: \d+\/100/);
    expect(r.stdout).toMatch(/Función difícil de mantener: procesarPedido/);
    expect(r.stdout).toMatch(/Límites de este análisis/);
    const report = JSON.parse(await readFile(json, 'utf8')) as AnalysisReport;
    expect(report.schemaVersion).toBe(1);
    expect(report.findings.length).toBeGreaterThan(5);
  });

  it('--fail-on devuelve 1 si hay hallazgos de esa severidad o mayor', () => {
    expect(cli(DEMO, '--no-cache', '--quiet', '--fail-on', 'high').code).toBe(1);
    expect(cli(DEMO, '--no-cache', '--quiet', '--fail-on', 'critical').code).toBe(0);
  });

  it('errores de uso devuelven 2', () => {
    expect(cli().code).toBe(2);
    expect(cli(DEMO, '--fail-on', 'grave').code).toBe(2);
    expect(cli(DEMO, '--opcion-inexistente').code).toBe(2);
    expect(cli(path.join(DEMO, 'no-existe'), '--no-cache').code).toBe(2);
  });

  it('--help devuelve 0', () => {
    const r = cli('--help');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Uso: radar-deuda/);
  });
});
