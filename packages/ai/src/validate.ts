import type { AiClaim, AiPlanStep, ClaimKind } from '@radar/engine';
import { numbersIn, type FindingContext } from './context.js';
import type { RawClaim, RawExplanation, RawPlan } from './schemas.js';

/**
 * Validación de las respuestas del modelo. Ninguna respuesta se muestra ni se
 * guarda en caché sin pasar por aquí. Además de comprobar la forma, se
 * contrasta con lo que realmente se envió:
 * - una cita de líneas fuera de los fragmentos enviados no es evidencia;
 * - una "evidencia" con cifras que no aparecen en los datos enviados se
 *   degrada a inferencia (posible cifra inventada);
 * - el plan solo puede referirse a hallazgos existentes.
 */

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const MAX_TEXT = 2000;
const MAX_CLAIMS = 12;

/** Extrae el objeto JSON aunque el modelo lo envuelva en ```json … ``` o añada texto. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        /* sigue abajo */
      }
    }
    throw new ValidationError('La respuesta no contiene JSON válido.');
  }
}

function str(v: unknown, field: string, required = true): string {
  if (typeof v !== 'string') throw new ValidationError(`El campo "${field}" debe ser texto.`);
  const t = v.trim();
  if (required && t === '') throw new ValidationError(`El campo "${field}" está vacío.`);
  return t.slice(0, MAX_TEXT);
}

function enumValue<T extends string>(v: unknown, allowed: readonly T[], field: string): T {
  // La salida estructurada puede variar solo en mayúsculas: se compara sin distinguirlas.
  const s = typeof v === 'string' ? v.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '') : '';
  const hit = allowed.find((a) => a.normalize('NFD').replace(/[̀-ͯ]/g, '') === s);
  if (!hit) throw new ValidationError(`Valor no válido para "${field}": ${String(v)}`);
  return hit;
}

export interface ValidatedExplanation {
  summary: string;
  rootCause: string;
  recommendation: string;
  claims: AiClaim[];
  confidence: 'alta' | 'media' | 'baja';
  insufficientInformation: boolean;
  notes: string[];
}

function validateClaim(raw: RawClaim, ctx: FindingContext, notes: string[]): AiClaim | null {
  if (typeof raw !== 'object' || raw === null) return null;
  let kind: ClaimKind;
  try {
    kind = enumValue(raw.tipo, ['evidencia', 'inferencia', 'recomendacion'] as const, 'afirmaciones.tipo');
  } catch {
    notes.push('Se descartó una afirmación sin tipo válido.');
    return null;
  }
  const text = typeof raw.texto === 'string' ? raw.texto.trim().slice(0, 600) : '';
  if (!text) return null;
  const file = typeof raw.archivo === 'string' ? raw.archivo.trim() : '';
  const start = Number.isInteger(raw.linea_inicio) ? raw.linea_inicio : 0;
  const end = Number.isInteger(raw.linea_fin) && raw.linea_fin >= start ? raw.linea_fin : start;

  let lines: AiClaim['lines'];
  if (file && start > 0) {
    const inside = ctx.snippets.some((s) => s.file === file && start >= s.startLine && end <= s.endLine);
    if (inside) lines = { file, startLine: start, endLine: end };
    else {
      notes.push(`Cita fuera del código enviado (${file}:${start}-${end}): no se acepta como evidencia.`);
      if (kind === 'evidencia') kind = 'inferencia';
    }
  }
  if (kind === 'evidencia') {
    const invented = numbersIn(text).filter((n) => !ctx.knownNumbers.has(n));
    if (invented.length > 0) {
      notes.push(`"Evidencia" con cifras que no están en los datos enviados (${invented.slice(0, 3).join(', ')}): tratada como inferencia.`);
      kind = 'inferencia';
    } else if (!lines && numbersIn(text).length === 0) {
      // Sin cita ni cifra verificable, no hay forma de comprobarla.
      notes.push('"Evidencia" sin cita de código ni dato verificable: tratada como inferencia.');
      kind = 'inferencia';
    }
  }
  return { kind, text, ...(lines ? { lines } : {}) };
}

export function validateExplanation(data: unknown, findingId: string, ctx: FindingContext): ValidatedExplanation {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new ValidationError('La respuesta debe ser un objeto JSON.');
  const raw = data as Partial<RawExplanation>;
  if (typeof raw.id_hallazgo === 'string' && raw.id_hallazgo.trim() !== findingId) {
    throw new ValidationError(`La respuesta es de otro hallazgo (${raw.id_hallazgo}).`);
  }
  const notes: string[] = [];
  const claims = (Array.isArray(raw.afirmaciones) ? raw.afirmaciones : [])
    .slice(0, MAX_CLAIMS)
    .map((c) => validateClaim(c, ctx, notes))
    .filter((c): c is AiClaim => c !== null);
  let confidence = enumValue(raw.confianza, ['alta', 'media', 'baja'] as const, 'confianza');
  const insufficient = raw.informacion_insuficiente === true;
  // Si el propio modelo dice que no tiene datos suficientes, no puede declarar confianza alta.
  if (insufficient && confidence === 'alta') confidence = 'media';
  // Si hubo que degradar afirmaciones, la confianza global no puede ser alta.
  if (notes.length > 0 && confidence === 'alta') {
    confidence = 'media';
    notes.push('Confianza reducida a media por las correcciones anteriores.');
  }
  return {
    summary: str(raw.resumen, 'resumen'),
    rootCause: str(raw.causa_raiz, 'causa_raiz', false) || 'No determinada con la información disponible.',
    recommendation: str(raw.recomendacion, 'recomendacion'),
    claims,
    confidence,
    insufficientInformation: insufficient,
    notes,
  };
}

export interface ValidatedPlan {
  steps: AiPlanStep[];
  notes: string[];
}

export function validatePlan(data: unknown, knownIds: ReadonlySet<string>): ValidatedPlan {
  if (typeof data !== 'object' || data === null) throw new ValidationError('La respuesta debe ser un objeto JSON.');
  const raw = data as Partial<RawPlan>;
  if (!Array.isArray(raw.pasos)) throw new ValidationError('Falta la lista "pasos".');
  const notes: string[] = (Array.isArray(raw.notas) ? raw.notas : []).filter((n): n is string => typeof n === 'string').map((n) => n.slice(0, 500)).slice(0, 10);
  const used = new Set<string>();
  const unknown = new Set<string>();
  const steps: AiPlanStep[] = [];
  for (const p of raw.pasos.slice(0, 20)) {
    if (typeof p !== 'object' || p === null) continue;
    const ids = (Array.isArray(p.hallazgos) ? p.hallazgos : []).filter((id): id is string => typeof id === 'string');
    const valid = ids.filter((id) => {
      if (!knownIds.has(id)) {
        unknown.add(id);
        return false;
      }
      if (used.has(id)) return false;
      used.add(id);
      return true;
    });
    if (valid.length === 0) continue;
    steps.push({
      order: steps.length + 1,
      findingIds: valid,
      horizon: enumValue(p.horizonte, ['inmediato', 'corto', 'medio'] as const, 'horizonte'),
      title: str(p.titulo, 'titulo'),
      rationale: str(p.justificacion, 'justificacion'),
    });
  }
  if (steps.length === 0) throw new ValidationError('El plan no contiene pasos con hallazgos válidos.');
  if (unknown.size > 0) notes.push(`Se ignoraron ${unknown.size} identificador(es) que no corresponden a ningún hallazgo.`);
  const missing = [...knownIds].filter((id) => !used.has(id)).length;
  if (missing > 0) notes.push(`${missing} hallazgo(s) de la lista no quedaron incluidos en el plan.`);
  return { steps, notes };
}
