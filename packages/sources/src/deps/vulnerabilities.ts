import path from 'node:path';
import semver from 'semver';
import { findingId, SEVERITY_ORDER, SPANISH, translator, type Translate, type CoverageNote, type Evidence, type Finding, type Location, type ProjectAnalyzer, type ProjectContext, type Severity } from '@radar/engine';
import { lockfileLine, parseNpmLockfile, type InstalledPackage } from './lockfile.js';
import type { OsvClient, Vulnerability } from './osv.js';

const ID = 'vulnerabilities';
const VERSION = '1.0.0';
const TOOL = `osv@${VERSION}`;

const NPM_LOCKS = ['package-lock.json', 'npm-shrinkwrap.json'];
const OTHER_LOCKS = ['yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'];
const DOWNGRADE: Record<Severity, Severity> = { critical: 'high', high: 'medium', medium: 'low', low: 'low', info: 'info' };

export interface LockfileSet {
  npm: string[];
  unsupported: string[];
}

/** Lockfiles que cubren los package.json del proyecto (buscando también hacia arriba). */
export async function findLockfiles(ctx: ProjectContext): Promise<LockfileSet> {
  const npm = new Set<string>();
  const unsupported = new Set<string>();
  for (const f of ctx.files) {
    if (path.posix.basename(f.relPath) !== 'package.json') continue;
    let dir = path.posix.dirname(f.relPath);
    for (;;) {
      const at = (name: string): string => (dir === '.' ? name : `${dir}/${name}`);
      const foundNpm = await firstExisting(ctx, NPM_LOCKS.map(at));
      if (foundNpm) {
        npm.add(foundNpm);
        break;
      }
      const other = await firstExisting(ctx, OTHER_LOCKS.map(at));
      if (other) {
        unsupported.add(other);
        break;
      }
      if (dir === '.' || dir === '') break;
      dir = path.posix.dirname(dir);
    }
  }
  return { npm: [...npm].sort(), unsupported: [...unsupported].sort() };
}

async function firstExisting(ctx: ProjectContext, candidates: string[]): Promise<string | null> {
  for (const c of candidates) if (await ctx.exists(c)) return c;
  return null;
}

function maxSeverity(list: readonly Severity[]): Severity {
  return list.reduce<Severity>((acc, s) => (SEVERITY_ORDER[s] > SEVERITY_ORDER[acc] ? s : acc), 'info');
}

/** Versión mínima que corrige todas las vulnerabilidades con corrección conocida. */
export function recommendedVersion(vulns: readonly Vulnerability[]): string | null {
  const minima = vulns.map((v) => v.fixedIn[0]).filter((v): v is string => v !== undefined);
  return minima.length === 0 ? null : (minima.sort(semver.compare).at(-1) as string);
}

export function vulnerabilityFinding(
  pkg: InstalledPackage,
  vulns: readonly Vulnerability[],
  lockRel: string,
  lockLines: readonly string[],
  manifestLocation?: Location,
  tr: Translate = SPANISH,
): Finding {
  const base = maxSeverity(vulns.map((v) => v.severity));
  const severity = pkg.dev ? DOWNGRADE[base] : base;
  const fix = recommendedVersion(vulns);
  const unfixed = vulns.filter((v) => v.fixedIn.length === 0);
  const ids = vulns.map((v) => v.id).join(', ');
  const line = lockfileLine(lockLines, pkg.paths[0] ?? `node_modules/${pkg.name}`, pkg.name);
  const locations: Location[] = [{ file: lockRel, startLine: line, endLine: line, symbol: `${pkg.name}@${pkg.version}` }];
  if (manifestLocation) locations.push(manifestLocation);

  const parts = [
    tr(
      `${pkg.name}@${pkg.version} tiene ${vulns.length === 1 ? 'una vulnerabilidad conocida' : `${vulns.length} vulnerabilidades conocidas`} (${ids}).`,
      `${pkg.name}@${pkg.version} has ${vulns.length === 1 ? 'a known vulnerability' : `${vulns.length} known vulnerabilities`} (${ids}).`,
    ),
  ];
  if (fix) parts.push(tr(`Se corrige${unfixed.length > 0 ? ' en parte' : ''} actualizando a ${fix} o superior.`, `It is${unfixed.length > 0 ? ' partly' : ''} fixed by updating to ${fix} or later.`));
  if (unfixed.length > 0) {
    const list = unfixed.map((v) => v.id).join(', ');
    parts.push(tr(`${list} no tiene versión corregida publicada: valora reemplazar el paquete o mitigar su uso.`, `${list} has no published fixed version: consider replacing the package or mitigating its use.`));
  }
  if (!pkg.direct) parts.push(tr('Es una dependencia transitiva: actualiza el paquete que la requiere o usa "overrides" en package.json.', 'It is a transitive dependency: update the package that requires it or use "overrides" in package.json.'));
  if (pkg.dev) parts.push(tr('Solo se instala para desarrollo: severidad reducida un nivel.', 'It is only installed for development: severity lowered one level.'));

  const minutes = fix === null || unfixed.length > 0 ? 60 : pkg.direct ? 15 : 30;
  return {
    id: findingId('dependencies/vulnerable', lockRel, `${pkg.name}@${pkg.version}`),
    ruleId: 'dependencies/vulnerable',
    category: 'security',
    severity,
    confidence: 'high',
    title: tr(
      `${vulns.length === 1 ? 'Vulnerabilidad conocida' : `${vulns.length} vulnerabilidades conocidas`} en ${pkg.name}@${pkg.version}`,
      `${vulns.length === 1 ? 'Known vulnerability' : `${vulns.length} known vulnerabilities`} in ${pkg.name}@${pkg.version}`,
    ),
    message: parts.join(' '),
    locations,
    evidence: vulns.map(
      (v): Evidence => ({
        kind: 'fact',
        tool: TOOL,
        description:
          `${v.id}${v.aliases.length > 0 ? ` (${v.aliases.join(', ')})` : ''} — ${v.summary || tr('sin resumen', 'no summary')}. ` +
          tr(
            `Severidad: ${v.severitySource}.${v.fixedIn.length > 0 ? ` Corregida en ${v.fixedIn.join(', ')}.` : ' Sin versión corregida.'}`,
            `Severity: ${v.severitySource}.${v.fixedIn.length > 0 ? ` Fixed in ${v.fixedIn.join(', ')}.` : ' No fixed version.'}`,
          ),
        snippet: v.url,
      }),
    ),
    impact: pkg.dev
      ? tr(
          'Afecta a herramientas de desarrollo o construcción; el riesgo principal es para el equipo y la cadena de suministro, no para producción.',
          'It affects development or build tools; the main risk is to the team and the supply chain, not to production.',
        )
      : tr('El código vulnerable se distribuye con la aplicación y puede ser explotable según cómo se use el paquete.', 'The vulnerable code ships with the app and may be exploitable depending on how the package is used.'),
    effort: {
      minutes,
      rationale:
        minutes === 15
          ? tr('Dependencia directa con versión corregida: actualizar y ejecutar las pruebas (15 min).', 'Direct dependency with a fixed version: update and run the tests (15 min).')
          : minutes === 30
            ? tr('Dependencia transitiva con versión corregida: actualizar el paquete padre o añadir un override (30 min).', 'Transitive dependency with a fixed version: update the parent package or add an override (30 min).')
            : tr('Sin corrección publicada para alguna vulnerabilidad: evaluar alternativas o mitigaciones (60 min).', 'No published fix for some vulnerability: evaluate alternatives or mitigations (60 min).'),
    },
  };
}

/**
 * Vulnerabilidades conocidas de las dependencias npm según OSV. Requiere red
 * y envía únicamente nombres y versiones de paquetes.
 */
export function vulnerabilityAnalyzer(client: OsvClient): ProjectAnalyzer {
  let note: CoverageNote | null = null;
  return {
    id: ID,
    version: VERSION,
    description: 'Vulnerabilidades conocidas en dependencias npm (OSV / GitHub Advisory Database).',
    coverage: () => (note ? [note] : []),
    async analyzeProject(ctx) {
      const tr = translator(ctx.config.locale);
      const locks = await findLockfiles(ctx);
      const findings: Finding[] = [];
      let packages = 0;
      for (const lockRel of locks.npm) {
        const text = await ctx.readText(lockRel);
        if (text === null) continue;
        const inventory = parseNpmLockfile(text);
        packages += inventory.packages.length;
        const lines = text.split(/\r?\n/);
        const results = await client.vulnerabilities(inventory.packages.map((p) => ({ name: p.name, version: p.version })));
        const manifestRel = lockRel.replace(/[^/]+$/, 'package.json');
        const manifestLines = ((await ctx.readText(manifestRel)) ?? '').split(/\r?\n/);
        inventory.packages.forEach((pkg, i) => {
          const vulns = results[i] ?? [];
          if (vulns.length === 0) return;
          const idx = pkg.direct ? manifestLines.findIndex((l) => l.includes(`"${pkg.name}"`)) : -1;
          const manifestLocation = idx >= 0 ? { file: manifestRel, startLine: idx + 1, endLine: idx + 1, symbol: pkg.name } : undefined;
          findings.push(vulnerabilityFinding(pkg, vulns, lockRel, lines, manifestLocation, tr));
        });
      }
      const pieces = [tr(`${packages} paquete(s) de ${locks.npm.length} package-lock.json consultados en OSV.`, `${packages} package(s) from ${locks.npm.length} package-lock.json checked on OSV.`)];
      if (locks.unsupported.length > 0) pieces.push(tr(`Sin soporte todavía: ${locks.unsupported.join(', ')}.`, `Not supported yet: ${locks.unsupported.join(', ')}.`));
      note = {
        area: tr('Dependencias', 'Dependencies'),
        status: locks.npm.length > 0 && locks.unsupported.length === 0 ? 'analyzed' : 'partial',
        detail:
          locks.npm.length === 0 && locks.unsupported.length === 0
            ? tr('No hay lockfile: no se pueden comprobar vulnerabilidades de versiones exactas.', 'There is no lockfile: vulnerabilities of exact versions cannot be checked.')
            : pieces.join(' '),
      };
      return findings;
    },
  };
}
