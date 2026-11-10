import type { FileAnalyzer, ProjectAnalyzer } from '../types.js';
import { architectureAnalyzer } from './architecture.js';
import { complexityAnalyzer } from './complexity.js';
import { dependenciesAnalyzer } from './dependencies.js';
import { duplicationAnalyzer, pythonDuplicationAnalyzer } from './duplication.js';
import { markersAnalyzer } from './markers.js';
import { pythonArchitectureAnalyzer } from './python-architecture.js';
import { pythonComplexityAnalyzer } from './python-complexity.js';
import { secretsAnalyzer } from './secrets.js';
import { sizeAnalyzer } from './size.js';
import { testingAnalyzer } from './testing.js';

/**
 * Registro de analizadores. Añadir un lenguaje o una regla nueva = implementar
 * `FileAnalyzer` o `ProjectAnalyzer` y registrarlo aquí; el núcleo no cambia.
 */
export const DEFAULT_FILE_ANALYZERS: readonly FileAnalyzer[] = [
  sizeAnalyzer as FileAnalyzer,
  complexityAnalyzer,
  duplicationAnalyzer as FileAnalyzer,
  architectureAnalyzer as FileAnalyzer,
  pythonComplexityAnalyzer,
  pythonDuplicationAnalyzer as FileAnalyzer,
  pythonArchitectureAnalyzer as FileAnalyzer,
  secretsAnalyzer,
  markersAnalyzer,
];

export const DEFAULT_PROJECT_ANALYZERS: readonly ProjectAnalyzer[] = [dependenciesAnalyzer, testingAnalyzer];

export {
  architectureAnalyzer,
  complexityAnalyzer,
  dependenciesAnalyzer,
  duplicationAnalyzer,
  markersAnalyzer,
  pythonArchitectureAnalyzer,
  pythonComplexityAnalyzer,
  pythonDuplicationAnalyzer,
  secretsAnalyzer,
  sizeAnalyzer,
  testingAnalyzer,
};
