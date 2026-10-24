import type { Finding, ProjectAnalyzer } from '../types.js';
import { findingId } from '../util.js';

/**
 * Heurística de pruebas insuficientes basada en convenciones de nombres.
 * Confianza media: no mide cobertura real (eso requiere ejecutar las pruebas,
 * algo que nunca hacemos automáticamente con código de terceros).
 */
const ID = 'testing';
const VERSION = '1.0.0';
const TOOL = `${ID}@${VERSION}`;

const CONFIG_FILE = /(^|\/)[^/]*\.config\.[cm]?[jt]s$|(^|\/)\.[^/]+rc\.[cm]?[jt]s$/;

export const testingAnalyzer: ProjectAnalyzer = {
  id: ID,
  version: VERSION,
  description: 'Proporción entre archivos de prueba y de código fuente.',
  async analyzeProject(ctx) {
    const code = ctx.files.filter((f) => f.isCode && (f.language === 'typescript' || f.language === 'javascript'));
    const tests = code.filter((f) => f.isTest);
    const sources = code.filter((f) => !f.isTest && !CONFIG_FILE.test(f.relPath) && !f.relPath.endsWith('.d.ts'));
    if (sources.length < 5) return [];

    const ratio = tests.length / sources.length;
    const findings: Finding[] = [];
    if (tests.length === 0) {
      findings.push({
        id: findingId('testing/no-tests', '.', 'project'),
        ruleId: 'testing/no-tests',
        category: 'testing',
        severity: 'high',
        confidence: 'medium',
        title: 'No se detectaron pruebas automatizadas',
        message: `Hay ${sources.length} archivos de código JS/TS y ningún archivo de prueba según las convenciones habituales (*.test.*, *.spec.*, __tests__/, test/).`,
        locations: [{ file: '.', startLine: 1, endLine: 1 }],
        evidence: [{ kind: 'fact', tool: TOOL, description: 'Conteo por convención de nombres', metric: { name: 'testFiles', value: 0, threshold: 1 } }],
        impact: 'Sin pruebas, cada refactorización para reducir deuda técnica conlleva riesgo de regresiones no detectadas.',
        effort: { minutes: Math.min(2400, sources.length * 20), rationale: '20 min por archivo de código para pruebas mínimas de los caminos principales (máx. 40 h).' },
      });
    } else if (ratio < 0.2) {
      findings.push({
        id: findingId('testing/low-ratio', '.', 'project'),
        ruleId: 'testing/low-ratio',
        category: 'testing',
        severity: 'medium',
        confidence: 'medium',
        title: `Pocas pruebas en relación con el código (${tests.length} de ${sources.length})`,
        message: `La proporción de archivos de prueba por archivo de código es ${ratio.toFixed(2)} (referencia mínima 0,20). Es una aproximación; no sustituye a la cobertura real.`,
        locations: [{ file: '.', startLine: 1, endLine: 1 }],
        evidence: [{ kind: 'metric', tool: TOOL, description: 'Archivos de prueba / archivos de código', metric: { name: 'testRatio', value: Number(ratio.toFixed(3)), threshold: 0.2 } }],
        impact: 'Las zonas sin pruebas son las más arriesgadas de modificar.',
        effort: { minutes: Math.min(1200, Math.round((0.2 * sources.length - tests.length) * 30)), rationale: '30 min por archivo de prueba que falta para alcanzar la proporción 0,20 (máx. 20 h).' },
      });
    }
    return findings;
  },
};
