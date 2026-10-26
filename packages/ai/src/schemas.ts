import type { JsonSchemaSpec } from './provider.js';

/**
 * Esquemas de salida. Cumplen las restricciones de la salida estructurada de
 * Anthropic y del modo "strict" de OpenAI: todos los campos requeridos,
 * additionalProperties: false y sin minLength/maximum. Los campos opcionales
 * se expresan con valores vacíos ("" o 0).
 */

const claim = {
  type: 'object',
  additionalProperties: false,
  required: ['tipo', 'texto', 'archivo', 'linea_inicio', 'linea_fin'],
  properties: {
    tipo: { type: 'string', enum: ['evidencia', 'inferencia', 'recomendacion'] },
    texto: { type: 'string' },
    archivo: { type: 'string', description: 'Archivo citado del fragmento enviado, o "" si no cita código.' },
    linea_inicio: { type: 'integer', description: 'Primera línea citada, o 0.' },
    linea_fin: { type: 'integer', description: 'Última línea citada, o 0.' },
  },
};

export const EXPLANATION_SCHEMA: JsonSchemaSpec = {
  name: 'explicacion_hallazgo',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['id_hallazgo', 'resumen', 'causa_raiz', 'recomendacion', 'afirmaciones', 'confianza', 'informacion_insuficiente'],
    properties: {
      id_hallazgo: { type: 'string' },
      resumen: { type: 'string', description: 'Qué ocurre y por qué importa, en 2–4 frases.' },
      causa_raiz: { type: 'string', description: 'Causa probable. Es una inferencia: dilo si no hay datos suficientes.' },
      recomendacion: { type: 'string', description: 'Acción concreta adaptada al lenguaje y framework del proyecto.' },
      afirmaciones: { type: 'array', items: claim },
      confianza: { type: 'string', enum: ['alta', 'media', 'baja'] },
      informacion_insuficiente: { type: 'boolean' },
    },
  },
};

export interface RawClaim {
  tipo: string;
  texto: string;
  archivo: string;
  linea_inicio: number;
  linea_fin: number;
}

export interface RawExplanation {
  id_hallazgo: string;
  resumen: string;
  causa_raiz: string;
  recomendacion: string;
  afirmaciones: RawClaim[];
  confianza: string;
  informacion_insuficiente: boolean;
}

export const PLAN_SCHEMA: JsonSchemaSpec = {
  name: 'plan_reduccion_deuda',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['pasos', 'notas'],
    properties: {
      pasos: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['hallazgos', 'horizonte', 'titulo', 'justificacion'],
          properties: {
            hallazgos: { type: 'array', items: { type: 'string' }, description: 'Ids de hallazgos de la lista recibida.' },
            horizonte: { type: 'string', enum: ['inmediato', 'corto', 'medio'] },
            titulo: { type: 'string' },
            justificacion: { type: 'string', description: 'Por qué en este orden: impacto, riesgo, urgencia y esfuerzo.' },
          },
        },
      },
      notas: { type: 'array', items: { type: 'string' } },
    },
  },
};

export interface RawPlan {
  pasos: Array<{ hallazgos: string[]; horizonte: string; titulo: string; justificacion: string }>;
  notas: string[];
}
