import { describe, expect, it } from 'vitest';
import { markersAnalyzer, scanMarkers } from '../src/analyzers/markers.js';
import { resolveConfig } from '../src/config.js';
import { fileInput } from './helpers/file-input.js';

describe('scanMarkers', () => {
  it('reconoce marcadores en distintos estilos de comentario', () => {
    const lines = ['// TODO: revisar', '# FIXME(nik) urgente', '/* HACK temporal */', ' * XXX en JSDoc', '<!-- TODO html -->', '-- TODO sql'];
    expect(scanMarkers(lines).map((m) => [m.tag, m.line])).toEqual([
      ['TODO', 1],
      ['FIXME', 2],
      ['HACK', 3],
      ['XXX', 4],
      ['TODO', 5],
      ['TODO', 6],
    ]);
  });

  it('ignora la palabra fuera de comentarios o como parte de otra palabra', () => {
    expect(scanMarkers(['const TODO_LIST = [];', 'const s = "TODOS";', '// TODOS los casos'])).toEqual([]);
  });
});

describe('markersAnalyzer', () => {
  it('genera un único hallazgo por archivo con todas las ubicaciones', () => {
    const code = '// TODO: a\nconst x = 1;\n// FIXME: b\n// TODO: c';
    const { findings } = markersAnalyzer.analyze(fileInput('src/a.ts', code), resolveConfig());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('low');
    expect(findings[0]?.locations.map((l) => l.startLine)).toEqual([1, 3, 4]);
    expect(findings[0]?.effort.minutes).toBe(30 + 2 * 10);
  });

  it('un archivo solo con TODO genera un hallazgo informativo', () => {
    const { findings } = markersAnalyzer.analyze(fileInput('src/a.ts', '// TODO: luego'), resolveConfig());
    expect(findings[0]?.severity).toBe('info');
  });
});
