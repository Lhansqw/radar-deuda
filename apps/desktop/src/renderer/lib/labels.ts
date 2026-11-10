import type { Category, Confidence, Severity } from '@radar/engine';
import type { JobPhase } from '../../shared/jobs.js';
import { tr } from '../i18n.js';

/** Nombres que ve el usuario (los mismos que la CLI). Se leen en el idioma actual. */
export const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  get critical() {
    return tr('Crítica', 'Critical');
  },
  get high() {
    return tr('Alta', 'High');
  },
  get medium() {
    return tr('Media', 'Medium');
  },
  get low() {
    return tr('Baja', 'Low');
  },
  get info() {
    return 'Info';
  },
};
export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export const CATEGORY_LABEL: Readonly<Record<Category, string>> = {
  get complexity() {
    return tr('Complejidad', 'Complexity');
  },
  get size() {
    return tr('Tamaño', 'Size');
  },
  get duplication() {
    return tr('Duplicación', 'Duplication');
  },
  get security() {
    return tr('Seguridad', 'Security');
  },
  get dependencies() {
    return tr('Dependencias', 'Dependencies');
  },
  get testing() {
    return tr('Pruebas', 'Tests');
  },
  get maintainability() {
    return tr('Mantenibilidad', 'Maintainability');
  },
};
/** Orden fijo de las categorías (también el de los sectores del radar). */
export const CATEGORIES: readonly Category[] = ['security', 'complexity', 'duplication', 'maintainability', 'size', 'dependencies', 'testing'];

export const CONFIDENCE_LABEL: Readonly<Record<Confidence, string>> = {
  get high() {
    return tr('alta', 'high');
  },
  get medium() {
    return tr('media', 'medium');
  },
  get low() {
    return tr('baja', 'low');
  },
};

export const RATING_HINT: Readonly<Record<'A' | 'B' | 'C' | 'D' | 'E', string>> = {
  get A() {
    return tr('Deuda baja: mantener', 'Low debt: maintain');
  },
  get B() {
    return tr('Deuda moderada', 'Moderate debt');
  },
  get C() {
    return tr('Deuda notable: conviene planificar', 'Notable debt: worth planning');
  },
  get D() {
    return tr('Deuda alta: prioriza reducirla', 'High debt: prioritize reducing it');
  },
  get E() {
    return tr('Deuda muy alta', 'Very high debt');
  },
};

/** Etapa de un análisis en curso. */
export function phaseLabel(phase: JobPhase): string {
  switch (phase) {
    case 'starting':
      return tr('Preparando', 'Preparing');
    case 'clone':
      return tr('Descargando el repositorio', 'Downloading the repository');
    case 'discovery':
      return tr('Buscando archivos', 'Finding files');
    case 'files':
      return tr('Analizando archivos', 'Analyzing files');
    case 'cross-file':
      return tr('Duplicación y dependencias entre módulos', 'Duplication and dependencies between modules');
    case 'project':
      return tr('Dependencias y pruebas', 'Dependencies and tests');
    case 'history':
      return tr('Leyendo el historial de Git', 'Reading the Git history');
    case 'saving':
      return tr('Guardando', 'Saving');
    case 'ai':
      return tr('Explicando con IA', 'Explaining with AI');
    case 'finished':
      return tr('Terminado', 'Finished');
  }
}
