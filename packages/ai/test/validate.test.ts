import { describe, expect, it } from 'vitest';
import type { FindingContext } from '../src/context.js';
import { EXPLANATION_SCHEMA, PLAN_SCHEMA } from '../src/schemas.js';
import { extractJson, validateExplanation, validatePlan, ValidationError } from '../src/validate.js';

const ctx: FindingContext = {
  text: '',
  snippets: [{ file: 'src/p.ts', startLine: 4, endLine: 20 }],
  includesCode: true,
  knownNumbers: new Set(['31', '15', '10', '14']),
};
const base = {
  id_hallazgo: 'f1',
  resumen: 'La función tiene demasiadas ramas anidadas.',
  causa_raiz: 'Se fueron añadiendo casos sin refactorizar.',
  recomendacion: 'Extraer cada rama en funciones con nombre.',
  afirmaciones: [] as unknown[],
  confianza: 'alta',
  informacion_insuficiente: false,
};
const claim = (tipo: string, texto: string, archivo = '', linea_inicio = 0, linea_fin = 0) => ({ tipo, texto, archivo, linea_inicio, linea_fin });

describe('esquemas', () => {
  it('cumplen las restricciones de la salida estructurada (additionalProperties false, todo requerido, sin min/max)', () => {
    const check = (node: unknown): void => {
      if (typeof node !== 'object' || node === null) return;
      const o = node as Record<string, unknown>;
      if (o['type'] === 'object') {
        expect(o['additionalProperties']).toBe(false);
        expect([...(o['required'] as string[])].sort()).toEqual(Object.keys(o['properties'] as object).sort());
      }
      for (const k of ['minLength', 'maxLength', 'minimum', 'maximum', 'multipleOf']) expect(k in o).toBe(false);
      Object.values(o).forEach(check);
    };
    check(EXPLANATION_SCHEMA.schema);
    check(PLAN_SCHEMA.schema);
  });
});

describe('extractJson', () => {
  it('acepta JSON puro, envuelto en ```json o con texto alrededor', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Aquí está:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Respuesta: {"a":3} fin')).toEqual({ a: 3 });
    expect(() => extractJson('no hay json')).toThrow(ValidationError);
  });
});

describe('validateExplanation', () => {
  it('acepta evidencia citada dentro del fragmento y con cifras reales', () => {
    const v = validateExplanation({ ...base, afirmaciones: [claim('evidencia', 'La complejidad cognitiva es 31, el doble del umbral 15.'), claim('evidencia', 'El bucle anidado está aquí.', 'src/p.ts', 10, 14)] }, 'f1', ctx);
    expect(v.claims.map((c) => c.kind)).toEqual(['evidencia', 'evidencia']);
    expect(v.claims[1]?.lines).toEqual({ file: 'src/p.ts', startLine: 10, endLine: 14 });
    expect(v).toMatchObject({ confidence: 'alta', notes: [] });
  });

  it('degrada citas fuera del fragmento y cifras inventadas, y baja la confianza', () => {
    const v = validateExplanation(
      {
        ...base,
        afirmaciones: [
          claim('evidencia', 'Hay un error de concurrencia.', 'src/otro.ts', 1, 5),
          claim('evidencia', 'La función se llama 250 veces por segundo.'),
          claim('evidencia', 'El código es frágil.'),
          claim('recomendacion', 'Añadir pruebas.'),
        ],
      },
      'f1',
      ctx,
    );
    expect(v.claims.map((c) => c.kind)).toEqual(['inferencia', 'inferencia', 'inferencia', 'recomendacion']);
    expect(v.claims[0]?.lines).toBeUndefined();
    expect(v.notes.join(' ')).toMatch(/fuera del código enviado.*cifras que no están.*250.*sin cita/);
    expect(v.confidence).toBe('media');
  });

  it('los números de línea solo son válidos si la afirmación cita esas líneas', () => {
    const v = validateExplanation(
      { ...base, afirmaciones: [claim('evidencia', 'El bucle de las líneas 11 a 12 anida 4 niveles.', 'src/p.ts', 11, 12), claim('evidencia', 'Hay 12 ramas.')] },
      'f1',
      { ...ctx, knownNumbers: new Set(['4']) },
    );
    expect(v.claims.map((c) => c.kind)).toEqual(['evidencia', 'inferencia']);
  });

  it('normaliza mayúsculas y tildes en los enumerados', () => {
    const v = validateExplanation({ ...base, confianza: 'MEDIA', afirmaciones: [claim('Recomendación', 'Dividir la función.')] }, 'f1', ctx);
    expect(v.confidence).toBe('media');
    expect(v.claims[0]?.kind).toBe('recomendacion');
  });

  it('información insuficiente impide confianza alta', () => {
    expect(validateExplanation({ ...base, informacion_insuficiente: true }, 'f1', ctx).confidence).toBe('media');
  });

  it.each([
    [{ ...base, id_hallazgo: 'otro' }, /otro hallazgo/],
    [{ ...base, resumen: '' }, /vacío/],
    [{ ...base, confianza: 'total' }, /no válido/],
    [[], /objeto/],
  ])('rechaza respuestas mal formadas (%#)', (data, message) => {
    expect(() => validateExplanation(data, 'f1', ctx)).toThrow(message);
  });
});

describe('validatePlan', () => {
  const ids = new Set(['a', 'b', 'c']);
  it('conserva solo ids existentes, sin duplicados, renumera y avisa de lo omitido', () => {
    const plan = validatePlan(
      {
        pasos: [
          { hallazgos: ['b', 'inventado'], horizonte: 'Inmediato', titulo: 'Seguridad primero', justificacion: 'Riesgo alto.' },
          { hallazgos: ['inexistente'], horizonte: 'corto', titulo: 'Nada', justificacion: 'x' },
          { hallazgos: ['b', 'a'], horizonte: 'medio', titulo: 'Refactorizar', justificacion: 'Mayor esfuerzo.' },
        ],
        notas: ['Revisar tras el sprint.'],
      },
      ids,
    );
    expect(plan.steps.map((s) => [s.order, s.findingIds, s.horizon])).toEqual([
      [1, ['b'], 'inmediato'],
      [2, ['a'], 'medio'],
    ]);
    expect(plan.notes).toEqual(['Revisar tras el sprint.', 'Se ignoraron 2 identificador(es) que no corresponden a ningún hallazgo.', '1 hallazgo(s) de la lista no quedaron incluidos en el plan.']);
  });

  it('rechaza un plan sin pasos válidos', () => {
    expect(() => validatePlan({ pasos: [{ hallazgos: ['x'], horizonte: 'corto', titulo: 't', justificacion: 'j' }], notas: [] }, ids)).toThrow(/sin pasos|no contiene pasos/);
  });
});
