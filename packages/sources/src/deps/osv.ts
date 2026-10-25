import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import type { Severity } from '@radar/engine';
import { requestJson, type HttpOptions } from '../http.js';
import { cvss3BaseScore, severityFromScore } from './cvss.js';

/**
 * Cliente de OSV (https://osv.dev), la base de datos abierta de
 * vulnerabilidades que agrega GitHub Advisory Database, npm y otras.
 * Solo se envían nombres de paquetes y versiones; nunca código.
 */

export interface PackageQuery {
  name: string;
  version: string;
}

interface OsvBatchResponse {
  results: Array<{ vulns?: Array<{ id: string; modified?: string }>; next_page_token?: string }>;
}

interface OsvEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
  limit?: string;
}

export interface OsvRecord {
  id: string;
  modified: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  severity?: Array<{ type: string; score: string }>;
  affected?: Array<{
    package?: { ecosystem?: string; name?: string };
    ranges?: Array<{ type: string; events: OsvEvent[] }>;
    versions?: string[];
    database_specific?: Record<string, unknown>;
  }>;
  database_specific?: { severity?: string; [k: string]: unknown };
  references?: Array<{ type?: string; url: string }>;
  withdrawn?: string;
}

export interface Vulnerability {
  id: string;
  /** CVE y otros identificadores equivalentes. */
  aliases: string[];
  summary: string;
  severity: Severity;
  /** Origen de la severidad, para que sea auditable. */
  severitySource: string;
  /** Versiones en las que se corrige para este paquete (ascendente). */
  fixedIn: string[];
  url: string;
}

const MAX_BATCH = 1000;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,100}$/;

const GHSA_SEVERITY: Record<string, Severity> = { CRITICAL: 'critical', HIGH: 'high', MODERATE: 'medium', MEDIUM: 'medium', LOW: 'low' };

/** Severidad de un registro OSV: la de la base de datos si existe; si no, CVSS v3 calculada. */
export function recordSeverity(rec: OsvRecord): { severity: Severity; source: string } {
  const label = rec.database_specific?.severity?.toUpperCase();
  if (label && GHSA_SEVERITY[label]) return { severity: GHSA_SEVERITY[label] as Severity, source: `database_specific.severity = ${label}` };
  for (const s of rec.severity ?? []) {
    if (s.type === 'CVSS_V3') {
      const score = cvss3BaseScore(s.score);
      if (score !== null) return { severity: severityFromScore(score), source: `CVSS v3 ${score.toFixed(1)} (${s.score})` };
    }
  }
  return { severity: 'medium', source: 'Sin puntuación en la base de datos: se asume media.' };
}

/** Versiones corregidas aplicables a la versión instalada de un paquete npm. */
export function fixedVersions(rec: OsvRecord, name: string, installed: string): string[] {
  const out = new Set<string>();
  for (const aff of rec.affected ?? []) {
    if (aff.package?.ecosystem !== 'npm' || aff.package.name !== name) continue;
    for (const range of aff.ranges ?? []) {
      if (range.type !== 'SEMVER' && range.type !== 'ECOSYSTEM') continue;
      for (const ev of range.events) {
        if (ev.fixed && semver.valid(ev.fixed) && semver.gt(ev.fixed, installed)) out.add(ev.fixed);
      }
    }
  }
  return [...out].sort(semver.compare);
}

export interface OsvClientOptions extends HttpOptions {
  baseUrl?: string;
  /** Carpeta de caché de registros (por id y fecha de modificación). */
  cacheDir?: string | null;
  /** Peticiones de detalle simultáneas. */
  concurrency?: number;
}

export class OsvClient {
  private readonly baseUrl: string;
  private readonly http: HttpOptions;
  private readonly cacheDir: string | null;
  private readonly concurrency: number;
  private readonly memory = new Map<string, OsvRecord>();
  /** Peticiones de red realizadas (para métricas y pruebas). */
  requests = 0;

  constructor(options: OsvClientOptions = {}) {
    const { baseUrl = 'https://api.osv.dev', cacheDir = null, concurrency = 8, ...http } = options;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.http = http;
    this.cacheDir = cacheDir;
    this.concurrency = concurrency;
  }

  /** Ids (y fecha de modificación) de las vulnerabilidades de cada paquete, en el mismo orden. */
  async queryBatch(queries: readonly PackageQuery[]): Promise<Array<Array<{ id: string; modified?: string }>>> {
    const results: Array<Array<{ id: string; modified?: string }>> = queries.map(() => []);
    for (let start = 0; start < queries.length; start += MAX_BATCH) {
      let pending = queries.slice(start, start + MAX_BATCH).map((q, i) => ({ index: start + i, q, pageToken: undefined as string | undefined }));
      // Paginación: si una consulta trae next_page_token, se repite solo esa consulta.
      for (let round = 0; pending.length > 0 && round < 20; round++) {
        const body = {
          queries: pending.map(({ q, pageToken }) => ({ package: { name: q.name, ecosystem: 'npm' }, version: q.version, ...(pageToken ? { page_token: pageToken } : {}) })),
        };
        this.requests++;
        const { data } = await requestJson<OsvBatchResponse>(
          `${this.baseUrl}/v1/querybatch`,
          { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'radar-deuda' }, body: JSON.stringify(body) },
          this.http,
        );
        if (!Array.isArray(data.results) || data.results.length !== pending.length) throw new Error('Respuesta de OSV con un número de resultados inesperado.');
        const next: typeof pending = [];
        data.results.forEach((r, i) => {
          const item = pending[i] as (typeof pending)[number];
          for (const v of r.vulns ?? []) if (SAFE_ID.test(v.id)) (results[item.index] as Array<{ id: string; modified?: string }>).push(v.modified ? { id: v.id, modified: v.modified } : { id: v.id });
          if (r.next_page_token) next.push({ ...item, pageToken: r.next_page_token });
        });
        pending = next;
      }
    }
    return results;
  }

  /** Registro completo; usa la caché si la fecha de modificación coincide. */
  async getRecord(id: string, modified?: string): Promise<OsvRecord> {
    if (!SAFE_ID.test(id)) throw new Error(`Identificador de vulnerabilidad no válido: ${id}`);
    const mem = this.memory.get(id);
    if (mem && (!modified || mem.modified === modified)) return mem;
    const file = this.cacheDir ? path.join(this.cacheDir, `${id.replace(/:/g, '_')}.json`) : null;
    if (file) {
      try {
        const cached = JSON.parse(await readFile(file, 'utf8')) as OsvRecord;
        if (cached.id === id && (!modified || cached.modified === modified)) {
          this.memory.set(id, cached);
          return cached;
        }
      } catch {
        /* sin caché */
      }
    }
    this.requests++;
    const { data } = await requestJson<OsvRecord>(`${this.baseUrl}/v1/vulns/${encodeURIComponent(id)}`, { headers: { 'user-agent': 'radar-deuda' } }, this.http);
    if (data.id !== id) throw new Error(`OSV devolvió un registro distinto del solicitado (${id}).`);
    this.memory.set(id, data);
    if (file && this.cacheDir) {
      await mkdir(this.cacheDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(data), 'utf8');
      await rename(tmp, file);
    }
    return data;
  }

  /** Vulnerabilidades de cada paquete con severidad y versiones corregidas. */
  async vulnerabilities(queries: readonly PackageQuery[]): Promise<Vulnerability[][]> {
    const ids = await this.queryBatch(queries);
    const unique = new Map<string, string | undefined>();
    for (const list of ids) for (const v of list) unique.set(v.id, v.modified);
    const records = new Map<string, OsvRecord>();
    const entries = [...unique];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < entries.length) {
        const [id, modified] = entries[next++] as [string, string | undefined];
        records.set(id, await this.getRecord(id, modified));
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, entries.length) }, worker));

    return queries.map((q, i) =>
      (ids[i] ?? [])
        .map((v) => records.get(v.id))
        .filter((r): r is OsvRecord => r !== undefined && !r.withdrawn)
        .map((r) => {
          const { severity, source } = recordSeverity(r);
          return {
            id: r.id,
            aliases: (r.aliases ?? []).filter((a) => SAFE_ID.test(a)),
            summary: (r.summary ?? r.details ?? '').split('\n')[0]?.slice(0, 200) ?? '',
            severity,
            severitySource: source,
            fixedIn: fixedVersions(r, q.name, q.version),
            url: `https://osv.dev/vulnerability/${r.id}`,
          };
        }),
    );
  }
}
