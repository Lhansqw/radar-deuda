import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import { findingId, type CoverageNote, type Finding, type ProjectAnalyzer } from '@radar/engine';
import { requestJson, type HttpOptions } from '../http.js';
import { lockfileLine, parseNpmLockfile, type InstalledPackage } from './lockfile.js';
import { findLockfiles } from './vulnerabilities.js';

const ID = 'outdated';
const VERSION = '1.0.0';
const TOOL = `npm-registry@${VERSION}`;

/** Nombres válidos de npm (minúsculas, opcionalmente con scope). Evita construir URLs con datos arbitrarios. */
const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

export interface PackageSummary {
  latest: string | null;
  /** Solo las versiones marcadas como en desuso, con su mensaje. */
  deprecated: Record<string, string>;
  fetchedAt: number;
}

interface AbbreviatedPackument {
  'dist-tags'?: { latest?: string };
  versions?: Record<string, { deprecated?: string }>;
}

export interface NpmRegistryOptions extends HttpOptions {
  baseUrl?: string;
  cacheDir?: string | null;
  /** Validez de la caché en disco (por defecto 24 h). */
  ttlMs?: number;
  concurrency?: number;
}

/** Cliente del registro de npm con metadatos abreviados (los que usa `npm install`). */
export class NpmRegistryClient {
  private readonly baseUrl: string;
  private readonly http: HttpOptions;
  private readonly cacheDir: string | null;
  private readonly ttlMs: number;
  readonly concurrency: number;
  requests = 0;

  constructor(options: NpmRegistryOptions = {}) {
    const { baseUrl = 'https://registry.npmjs.org', cacheDir = null, ttlMs = 24 * 3600 * 1000, concurrency = 8, ...http } = options;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.http = { maxBytes: 64 * 1024 * 1024, ...http };
    this.cacheDir = cacheDir;
    this.ttlMs = ttlMs;
    this.concurrency = concurrency;
  }

  async summary(name: string): Promise<PackageSummary> {
    if (!NPM_NAME.test(name)) throw new Error(`Nombre de paquete npm no válido: ${name}`);
    const file = this.cacheDir ? path.join(this.cacheDir, `${name.replace('/', '__')}.json`) : null;
    if (file) {
      try {
        const cached = JSON.parse(await readFile(file, 'utf8')) as PackageSummary;
        if (Date.now() - cached.fetchedAt < this.ttlMs) return cached;
      } catch {
        /* sin caché */
      }
    }
    this.requests++;
    const { data } = await requestJson<AbbreviatedPackument>(
      `${this.baseUrl}/${name.replace('/', '%2f')}`,
      { headers: { accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8', 'user-agent': 'radar-deuda' } },
      this.http,
    );
    const latest = data['dist-tags']?.latest;
    const deprecated: Record<string, string> = {};
    for (const [v, meta] of Object.entries(data.versions ?? {})) if (meta.deprecated) deprecated[v] = meta.deprecated.slice(0, 300);
    const summary: PackageSummary = { latest: latest && semver.valid(latest) ? latest : null, deprecated, fetchedAt: Date.now() };
    if (file && this.cacheDir) {
      await mkdir(this.cacheDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(summary), 'utf8');
      await rename(tmp, file);
    }
    return summary;
  }
}

/**
 * Versiones "mayores" (con cambios incompatibles) de diferencia. En 0.x cada
 * versión menor puede romper la compatibilidad, como establece semver.
 */
export function majorsBehind(installed: string, latest: string): number {
  if (!semver.gt(latest, installed)) return 0;
  const [mi, ml] = [semver.major(installed), semver.major(latest)];
  if (mi === 0 && ml === 0) return semver.minor(latest) - semver.minor(installed);
  return ml - mi;
}

export function outdatedFinding(pkg: InstalledPackage, latest: string, behind: number, lockRel: string, lockLines: readonly string[]): Finding {
  const line = lockfileLine(lockLines, pkg.paths[0] ?? `node_modules/${pkg.name}`, pkg.name);
  return {
    id: findingId('dependencies/outdated', lockRel, pkg.name),
    ruleId: 'dependencies/outdated',
    category: 'dependencies',
    severity: behind >= 3 ? 'medium' : 'low',
    confidence: 'high',
    title: `${pkg.name} está ${behind} ${behind === 1 ? 'versión mayor' : 'versiones mayores'} por detrás (${pkg.version} → ${latest})`,
    message: `La versión instalada de ${pkg.name} es ${pkg.version} y la más reciente publicada es ${latest}. Cada versión mayor puede incluir cambios incompatibles: revisa sus notas de versión antes de actualizar.`,
    locations: [{ file: lockRel, startLine: line, endLine: line, symbol: `${pkg.name}@${pkg.version}` }],
    evidence: [{ kind: 'fact', tool: TOOL, description: 'dist-tags.latest del registro de npm', metric: { name: 'majorsBehind', value: behind, threshold: 0, unit: 'versiones mayores' }, snippet: `https://www.npmjs.com/package/${pkg.name}` }],
    impact: 'Las versiones antiguas dejan de recibir correcciones de seguridad y cuanto más se retrasa la actualización, más costosa es.',
    effort: { minutes: Math.min(240, 30 * behind), rationale: '30 min por versión mayor de diferencia para revisar cambios incompatibles y probar (máx. 4 h).' },
  };
}

export function deprecatedFinding(pkg: InstalledPackage, reason: string, lockRel: string, lockLines: readonly string[]): Finding {
  const line = lockfileLine(lockLines, pkg.paths[0] ?? `node_modules/${pkg.name}`, pkg.name);
  return {
    id: findingId('dependencies/deprecated', lockRel, `${pkg.name}@${pkg.version}`),
    ruleId: 'dependencies/deprecated',
    category: 'dependencies',
    severity: pkg.dev ? 'low' : 'medium',
    confidence: 'high',
    title: `${pkg.name}@${pkg.version} está marcado como en desuso`,
    message: `Sus autores lo marcaron como en desuso: "${reason}".`,
    locations: [{ file: lockRel, startLine: line, endLine: line, symbol: `${pkg.name}@${pkg.version}` }],
    evidence: [{ kind: 'fact', tool: TOOL, description: 'Campo "deprecated" de la versión en el registro de npm', snippet: reason }],
    impact: 'Un paquete en desuso no recibirá correcciones; suele existir un sustituto recomendado.',
    effort: { minutes: 45, rationale: 'Buscar el sustituto recomendado, migrar y probar (estimación fija).' },
  };
}

/**
 * Dependencias directas desactualizadas o en desuso según el registro de
 * npm. Requiere red y envía únicamente nombres de paquetes.
 */
export function outdatedAnalyzer(registry: NpmRegistryClient): ProjectAnalyzer {
  let note: CoverageNote | null = null;
  return {
    id: ID,
    version: VERSION,
    description: 'Dependencias directas desactualizadas (versiones mayores) o en desuso según el registro de npm.',
    coverage: () => (note ? [note] : []),
    async analyzeProject(ctx) {
      const findings: Finding[] = [];
      const locks = await findLockfiles(ctx);
      let checked = 0;
      let failed = 0;
      for (const lockRel of locks.npm) {
        const text = await ctx.readText(lockRel);
        if (text === null) continue;
        const lines = text.split(/\r?\n/);
        const direct = parseNpmLockfile(text).packages.filter((p) => p.direct);
        let next = 0;
        const worker = async (): Promise<void> => {
          while (next < direct.length) {
            const pkg = direct[next++] as InstalledPackage;
            let info: PackageSummary;
            try {
              info = await registry.summary(pkg.name);
            } catch {
              failed++;
              continue;
            }
            checked++;
            const reason = info.deprecated[pkg.version];
            if (reason) findings.push(deprecatedFinding(pkg, reason, lockRel, lines));
            if (info.latest) {
              const behind = majorsBehind(pkg.version, info.latest);
              if (behind >= 1) findings.push(outdatedFinding(pkg, info.latest, behind, lockRel, lines));
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(registry.concurrency, direct.length) }, worker));
      }
      note =
        locks.npm.length === 0
          ? { area: 'Versiones de dependencias', status: 'not-analyzed', detail: 'No hay package-lock.json: sin versiones instaladas exactas que comparar con el registro.' }
          : {
              area: 'Versiones de dependencias',
              status: failed === 0 ? 'analyzed' : 'partial',
              detail: `${checked} dependencia(s) directa(s) comparadas con el registro de npm${failed > 0 ? `; ${failed} no se pudieron consultar` : ''}.`,
            };
      return findings;
    },
  };
}
