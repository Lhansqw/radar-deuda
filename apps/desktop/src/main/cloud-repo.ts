import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProjectKind } from '../shared/model.js';
import type { CloudAnalysisRow, CloudProjectRow, Database } from './cloud-schema.js';

/**
 * Las tablas de la nube (supabase/migrations) vistas desde la sincronización.
 * Cada petición lleva el token del usuario: las políticas de seguridad por
 * filas hacen que solo vea y cambie lo suyo.
 */

export interface CloudProject {
  id: string;
  name: string;
  kind: ProjectKind;
  location: string;
  branch: string | null;
  createdAt: string;
  /** Quitado en algún equipo. */
  deletedAt: string | null;
}

/** Lo justo para saber qué análisis faltan en un equipo. */
export interface CloudAnalysisRef {
  id: string;
  projectId: string;
  finishedAt: string;
}

export interface CloudAnalysis {
  id: string;
  projectId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Informe sin código, comprimido (cloud-report.ts). */
  reportGz: string;
}

export type NewCloudAnalysis = Omit<CloudAnalysisRow, 'user_id' | 'created_at'>;

/** Error de la nube; `offline` si es de la red (se reintentará más tarde). */
export class CloudError extends Error {
  constructor(
    message: string,
    readonly offline: boolean,
  ) {
    super(message);
    this.name = 'CloudError';
  }
}

/** Filas por petición: PostgREST en Supabase no devuelve más de 1000. */
const PAGE = 1000;
/** Código de PostgreSQL de clave repetida (el análisis ya estaba subido). */
const UNIQUE_VIOLATION = '23505';

interface Failure {
  message: string;
  code?: string;
}

/** Respuesta de PostgREST → datos o CloudError con un mensaje para el usuario. */
function unwrap<T>(r: { data: T | null; error: Failure | null; status: number }, action: string): T {
  if (r.error) throw cloudError(r.error, r.status, action);
  return r.data as T;
}

function cloudError(e: Failure, status: number, action: string): CloudError {
  // Sin respuesta (status 0) o un fallo pasajero del servidor: se reintentará.
  if (status === 0 || status === 503 || status === 504 || status === 520) return new CloudError(`No se pudo conectar con Supabase para ${action}.`, true);
  if (e.code === '42P01' || e.code === 'PGRST205') return new CloudError(`Faltan las tablas de la nube en Supabase: aplica supabase/migrations (ver docs/CUENTAS.md). No se pudo ${action}.`, false);
  if (e.code === '42501' || status === 401 || status === 403) return new CloudError(`Supabase no dio permiso para ${action} (${e.code ?? status}). Revisa que la migración esté aplicada y la sesión iniciada.`, false);
  return new CloudError(`Supabase no pudo ${action} (${e.code ?? `HTTP ${status}`}).`, false);
}

const PROJECT_COLUMNS = 'id,name,kind,location,branch,created_at,deleted_at';

function toProject(r: Pick<CloudProjectRow, 'id' | 'name' | 'kind' | 'location' | 'branch' | 'created_at' | 'deleted_at'>): CloudProject {
  return { id: r.id, name: r.name, kind: r.kind, location: r.location, branch: r.branch, createdAt: r.created_at, deletedAt: r.deleted_at };
}

export class SupabaseRepo {
  constructor(private readonly db: SupabaseClient<Database>) {}

  /** Todos los proyectos del usuario, también los quitados. */
  async projects(): Promise<CloudProject[]> {
    const rows = await this.all((from, to) => this.db.from('projects').select(PROJECT_COLUMNS).order('created_at').order('id').range(from, to), 'leer los proyectos');
    return rows.map(toProject);
  }

  async findProject(kind: ProjectKind, location: string): Promise<CloudProject | null> {
    const rows = unwrap(await this.db.from('projects').select(PROJECT_COLUMNS).eq('kind', kind).eq('location', location).limit(1), 'buscar un proyecto');
    return rows[0] ? toProject(rows[0]) : null;
  }

  /** Crea el proyecto y devuelve su identificador en la nube. */
  async addProject(p: { name: string; kind: ProjectKind; location: string; branch: string | null; createdAt: string }): Promise<string> {
    const rows = unwrap(await this.db.from('projects').insert({ name: p.name, kind: p.kind, location: p.location, branch: p.branch, created_at: p.createdAt }).select('id'), 'subir un proyecto');
    const id = rows[0]?.id;
    if (!id) throw new CloudError('Supabase no devolvió el proyecto subido.', false);
    return id;
  }

  /** El proyecto vuelve a estar en uso (si se había quitado), con su nombre y rama de este equipo. */
  async restoreProject(id: string, p: { name: string; branch: string | null }): Promise<void> {
    unwrap(await this.db.from('projects').update({ name: p.name, branch: p.branch, deleted_at: null }).eq('id', id), 'actualizar un proyecto');
  }

  /** Marca el proyecto como quitado (los demás equipos lo quitarán) y borra sus análisis. */
  async removeProject(id: string): Promise<void> {
    unwrap(await this.db.from('analyses').delete().eq('project_id', id), 'borrar los análisis de un proyecto');
    unwrap(await this.db.from('projects').update({ deleted_at: new Date().toISOString() }).eq('id', id), 'quitar un proyecto');
  }

  async analysisRefs(): Promise<CloudAnalysisRef[]> {
    const rows = await this.all(
      (from, to) => this.db.from('analyses').select('id,project_id,finished_at').order('finished_at', { ascending: false }).order('id').range(from, to),
      'leer el historial',
    );
    return rows.map((r) => ({ id: r.id, projectId: r.project_id, finishedAt: r.finished_at }));
  }

  async analysis(id: string): Promise<CloudAnalysis | null> {
    const rows = unwrap(await this.db.from('analyses').select('id,project_id,started_at,finished_at,duration_ms,report_gz').eq('id', id).limit(1), 'descargar un análisis');
    const r = rows[0];
    return r ? { id: r.id, projectId: r.project_id, startedAt: r.started_at, finishedAt: r.finished_at, durationMs: r.duration_ms, reportGz: r.report_gz } : null;
  }

  /** Sube un análisis. Si ya estaba (otro intento que no llegó a confirmarse), no es un error. */
  async addAnalysis(a: NewCloudAnalysis): Promise<void> {
    const r = await this.db.from('analyses').insert(a);
    if (r.error && r.error.code !== UNIQUE_VIOLATION) unwrap(r, 'subir un análisis');
  }

  /** Borra todo lo del usuario en la nube (los análisis se borran con sus proyectos). */
  async deleteEverything(): Promise<void> {
    // Supabase no admite borrar sin condición: «id no nulo» las cumple todas.
    unwrap(await this.db.from('projects').delete().not('id', 'is', null), 'borrar la copia en la nube');
  }

  /** Lee todas las páginas de una consulta. */
  private async all<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: Failure | null; status: number }>, action: string): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; ; from += PAGE) {
      const rows = unwrap(await page(from, from + PAGE - 1), action);
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
  }
}

/** Lo que la sincronización usa de la nube (SupabaseRepo; en las pruebas puede ser otro). */
export type CloudRepo = Pick<SupabaseRepo, keyof SupabaseRepo>;
