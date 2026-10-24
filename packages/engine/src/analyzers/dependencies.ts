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

export const dependenciesAnalyzer: ProjectAnalyzer = {
  id: ID,
  version: VERSION,
  description: 'Manifiestos npm: lockfile ausente, rangos sin límite, fuentes fuera del registro, duplicados.',
  async analyzeProject(ctx) {
    const findings: Finding[] = [];
    const manifests = ctx.files.filter((f) => path.posix.basename(f.relPath) === 'package.json');
    for (const meta of manifests) {
      const text = await ctx.readText(meta.relPath);
      if (text === null) continue;
      let manifest: Manifest;
      try {
        manifest = JSON.parse(text) as Manifest;
      } catch {
        findings.push({
          id: findingId('dependencies/invalid-manifest', meta.relPath, 'json'),
          ruleId: 'dependencies/invalid-manifest',
          category: 'dependencies',
          severity: 'medium',
          confidence: 'high',
          title: 'package.json no es JSON válido',
          message: 'El manifiesto no se puede interpretar; las herramientas de construcción y auditoría fallarán.',
          locations: [{ file: meta.relPath, startLine: 1, endLine: 1 }],
          evidence: [{ kind: 'fact', tool: TOOL, description: 'JSON.parse falló' }],
          impact: 'Instalaciones y auditorías no reproducibles.',
          effort: { minutes: 10, rationale: 'Corrección de sintaxis (estimación fija).' },
        });
        continue;
      }
      const lines = splitLines(text);
      const all: Array<{ section: string; name: string; spec: string }> = [];
      for (const section of SECTIONS) {
        const deps = manifest[section];
        if (deps && typeof deps === 'object') {
          for (const [name, spec] of Object.entries(deps)) if (typeof spec === 'string') all.push({ section, name, spec });
        }
      }
      const runtime = all.filter((d) => d.section !== 'peerDependencies');
      if (runtime.length === 0) continue;

      if (!(await hasLockfile(ctx, meta.relPath))) {
        findings.push({
          id: findingId('dependencies/no-lockfile', meta.relPath, 'lock'),
          ruleId: 'dependencies/no-lockfile',
          category: 'dependencies',
          severity: 'medium',
          confidence: 'high',
          title: 'Dependencias sin archivo de bloqueo (lockfile)',
          message: `El manifiesto declara ${runtime.length} dependencias pero no hay package-lock.json, yarn.lock, pnpm-lock.yaml ni bun.lock en su directorio ni en los superiores.`,
          locations: [{ file: meta.relPath, startLine: 1, endLine: 1 }],
          evidence: [{ kind: 'fact', tool: TOOL, description: `Lockfiles buscados: ${LOCKFILES.join(', ')}` }],
          impact: 'Cada instalación puede resolver versiones distintas: builds no reproducibles y auditoría de vulnerabilidades imprecisa.',
          effort: { minutes: 15, rationale: 'Generar y versionar el lockfile, verificar el build (estimación fija).' },
        });
      }

      const unbounded = runtime.filter((d) => isUnbounded(d.spec));
      if (unbounded.length > 0) {
        findings.push({
          id: findingId('dependencies/unbounded-range', meta.relPath, unbounded.map((d) => d.name).sort().join(',')),
          ruleId: 'dependencies/unbounded-range',
          category: 'dependencies',
          severity: 'medium',
          confidence: 'high',
          title: `Versiones sin límite superior (${unbounded.length})`,
          message: `Dependencias con rangos abiertos: ${unbounded.map((d) => `${d.name}@"${d.spec}"`).join(', ')}.`,
          locations: unbounded.map((d) => ({ file: meta.relPath, startLine: lineOf(lines, d.name), endLine: lineOf(lines, d.name), symbol: d.name })),
          evidence: unbounded.map((d) => ({ kind: 'fact' as const, tool: TOOL, description: `${d.section}.${d.name}`, snippet: `"${d.name}": "${d.spec}"` })),
          impact: 'Una nueva versión mayor con cambios incompatibles puede instalarse sin aviso.',
          effort: { minutes: 5 * unbounded.length, rationale: '5 min por dependencia para fijar un rango compatible (^ o ~).' },
        });
      }

      const nonRegistry = runtime.filter((d) => isNonRegistry(d.spec));
      if (nonRegistry.length > 0) {
        findings.push({
          id: findingId('dependencies/non-registry', meta.relPath, nonRegistry.map((d) => d.name).sort().join(',')),
          ruleId: 'dependencies/non-registry',
          category: 'dependencies',
          severity: 'low',
          confidence: 'high',
          title: `Dependencias fuera del registro npm (${nonRegistry.length})`,
          message: `Se instalan desde Git, URL o rutas locales: ${nonRegistry.map((d) => d.name).join(', ')}.`,
          locations: nonRegistry.map((d) => ({ file: meta.relPath, startLine: lineOf(lines, d.name), endLine: lineOf(lines, d.name), symbol: d.name })),
          evidence: nonRegistry.map((d) => ({ kind: 'fact' as const, tool: TOOL, description: `${d.section}.${d.name}`, snippet: `"${d.name}": "${d.spec}"` })),
          impact: 'No reciben avisos de seguridad del registro y pueden cambiar sin control de versiones semántico.',
          effort: { minutes: 20 * nonRegistry.length, rationale: '20 min por dependencia para migrar a una versión publicada o documentar la excepción.' },
        });
      }

      const prod = new Set(Object.keys(manifest.dependencies ?? {}));
      const dupes = Object.keys(manifest.devDependencies ?? {}).filter((n) => prod.has(n));
      if (dupes.length > 0) {
        findings.push({
          id: findingId('dependencies/duplicated', meta.relPath, dupes.sort().join(',')),
          ruleId: 'dependencies/duplicated',
          category: 'dependencies',
          severity: 'low',
          confidence: 'high',
          title: `Dependencias declaradas dos veces (${dupes.length})`,
          message: `Aparecen en dependencies y devDependencies: ${dupes.join(', ')}.`,
          locations: dupes.map((n) => ({ file: meta.relPath, startLine: lineOf(lines, n), endLine: lineOf(lines, n), symbol: n })),
          evidence: [{ kind: 'fact', tool: TOOL, description: 'Intersección de dependencies y devDependencies' }],
          impact: 'Ambigüedad sobre qué versión se usa en producción.',
          effort: { minutes: 5 * dupes.length, rationale: '5 min por dependencia.' },
        });
      }
    }
    return findings;
  },
};
