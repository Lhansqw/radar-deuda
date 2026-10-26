import type { Category, Confidence, Severity } from '@radar/engine';

/** Nombres que ve el usuario (los mismos que la CLI). */
export const SEVERITY_LABEL: Readonly<Record<Severity, string>> = { critical: 'Crítica', high: 'Alta', medium: 'Media', low: 'Baja', info: 'Info' };
export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export const CATEGORY_LABEL: Readonly<Record<Category, string>> = {
  complexity: 'Complejidad',
  size: 'Tamaño',
  duplication: 'Duplicación',
  security: 'Seguridad',
  dependencies: 'Dependencias',
  testing: 'Pruebas',
  maintainability: 'Mantenibilidad',
};
/** Orden fijo de las categorías (también el de los sectores del radar). */
export const CATEGORIES: readonly Category[] = ['security', 'complexity', 'duplication', 'maintainability', 'size', 'dependencies', 'testing'];

export const CONFIDENCE_LABEL: Readonly<Record<Confidence, string>> = { high: 'alta', medium: 'media', low: 'baja' };

export const RATING_HINT: Readonly<Record<'A' | 'B' | 'C' | 'D' | 'E', string>> = {
  A: 'Deuda baja: mantener',
  B: 'Deuda moderada',
  C: 'Deuda notable: conviene planificar',
  D: 'Deuda alta: prioriza reducirla',
  E: 'Deuda muy alta',
};
