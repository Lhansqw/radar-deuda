import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeRepository, type AnalysisReport, type Finding } from '@radar/engine';
import { OMITTED_LINE, PrivacyError } from '../src/context.js';
import { fixContext, FixUnavailableError, proposeFix, type FixOptions } from '../src/fix.js';
import type { CompletionRequest } from '../src/provider.js';
import { fakeProvider } from './helpers/fake-provider.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const SECRET = 'Zq8vT2mW9xLp4RbN7cYd';
const SOURCE = `const API_TOKEN = "${SECRET}";

export function procesar(a: number[], b: boolean, c: boolean): number {
  let total = 0;
  for (const x of a) {
    if (b) {
      if (c) {
        if (x > 1) {
          while (x > 100) {
            if (x % 2) {
              total += 1;
            } else if (x % 3) {
              total += 2;
            } else {
              total += 3;
            }
            break;
          }
        }
      }
    }
  }
  return total + API_TOKEN.length;
}
`;

async function demo(): Promise<{ report: AnalysisReport; readText: FixOptions['readText']; complex: Finding; secret: Finding }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'radar-fix-'));
  dirs.push(root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/p.ts'), SOURCE);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { express: '^5.0.0' } }));
  const report = await analyzeRepository(root, { cacheDir: null });
  const complex = report.findings.find((f) => f.category === 'complexity');
  const secret = report.findings.find((f) => f.category === 'security');
  if (!complex || !secret) throw new Error(`Faltan hallazgos de prueba: ${report.findings.map((f) => f.ruleId).join(', ')}`);
  return { report, readText: (rel) => readFile(path.join(root, rel), 'utf8').catch(() => null), complex, secret };
}

const idOf = (req: CompletionRequest): string => /El id del hallazgo es "([^"]+)"/.exec(req.messages[0]?.content ?? '')?.[1] ?? '';

function fix(req: CompletionRequest, cambios: unknown[], over: Record<string, unknown> = {}): { text: string } {
  return {
    text: JSON.stringify({
      id_hallazgo: idOf(req),
      aplicable: true,
      resumen: 'Se extrae la condición anidada.',
      cambios,
      riesgos: ['Revisar el caso x <= 1.'],
      verificacion: ['Ejecutar las pruebas de procesar.'],
      ...over,
    }),
  };
}

describe('proposeFix', () => {
  it('calcula la diferencia y el parche a partir de los rangos propuestos', async () => {
    const { report, readText, complex } = await demo();
    const provider = fakeProvider((req) => fix(req, [{ archivo: 'src/p.ts', linea_inicio: 4, linea_fin: 4, reemplazo: '  let total = 0; // acumulado' }]));
    const p = await proposeFix(report, complex.id, { provider, model: 'm', privacy: 'local', readText, cacheDir: null, now: () => new Date('2026-10-26T10:00:00Z') });
    expect(p).toMatchObject({ findingId: complex.id, applicable: true, privacy: 'local', provider: 'falso', model: 'modelo-falso', fromCache: false, createdAt: '2026-10-26T10:00:00.000Z' });
    expect(p.hunks).toHaveLength(1);
    expect(p.hunks[0]?.lines.filter((l) => l.kind !== 'context').map((l) => [l.kind, l.text])).toEqual([
      ['removed', '  let total = 0;'],
      ['added', '  let total = 0; // acumulado'],
    ]);
    expect(p.patch).toContain('--- a/src/p.ts\n+++ b/src/p.ts\n@@ -1,7 +1,7 @@');
    expect(p.risks).toEqual(['Revisar el caso x <= 1.']);
    expect(p.verification).toEqual(['Ejecutar las pruebas de procesar.']);
    expect(Object.keys(p.baseHashes)).toEqual(['src/p.ts']);
    expect(p.usage.requests).toBe(1);
  });

  it('el secreto nunca se envía y, si el modelo copia la línea oculta, el parche no la toca', async () => {
    const { report, readText, complex } = await demo();
    const provider = fakeProvider((req) => fix(req, [{ archivo: 'src/p.ts', linea_inicio: 1, linea_fin: 4, reemplazo: `${OMITTED_LINE}\n\nexport function procesar(a: number[], b: boolean, c: boolean): number {\n  let total = 0; // acumulado` }]), 'cloud');
    const p = await proposeFix(report, complex.id, { provider, model: 'm', privacy: 'fragmentos', readText, cacheDir: null });
    expect(JSON.stringify(provider.calls)).not.toContain(SECRET);
    expect(JSON.stringify(provider.calls[0]?.messages)).toContain(OMITTED_LINE);
    const changed = p.hunks.flatMap((h) => h.lines).filter((l) => l.kind !== 'context');
    expect(changed.map((l) => l.oldLine ?? l.newLine)).toEqual([4, 4]);
    expect(p.validationNotes).toEqual([]);
  });

  it('una línea oculta movida de su sitio o un rango fuera del fragmento se rechazan y se pide corregir una vez', async () => {
    const { report, readText, complex } = await demo();
    let n = 0;
    const provider = fakeProvider((req) =>
      ++n === 1
        ? fix(req, [{ archivo: 'src/p.ts', linea_inicio: 90, linea_fin: 95, reemplazo: 'x' }])
        : n === 2
          ? fix(req, [{ archivo: 'src/p.ts', linea_inicio: 23, linea_fin: 23, reemplazo: `  return total;\n${OMITTED_LINE}` }])
          : fix(req, [{ archivo: 'src/p.ts', linea_inicio: 23, linea_fin: 23, reemplazo: '  return total;' }]),
    );
    const deps = { provider, model: 'm', privacy: 'local' as const, readText, cacheDir: null };
    await expect(proposeFix(report, complex.id, deps)).rejects.toThrow(/fuera de su sitio/);
    expect(provider.calls).toHaveLength(2);
    // askJson reutiliza la lista de mensajes: el tercero es el motivo del primer rechazo.
    expect(provider.calls[1]?.messages[2]?.content).toMatch(/se sale del fragmento enviado \(1-/);
    const ok = await proposeFix(report, complex.id, deps);
    expect(ok.hunks.flatMap((h) => h.lines).filter((l) => l.kind === 'added').map((l) => l.text)).toEqual(['  return total;']);
  });

  it('quita la numeración copiada, admite "no aplicable" y exige cambios reales', async () => {
    const { report, readText, complex } = await demo();
    const numbered = fakeProvider((req) => fix(req, [{ archivo: './src/p.ts', linea_inicio: 4, linea_fin: 4, reemplazo: '   4 |   let total = 0; // n' }]));
    const p = await proposeFix(report, complex.id, { provider: numbered, model: 'm', privacy: 'local', readText, cacheDir: null });
    expect(p.hunks[0]?.lines.find((l) => l.kind === 'added')?.text).toBe('  let total = 0; // n');
    expect(p.validationNotes).toEqual(['Se quitaron los números de línea que el modelo copió en el reemplazo.']);

    const no = fakeProvider((req) => fix(req, [], { aplicable: false, resumen: 'Hace falta ver quién llama a procesar.' }));
    const q = await proposeFix(report, complex.id, { provider: no, model: 'm', privacy: 'local', readText, cacheDir: null });
    expect(q).toMatchObject({ applicable: false, summary: 'Hace falta ver quién llama a procesar.', hunks: [], patch: '' });

    const same = fakeProvider((req) => fix(req, [{ archivo: 'src/p.ts', linea_inicio: 4, linea_fin: 4, reemplazo: '  let total = 0;' }]));
    await expect(proposeFix(report, complex.id, { provider: same, model: 'm', privacy: 'local', readText, cacheDir: null })).rejects.toThrow(/exactamente igual/);
  });

  it('sin enviar nada: privacidad de solo metadatos, secretos, hallazgos del proyecto y local con la nube', async () => {
    const { report, readText, complex, secret } = await demo();
    const provider = fakeProvider(() => ({ text: '{}' }), 'cloud');
    await expect(proposeFix(report, complex.id, { provider, model: 'm', privacy: 'metadatos', readText })).rejects.toBeInstanceOf(PrivacyError);
    await expect(proposeFix(report, complex.id, { provider, model: 'm', privacy: 'local', readText })).rejects.toBeInstanceOf(PrivacyError);
    await expect(proposeFix(report, secret.id, { provider, model: 'm', privacy: 'fragmentos', readText })).rejects.toThrow(/no se envía código/);
    const project = report.findings.find((f) => f.locations.every((l) => l.file === '.'));
    if (project) await expect(proposeFix(report, project.id, { provider, model: 'm', privacy: 'fragmentos', readText })).rejects.toBeInstanceOf(FixUnavailableError);
    await expect(proposeFix(report, 'no-existe', { provider, model: 'm', privacy: 'fragmentos', readText })).rejects.toBeInstanceOf(FixUnavailableError);
    expect(provider.calls).toHaveLength(0);
  });

  it('fixContext devuelve exactamente lo que se enviaría', async () => {
    const { report, readText, complex } = await demo();
    const ctx = await fixContext(report, complex.id, readText);
    expect(ctx.includesCode).toBe(true);
    expect(ctx.snippets[0]).toMatchObject({ file: 'src/p.ts', startLine: 1 });
    const provider = fakeProvider((req) => fix(req, [{ archivo: 'src/p.ts', linea_inicio: 4, linea_fin: 4, reemplazo: '  let total = 0; // x' }]), 'cloud');
    await proposeFix(report, complex.id, { provider, model: 'm', privacy: 'fragmentos', readText, cacheDir: null });
    expect(provider.calls[0]?.messages[0]?.content.startsWith(ctx.text)).toBe(true);
  });
});
