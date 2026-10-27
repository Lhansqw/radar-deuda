import path from 'node:path';
import type { Finding, ProjectAnalyzer, ProjectContext } from '../types.js';
import { findingId, splitLines } from '../util.js';

/**
 * Higiene de dependencias npm, sin red. Las dependencias desactualizadas y las
 * vulnerabilidades conocidas (OSV / GitHub Advisory) requieren consultas de red
 * y se incorporan en la fase 6; el informe lo declara en `coverage`.
 */
const ID = 'dependencies';
const VERSION = '1.0.0';
const TOOL = `${ID}@${VERSION}`;

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'];
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

type Manifest = Partial<Record<(typeof SECTIONS)[number], Record<string, unknown>>> & { private?: unknown; workspaces?: unknown };

function lineOf(lines: readonly string[], name: string): number {
  const needle = `"${name}"`;
  const idx = lines.findIndex((l) => l.includes(needle));
  return idx >= 0 ? idx + 1 : 1;
}

function isUnbounded(spec: string): boolean {
  const s = spec.trim();
  return s === '' || s === '*' || s === 'latest' || s === 'x' || s === 'next' || /^>=?\s*\d/.test(s) && !/</.test(s);
}

function isNonRegistry(spec: string): boolean {
  return /^(git\+|git:|github:|https?:|file:|link:)/.test(spec) || /^[\w-]+\/[\w.-]+(#.*)?$/.test(spec);
}

async function hasLockfile(ctx: ProjectContext, manifestRel: string): Promise<boolean> {
  let dir = path.posix.dirname(manifestRel);
  for (;;) {
    for (const lf of LOCKFILES) {
      if (await ctx.exists(dir === '.' ? lf : `${dir}/${lf}`)) return true;
    }
    if (dir === '.' || dir === '') return false;
    dir = path.posix.dirname(dir);
  }
}

interface Declared {
  section: string;
  name: string;
  spec: string;
}

/** Las dependencias declaradas con versión de texto, sección por sección. */
function declared(manifest: Manifest): Declared[] {
  return SECTIONS.flatMap((section) => {
    const deps = manifest[section];
    if (!deps || typeof deps !== 'object') return [];
    return Object.entries(deps).flatMap(([name, spec]) => (typeof spec === 'string' ? [{ section, name, spec }] : []));
  });
}

/** Una ubicación por dependencia afectada: la línea donde se declara. */
function perDependency(rel: string, lines: readonly string[], names: readonly string[]): Finding['locations'] {
  return names.map((name) => ({ file: rel, startLine: lineOf(lines, name), endLine: lineOf(lines, name), symbol: name }));
}

function specEvidence(deps: readonly Declared[]): Finding['evidence'] {
  return deps.map((d) => ({ kind: 'fact' as const, tool: TOOL, description: `${d.section}.${d.name}`, snippet: `"${d.name}": "${d.spec}"` }));
}

const names = (deps: readonly Declared[]): string[] => deps.map((d) => d.name);

function invalidManifest(rel: string): Finding {
  return {
    id: findingId('dependencies/invalid-manifest', rel, 'json'),
    ruleId: 'dependencies/invalid-manifest',
    category: 'dependencies',
    severity: 'medium',
    confidence: 'high',
    title: 'package.json no es JSON válido',
    message: 'El manifiesto no se puede interpretar; las herramientas de construcción y auditoría fallarán.',
    locations: [{ file: rel, startLine: 1, endLine: 1 }],
    evidence: [{ kind: 'fact', tool: TOOL, description: 'JSON.parse falló' }],
    impact: 'Instalaciones y auditorías no reproducibles.',
    effort: { minutes: 10, rationale: 'Corrección de sintaxis (estimación fija).' },
  };
}

function noLockfile(rel: string, count: number): Finding {
  return {
    id: findingId('dependencies/no-lockfile', rel, 'lock'),
    ruleId: 'dependencies/no-lockfile',
    category: 'dependencies',
    severity: 'medium',
    confidence: 'high',
    title: 'Dependencias sin archivo de bloqueo (lockfile)',
    message: `El manifiesto declara ${count} dependencias pero no hay package-lock.json, yarn.lock, pnpm-lock.yaml ni bun.lock en su directorio ni en los superiores.`,
    locations: [{ file: rel, startLine: 1, endLine: 1 }],
    evidence: [{ kind: 'fact', tool: TOOL, description: `Lockfiles buscados: ${LOCKFILES.join(', ')}` }],
    impact: 'Cada instalación puede resolver versiones distintas: builds no reproducibles y auditoría de vulnerabilidades imprecisa.',
    effort: { minutes: 15, rationale: 'Generar y versionar el lockfile, verificar el build (estimación fija).' },
  };
}

function unboundedRange(rel: string, lines: readonly string[], deps: readonly Declared[]): Finding {
  return {
    id: findingId('dependencies/unbounded-range', rel, names(deps).sort().join(',')),
    ruleId: 'dependencies/unbounded-range',
    category: 'dependencies',
    severity: 'medium',
    confidence: 'high',
    title: `Versiones sin límite superior (${deps.length})`,
    message: `Dependencias con rangos abiertos: ${deps.map((d) => `${d.name}@"${d.spec}"`).join(', ')}.`,
    locations: perDependency(rel, lines, names(deps)),
    evidence: specEvidence(deps),
    impact: 'Una nueva versión mayor con cambios incompatibles puede instalarse sin aviso.',
    effort: { minutes: 5 * deps.length, rationale: '5 min por dependencia para fijar un rango compatible (^ o ~).' },
  };
}

function nonRegistry(rel: string, lines: readonly string[], deps: readonly Declared[]): Finding {
  return {
    id: findingId('dependencies/non-registry', rel, names(deps).sort().join(',')),
    ruleId: 'dependencies/non-registry',
    category: 'dependencies',
    severity: 'low',
    confidence: 'high',
    title: `Dependencias fuera del registro npm (${deps.length})`,
    message: `Se instalan desde Git, URL o rutas locales: ${names(deps).join(', ')}.`,
    locations: perDependency(rel, lines, names(deps)),
    evidence: specEvidence(deps),
    impact: 'No reciben avisos de seguridad del registro y pueden cambiar sin control de versiones semántico.',
    effort: { minutes: 20 * deps.length, rationale: '20 min por dependencia para migrar a una versión publicada o documentar la excepción.' },
  };
}

/** `dupes` ya ordenadas: el id, el mensaje y las ubicaciones siguen ese orden. */
function duplicated(rel: string, lines: readonly string[], dupes: readonly string[]): Finding {
  return {
    id: findingId('dependencies/duplicated', rel, dupes.join(',')),
    ruleId: 'dependencies/duplicated',
    category: 'dependencies',
    severity: 'low',
    confidence: 'high',
    title: `Dependencias declaradas dos veces (${dupes.length})`,
    message: `Aparecen en dependencies y devDependencies: ${dupes.join(', ')}.`,
    locations: perDependency(rel, lines, dupes),
    evidence: [{ kind: 'fact', tool: TOOL, description: 'Intersección de dependencies y devDependencies' }],
    impact: 'Ambigüedad sobre qué versión se usa en producción.',
    effort: { minutes: 5 * dupes.length, rationale: '5 min por dependencia.' },
  };
}

/** Los hallazgos de un package.json. */
async function analyzeManifest(ctx: ProjectContext, rel: string): Promise<Finding[]> {
  const text = await ctx.readText(rel);
  if (text === null) return [];
  let manifest: Manifest;
  try {
    manifest = JSON.parse(text) as Manifest;
  } catch {
    return [invalidManifest(rel)];
  }
  const runtime = declared(manifest).filter((d) => d.section !== 'peerDependencies');
  if (runtime.length === 0) return [];
  const lines = splitLines(text);
  const findings: Finding[] = [];
  if (!(await hasLockfile(ctx, rel))) findings.push(noLockfile(rel, runtime.length));
  const unbounded = runtime.filter((d) => isUnbounded(d.spec));
  if (unbounded.length > 0) findings.push(unboundedRange(rel, lines, unbounded));
  const outside = runtime.filter((d) => isNonRegistry(d.spec));
  if (outside.length > 0) findings.push(nonRegistry(rel, lines, outside));
  const prod = new Set(Object.keys(manifest.dependencies ?? {}));
  const dupes = Object.keys(manifest.devDependencies ?? {}).filter((n) => prod.has(n)).sort();
  if (dupes.length > 0) findings.push(duplicated(rel, lines, dupes));
  return findings;
}

export const dependenciesAnalyzer: ProjectAnalyzer = {
  id: ID,
  version: VERSION,
  description: 'Manifiestos npm: lockfile ausente, rangos sin límite, fuentes fuera del registro, duplicados.',
  async analyzeProject(ctx) {
    const findings: Finding[] = [];
    for (const meta of ctx.files) {
      if (path.posix.basename(meta.relPath) === 'package.json') findings.push(...(await analyzeManifest(ctx, meta.relPath)));
    }
    return findings;
  },
};
