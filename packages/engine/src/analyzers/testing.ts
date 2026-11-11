import type { Finding, ProjectAnalyzer } from '../types.js';
import { findingId } from '../util.js';
import { translator } from '../i18n.js';

/**
 * Heurística de pruebas insuficientes basada en convenciones de nombres.
 * Confianza media: no mide cobertura real (eso requiere ejecutar las pruebas,
 * algo que nunca hacemos automáticamente con código de terceros).
 */
const ID = 'testing';
const VERSION = '1.1.0';
const TOOL = `${ID}@${VERSION}`;

const CONFIG_FILE = /(^|\/)[^/]*\.config\.[cm]?[jt]s$|(^|\/)\.[^/]+rc\.[cm]?[jt]s$/;
/** Python: archivos de paquete, de instalación y de configuración de pytest, que no son código a probar. */
const PYTHON_NOT_SOURCE = /(^|\/)(__init__|__main__|setup|conftest|manage)\.py$/;
const TESTED_LANGUAGES = new Set(['typescript', 'javascript', 'python']);

export const testingAnalyzer: ProjectAnalyzer = {
  id: ID,
  version: VERSION,
  description: 'Proporción entre archivos de prueba y de código fuente.',
  async analyzeProject(ctx) {
    const code = ctx.files.filter((f) => f.isCode && TESTED_LANGUAGES.has(f.language));
    const tests = code.filter((f) => f.isTest);
    const sources = code.filter((f) => !f.isTest && !CONFIG_FILE.test(f.relPath) && !PYTHON_NOT_SOURCE.test(f.relPath) && !f.relPath.endsWith('.d.ts'));
    if (sources.length < 5) return [];

    const ratio = tests.length / sources.length;
    const tr = translator(ctx.config.locale);
    const findings: Finding[] = [];
    if (tests.length === 0) {
      findings.push({
        id: findingId('testing/no-tests', '.', 'project'),
        ruleId: 'testing/no-tests',
        category: 'testing',
        severity: 'high',
        confidence: 'medium',
        title: tr('No se detectaron pruebas automatizadas', 'No automated tests detected'),
        message: tr(
          `Hay ${sources.length} archivos de código (JS/TS y Python) y ningún archivo de prueba según las convenciones habituales (*.test.*, *.spec.*, __tests__/, test/, test_*.py, *_test.py).`,
          `There are ${sources.length} code files (JS/TS and Python) and no test files under the usual conventions (*.test.*, *.spec.*, __tests__/, test/, test_*.py, *_test.py).`,
        ),
        locations: [{ file: '.', startLine: 1, endLine: 1 }],
        evidence: [{ kind: 'fact', tool: TOOL, description: tr('Conteo por convención de nombres', 'Count by naming convention'), metric: { name: 'testFiles', value: 0, threshold: 1 } }],
        impact: tr('Sin pruebas, cada refactorización para reducir deuda técnica conlleva riesgo de regresiones no detectadas.', 'Without tests, every refactoring to reduce technical debt risks undetected regressions.'),
        effort: {
          minutes: Math.min(2400, sources.length * 20),
          rationale: tr('20 min por archivo de código para pruebas mínimas de los caminos principales (máx. 40 h).', '20 min per code file for minimal tests of the main paths (max. 40 h).'),
        },
      });
    } else if (ratio < 0.2) {
      findings.push({
        id: findingId('testing/low-ratio', '.', 'project'),
        ruleId: 'testing/low-ratio',
        category: 'testing',
        severity: 'medium',
        confidence: 'medium',
        title: tr(`Pocas pruebas en relación con el código (${tests.length} de ${sources.length})`, `Few tests relative to the code (${tests.length} of ${sources.length})`),
        message: tr(
          `La proporción de archivos de prueba por archivo de código es ${ratio.toFixed(2)} (referencia mínima 0,20). Es una aproximación; no sustituye a la cobertura real.`,
          `The ratio of test files per code file is ${ratio.toFixed(2)} (minimum reference 0.20). It is an approximation; it does not replace real coverage.`,
        ),
        locations: [{ file: '.', startLine: 1, endLine: 1 }],
        evidence: [{ kind: 'metric', tool: TOOL, description: tr('Archivos de prueba / archivos de código', 'Test files / code files'), metric: { name: 'testRatio', value: Number(ratio.toFixed(3)), threshold: 0.2 } }],
        impact: tr('Las zonas sin pruebas son las más arriesgadas de modificar.', 'Untested areas are the riskiest to change.'),
        effort: {
          minutes: Math.min(1200, Math.round((0.2 * sources.length - tests.length) * 30)),
          rationale: tr('30 min por archivo de prueba que falta para alcanzar la proporción 0,20 (máx. 20 h).', '30 min per missing test file to reach the 0.20 ratio (max. 20 h).'),
        },
      });
    }
    return findings;
  },
};
