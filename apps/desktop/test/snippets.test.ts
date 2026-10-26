import { mkdtemp, rm, symlink, utimes, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnalysisReport } from '@radar/engine';
import { VALIDATORS } from '../src/main/ipc-validation.js';
import { MAX_SNIPPET_LINES, readSnippet, resolveReportFile } from '../src/main/snippets.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const SECRET = ['Zq8v', 'T2mW', '9xLp', '4RbN', '7cYd'].join('');

async function project(): Promise<{ root: string; report: AnalysisReport }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'radar-snippet-'));
  dirs.push(root);
  await mkdir(path.join(root, 'src'));
  const lines = Array.from({ length: 30 }, (_, i) => `const linea${i + 1} = ${i + 1};`);
  lines[9] = `    const API_TOKEN = "${SECRET}";`;
  await writeFile(path.join(root, 'src/a.ts'), lines.join('\n'));
  await writeFile(path.join(root, 'src/no-citado.ts'), 'secreto();');
  await writeFile(path.join(root, 'bin.dat'), Buffer.from([1, 0, 2, 0]));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'radar-fuera-'));
  dirs.push(outside);
  await writeFile(path.join(outside, 'x.ts'), 'fuera');
  await symlink(path.join(outside, 'x.ts'), path.join(root, 'enlace.ts'));
  const loc = (file: string) => ({ id: file, locations: [{ file, startLine: 1, endLine: 1 }] });
  const report = {
    root,
    generatedAt: new Date(Date.now() + 60_000).toISOString(),
    findings: [loc('src/a.ts'), loc('enlace.ts'), loc('bin.dat'), loc('../fuera.ts'), loc('src/borrado.ts')],
  } as unknown as AnalysisReport;
  return { root, report };
}

describe('fragmentos de código', () => {
  it('devuelve el rango pedido, ajustado a los límites del archivo', async () => {
    const { report } = await project();
    const s = await readSnippet(report, 'src/a.ts', 3, 5);
    expect(s).toMatchObject({ file: 'src/a.ts', startLine: 3, endLine: 5, totalLines: 30, lines: ['const linea3 = 3;', 'const linea4 = 4;', 'const linea5 = 5;'], changedSinceAnalysis: false });
    expect((await readSnippet(report, 'src/a.ts', 28, 90)).endLine).toBe(30);
    expect((await readSnippet(report, 'src/a.ts', 99, 120)).startLine).toBe(30);
  });

  it('oculta los secretos conservando la sangría y marca la línea', async () => {
    const { report } = await project();
    const s = await readSnippet(report, 'src/a.ts', 8, 12);
    expect(s.redactedLines).toEqual([10]);
    expect(s.lines.join('\n')).not.toContain(SECRET);
    expect(s.lines[2]).toMatch(/^ {4}const API_TOKEN = "Zq8v…/);
  });

  it('avisa si el archivo cambió después del análisis', async () => {
    const { root, report } = await project();
    await utimes(path.join(root, 'src/a.ts'), new Date(), new Date(Date.now() + 120_000));
    expect((await readSnippet(report, 'src/a.ts', 1, 2)).changedSinceAnalysis).toBe(true);
  });

  it('solo lee archivos citados por el análisis, dentro del proyecto, reales y de texto', async () => {
    const { report } = await project();
    await expect(resolveReportFile(report, 'src/no-citado.ts')).rejects.toThrow(/no aparece en los hallazgos/);
    await expect(resolveReportFile(report, '../fuera.ts')).rejects.toThrow(/Ruta no válida/);
    await expect(resolveReportFile(report, 'enlace.ts')).rejects.toThrow(/enlaces simbólicos/);
    await expect(resolveReportFile(report, 'src/borrado.ts')).rejects.toThrow(/ya no existe/);
    await expect(readSnippet(report, 'bin.dat', 1, 2)).rejects.toThrow(/binario/);
  });

  it('limita las líneas por petición', async () => {
    const { root, report } = await project();
    await writeFile(path.join(root, 'src/a.ts'), Array.from({ length: 2000 }, (_, i) => `x${i}`).join('\n'));
    const s = await readSnippet(report, 'src/a.ts', 1, 2000);
    expect(s.lines).toHaveLength(MAX_SNIPPET_LINES);
  });

  it('la validación IPC rechaza rutas absolutas, con unidad, barras invertidas o ".."', () => {
    const v = VALIDATORS['files:snippet'];
    expect(v([1, 'src/a.ts', 1, 5])).toEqual([1, 'src/a.ts', 1, 5]);
    for (const bad of ['/etc/passwd', 'C:/Windows/win.ini', 'src\\a.ts', 'src/../../x', '..', 'a\0b']) expect(() => v([1, bad, 1, 2])).toThrow(/Ruta no válida/);
    expect(() => v([1, 'a.ts', 5, 2])).toThrow(/Rango de líneas/);
    expect(() => v([1, 'a.ts', 0, 2])).toThrow(/Número de línea/);
  });
});
