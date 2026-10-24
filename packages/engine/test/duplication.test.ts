import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { cloneFinding, findClones, fingerprintSource, forEachToken, type DuplicationArtifact } from '../src/analyzers/duplication.js';
import { resolveConfig } from '../src/config.js';

const config = resolveConfig();

/** Bloque de ~12 líneas y >100 tokens que se repetirá entre archivos. */
const BLOCK = `
export function validar(nombre: string, correo: string, telefono: string): string[] {
  const errores: string[] = [];
  if (!nombre || nombre.trim().length < 3) {
    errores.push('El nombre debe tener al menos 3 caracteres');
  }
  if (!correo || !correo.includes('@') || correo.startsWith('@')) {
    errores.push('El correo no es válido');
  }
  if (!telefono || telefono.replace(/\\D/g, '').length < 7) {
    errores.push('El teléfono debe tener al menos 7 dígitos');
  }
  return errores;
}`;

async function clonesIn(files: Record<string, string>) {
  const artifacts = new Map<string, DuplicationArtifact>();
  for (const [rel, text] of Object.entries(files)) artifacts.set(rel, fingerprintSource(text, rel));
  return findClones(artifacts, config, async (rel) => files[rel] ?? null);
}

describe('forEachToken', () => {
  const kinds = (code: string): ts.SyntaxKind[] => {
    const out: ts.SyntaxKind[] = [];
    forEachToken(ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, code), (k) => out.push(k));
    return out;
  };

  it('distingue expresiones regulares de divisiones', () => {
    expect(kinds('x = a / b / c')).not.toContain(ts.SyntaxKind.RegularExpressionLiteral);
    expect(kinds('x = /ab+c/g.test(s)')).toContain(ts.SyntaxKind.RegularExpressionLiteral);
  });

  it('reconoce sustituciones en plantillas', () => {
    const k = kinds('const s = `a${b}c${d}e`;');
    expect(k).toContain(ts.SyntaxKind.TemplateHead);
    expect(k).toContain(ts.SyntaxKind.TemplateMiddle);
    expect(k).toContain(ts.SyntaxKind.TemplateTail);
  });
});

describe('detección de clones', () => {
  it('encuentra un bloque idéntico entre dos archivos con las líneas exactas', async () => {
    const a = `import x from './x';\n${BLOCK}\n`;
    const b = `// otro archivo\nconst y = 1;\nconst z = 2;\n${BLOCK}\nexport const fin = true;\n`;
    const classes = await clonesIn({ 'src/a.ts': a, 'src/b.ts': b });
    expect(classes).toHaveLength(1);
    const [ra, rb] = classes[0] ?? [];
    expect(ra).toMatchObject({ file: 'src/a.ts', startLine: 3, endLine: 15 });
    expect(rb).toMatchObject({ file: 'src/b.ts', startLine: 5, endLine: 17 });
  });

  it('ignora diferencias de espacios y comentarios (clones de tipo 1)', async () => {
    const reformateado = BLOCK.replace(/\n {2}/g, '\n      // comentario añadido\n      ');
    const classes = await clonesIn({ 'a.ts': BLOCK, 'b.ts': reformateado });
    expect(classes).toHaveLength(1);
  });

  it('no reporta código distinto', async () => {
    const otro = BLOCK.replace(/errores/g, 'problemas').replace(/nombre/g, 'titulo');
    expect(await clonesIn({ 'a.ts': BLOCK, 'b.ts': otro })).toEqual([]);
  });

  it('detecta clones dentro del mismo archivo sin regiones solapadas', async () => {
    const text = `${BLOCK.replace('validar', 'validarA')}\n${BLOCK.replace('validar', 'validarB')}\n`;
    const classes = await clonesIn({ 'a.ts': text });
    expect(classes).toHaveLength(1);
    const [r1, r2] = classes[0] ?? [];
    expect(r1 && r2 && r1.endLine < r2.startLine).toBe(true);
  });

  it('agrupa tres copias en una sola clase de clones', async () => {
    const classes = await clonesIn({ 'a.ts': BLOCK, 'b.ts': BLOCK, 'c.ts': BLOCK });
    expect(classes).toHaveLength(1);
    expect(classes[0]?.map((r) => r.file)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('descarta coincidencias si el archivo cambió desde que se tomaron las huellas', async () => {
    const artifacts = new Map([
      ['a.ts', fingerprintSource(BLOCK, 'a.ts')],
      ['b.ts', fingerprintSource(BLOCK, 'b.ts')],
    ]);
    const classes = await findClones(artifacts, config, async (rel) => (rel === 'b.ts' ? 'const totalmente = "distinto";' : BLOCK));
    expect(classes).toEqual([]);
  });

  it('las huellas son pocas en comparación con los tokens (artefacto pequeño)', () => {
    const art = fingerprintSource(BLOCK.repeat(10), 'a.ts');
    expect(art.fps.length).toBeLessThan(art.tokens / 5);
  });
});

describe('cloneFinding', () => {
  it('incluye todas las ubicaciones, evidencia verificable y esfuerzo proporcional', async () => {
    const [cls] = await clonesIn({ 'a.ts': BLOCK, 'b.ts': BLOCK });
    if (!cls) throw new Error('se esperaba una clase de clones');
    const f = cloneFinding(cls);
    expect(f.ruleId).toBe('duplication/clone');
    expect(f.locations).toHaveLength(2);
    expect(f.evidence[0]?.kind).toBe('clone');
    expect(f.effort.minutes).toBeGreaterThan(20);
  });
});
