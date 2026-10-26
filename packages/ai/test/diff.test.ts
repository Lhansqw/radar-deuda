import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyEdits, buildHunks, diffOps, EditError, formatPatch, joinLines, splitLines, type LineEdit } from '../src/diff.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Genera el parche, lo aplica con git en un repositorio temporal y devuelve el archivo resultante. */
async function gitApply(original: string, edits: LineEdit[], file = 'src/a.ts'): Promise<{ patch: string; result: string; expected: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'radar-diff-'));
  dirs.push(dir);
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  const abs = path.join(dir, file);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, original);
  const before = splitLines(original);
  const after = applyEdits(before, edits);
  const patch = formatPatch([{ file, before, after, hunks: buildHunks(file, before, after) }]);
  await writeFile(path.join(dir, 'cambio.patch'), patch);
  git('apply', '--whitespace=nowarn', 'cambio.patch');
  return { patch, result: await readFile(abs, 'utf8'), expected: joinLines(after) };
}

const FILE = Array.from({ length: 20 }, (_, i) => `línea ${i + 1}`).join('\n') + '\n';

describe('splitLines', () => {
  it('numera igual que el contexto enviado a la IA y conserva los finales de línea', () => {
    expect(splitLines('')).toEqual({ lines: [], crlf: [], finalNewline: false });
    expect(splitLines('a')).toEqual({ lines: ['a'], crlf: [false], finalNewline: false });
    expect(splitLines('a\n')).toEqual({ lines: ['a'], crlf: [false], finalNewline: true });
    expect(splitLines('a\r\n\r\nb')).toEqual({ lines: ['a', '', 'b'], crlf: [true, true, false], finalNewline: false });
    for (const t of ['', 'a', 'a\n', 'a\r\nb\r\n', 'x\n\ny']) expect(joinLines(splitLines(t))).toBe(t);
  });
});

describe('applyEdits', () => {
  it('sustituye, inserta más líneas y borra; rechaza rangos inválidos o solapados', () => {
    const src = splitLines('a\nb\nc\nd\n');
    expect(applyEdits(src, [{ startLine: 2, endLine: 2, replacement: 'B1\nB2' }]).lines).toEqual(['a', 'B1', 'B2', 'c', 'd']);
    expect(applyEdits(src, [{ startLine: 2, endLine: 3, replacement: '' }]).lines).toEqual(['a', 'd']);
    expect(applyEdits(src, [{ startLine: 4, endLine: 4, replacement: 'D' }, { startLine: 1, endLine: 1, replacement: 'A' }]).lines).toEqual(['A', 'b', 'c', 'D']);
    expect(() => applyEdits(src, [{ startLine: 3, endLine: 9, replacement: 'x' }])).toThrow(EditError);
    expect(() => applyEdits(src, [{ startLine: 0, endLine: 1, replacement: 'x' }])).toThrow(/no válido/);
    expect(() => applyEdits(src, [{ startLine: 1, endLine: 2, replacement: 'x' }, { startLine: 2, endLine: 3, replacement: 'y' }])).toThrow(/solapan/);
  });

  it('las líneas nuevas toman el final de línea predominante del archivo', () => {
    const after = applyEdits(splitLines('a\r\nb\r\nc\r\n'), [{ startLine: 2, endLine: 2, replacement: 'x\ny\n' }]);
    expect(after).toEqual({ lines: ['a', 'x', 'y', 'c'], crlf: [true, true, true, true], finalNewline: true });
  });
});

describe('diffOps', () => {
  it('alinea las líneas comunes y deja "- viejas / + nuevas" en cada cambio', () => {
    const kinds = (a: string[], b: string[]): string => diffOps(a, b).map((o) => (o.kind === 'context' ? ' ' : o.kind === 'removed' ? '-' : '+')).join('');
    expect(kinds(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe('   ');
    expect(kinds(['a', 'b', 'c'], ['a', 'x', 'c'])).toBe(' -+ ');
    expect(kinds(['a', 'b', 'c', 'd'], ['a', 'c', 'x', 'd'])).toBe(' - + ');
    expect(kinds([], ['x'])).toBe('+');
    expect(kinds(['x'], [])).toBe('-');
  });
});

describe('buildHunks y formatPatch', () => {
  it('bloques con 3 líneas de contexto; los cambios cercanos se unen y los lejanos no', () => {
    const before = splitLines(FILE);
    const near = buildHunks('a.ts', before, applyEdits(before, [{ startLine: 5, endLine: 5, replacement: 'X' }, { startLine: 9, endLine: 9, replacement: 'Y' }]));
    expect(near.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([[2, 11, 2, 11]]);
    const far = buildHunks('a.ts', before, applyEdits(before, [{ startLine: 2, endLine: 2, replacement: 'X' }, { startLine: 18, endLine: 18, replacement: 'Y' }]));
    expect(far.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [1, 5, 1, 5],
      [15, 6, 15, 6],
    ]);
    expect(far[0]?.lines.find((l) => l.kind === 'removed')).toEqual({ kind: 'removed', text: 'línea 2', oldLine: 2, newLine: null });
    expect(far[0]?.lines.find((l) => l.kind === 'added')).toEqual({ kind: 'added', text: 'X', oldLine: null, newLine: 2 });
  });

  it('sin cambios reales no hay parche', () => {
    const before = splitLines(FILE);
    const after = applyEdits(before, [{ startLine: 3, endLine: 4, replacement: 'línea 3\nlínea 4' }]);
    expect(buildHunks('a.ts', before, after)).toEqual([]);
    expect(formatPatch([{ file: 'a.ts', before, after, hunks: [] }])).toBe('');
  });

  it('git apply acepta el parche y produce el archivo esperado', async () => {
    const cases: Array<[string, LineEdit[]]> = [
      [FILE, [{ startLine: 10, endLine: 12, replacement: 'nueva A\nnueva B' }]],
      [FILE, [{ startLine: 1, endLine: 1, replacement: '// cabecera\nlínea 1' }, { startLine: 20, endLine: 20, replacement: '' }]],
      // CRLF: las líneas sin cambios conservan su \r y las nuevas también lo llevan.
      ['uno\r\ndos\r\ntres\r\ncuatro\r\n', [{ startLine: 2, endLine: 3, replacement: 'DOS\nTRES\nextra' }]],
      // Sin salto de línea final: se cambia la última línea y se añaden líneas tras ella.
      ['a\nb\nc', [{ startLine: 3, endLine: 3, replacement: 'C' }]],
      ['a\nb\nc', [{ startLine: 3, endLine: 3, replacement: 'c\nd\ne' }]],
      ['a\nb\nc', [{ startLine: 1, endLine: 1, replacement: 'A' }]],
      // Todo el archivo.
      ['x\ny\n', [{ startLine: 1, endLine: 2, replacement: 'z' }]],
    ];
    for (const [original, edits] of cases) {
      const { result, expected, patch } = await gitApply(original, edits);
      expect(result, patch).toBe(expected);
    }
  });

  it('el parche lleva las rutas relativas a la raíz y la cabecera de git', async () => {
    const { patch } = await gitApply(FILE, [{ startLine: 2, endLine: 2, replacement: 'X' }], 'src/pedidos/procesar.ts');
    expect(patch.split('\n').slice(0, 4)).toEqual(['diff --git a/src/pedidos/procesar.ts b/src/pedidos/procesar.ts', '--- a/src/pedidos/procesar.ts', '+++ b/src/pedidos/procesar.ts', '@@ -1,5 +1,5 @@']);
  });
});
