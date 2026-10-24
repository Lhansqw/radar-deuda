import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  cloneFinding,
  duplicationAnalyzer,
  findCandidates,
  findClones,
  fingerprintSource,
  forEachToken,
  refineCandidates,
  type DuplicationArtifact,
} from '../src/analyzers/duplication.js';
import { resolveConfig } from '../src/config.js';
import { fileInput } from './helpers/file-input.js';
import { memoryStore } from './helpers/memory-store.js';

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

describe('caché de verificación por par', () => {
  const finalize = duplicationAnalyzer.finalize as NonNullable<typeof duplicationAnalyzer.finalize>;

  function setup(files: Record<string, string>) {
    const artifacts = new Map<string, DuplicationArtifact>();
    for (const [rel, text] of Object.entries(files)) {
      const art = duplicationAnalyzer.analyze(fileInput(rel, text), config).artifact;
      if (art) artifacts.set(rel, art);
    }
    let reads = 0;
    const readText = async (rel: string): Promise<string | null> => {
      reads++;
      return files[rel] ?? null;
    };
    return { artifacts, readText, reads: () => reads };
  }

  it('el reanálisis sin cambios no relee ningún archivo y da el mismo resultado', async () => {
    const files = { 'a.ts': BLOCK, 'b.ts': BLOCK, 'c.ts': `const x = 1;\n${BLOCK}` };
    const store = memoryStore();
    const first = setup(files);
    const cold = await finalize(first.artifacts, config, { readText: first.readText, store });
    expect(first.reads()).toBe(3);
    expect(store.writes).toBeGreaterThan(0);

    const second = setup(files);
    const warm = await finalize(second.artifacts, config, { readText: second.readText, store });
    expect(second.reads()).toBe(0);
    expect(warm).toEqual(cold);
  });

  it('si cambia un archivo solo se recalculan sus pares', async () => {
    const store = memoryStore();
    const v1 = { 'a.ts': BLOCK, 'b.ts': BLOCK, 'c.ts': BLOCK };
    const s1 = setup(v1);
    await finalize(s1.artifacts, config, { readText: s1.readText, store });

    const v2 = { ...v1, 'c.ts': `${BLOCK}\nexport const extra = 1;` };
    const s2 = setup(v2);
    const findings = await finalize(s2.artifacts, config, { readText: s2.readText, store });
    expect(s2.reads()).toBe(2); // c.ts y una de sus parejas; el par (a, b) sale del almacén
    expect(findings[0]?.locations).toHaveLength(3);
  });

  it('no guarda resultados si el archivo cambió entre el huellado y la verificación', async () => {
    const store = memoryStore();
    const s = setup({ 'a.ts': BLOCK, 'b.ts': BLOCK });
    await finalize(s.artifacts, config, { readText: async (rel) => (rel === 'b.ts' ? `${BLOCK}\n// editado` : BLOCK), store });
    expect(store.writes).toBe(0);
  });

  it('con un presupuesto mínimo de memoria el resultado es el mismo', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) files[`f${i}.ts`] = BLOCK;
    const { files: names, candidates } = findCandidates(setup(files).artifacts);
    const read = async (rel: string) => files[rel] ?? null;
    const amplio = await refineCandidates(names, [...candidates], read);
    const minimo = await refineCandidates(names, [...candidates], read, { tokenBudget: 1 });
    expect(minimo).toEqual(amplio);
  });
});
