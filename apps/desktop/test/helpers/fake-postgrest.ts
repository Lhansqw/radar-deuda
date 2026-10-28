import { randomUUID } from 'node:crypto';

/**
 * La API de datos de Supabase (PostgREST) simulada para las tablas de
 * supabase/migrations, con sus reglas: cada usuario solo ve y cambia sus filas,
 * no puede guardar análisis en proyectos ajenos, solo puede cambiar las
 * columnas con permiso, borrar un proyecto borra sus análisis y se conservan
 * los 100 análisis más recientes por proyecto. Entiende las consultas que hace
 * SupabaseRepo (filtros eq, neq, is y not.is; order, offset y limit).
 */
type Row = Record<string, unknown>;
type Table = 'projects' | 'analyses';

const UPDATABLE: Record<Table, readonly string[]> = { projects: ['name', 'branch', 'deleted_at'], analyses: ['report_gz'] };
const KEEP = 100;

export class FakePostgrest {
  readonly tables: Record<Table, Row[]> = { projects: [], analyses: [] };

  constructor(private readonly userOf: (headers: Headers) => string | undefined) {}

  handle(url: URL, method: string, headers: Headers, body: unknown): Response {
    const table = url.pathname.replace('/rest/v1/', '') as Table;
    if (!(table in this.tables)) return pgError('PGRST205', `Could not find the table 'public.${table}'`, 404);
    const user = this.userOf(headers);
    if (!user) return pgError('42501', `permission denied for table ${table}`, 401);
    const representation = (headers.get('prefer') ?? '').includes('return=representation');
    switch (method) {
      case 'GET':
        return json(this.select(table, user, url));
      case 'POST':
        return this.insert(table, user, Array.isArray(body) ? (body as Row[]) : [body as Row], url, representation);
      case 'PATCH':
        return this.update(table, user, url, body as Row);
      case 'DELETE':
        this.remove(table, user, url);
        return new Response(null, { status: 204 });
      default:
        return pgError('PGRST000', `Método no simulado: ${method}`, 405);
    }
  }

  private mine(table: Table, user: string, url: URL): Row[] {
    return this.tables[table].filter((r) => r['user_id'] === user && matches(r, url.searchParams));
  }

  private select(table: Table, user: string, url: URL): Row[] {
    const rows = sortRows(this.mine(table, user, url), url.searchParams.get('order'));
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : rows.length;
    return rows.slice(offset, offset + limit).map((r) => pick(r, url.searchParams.get('select')));
  }

  private insert(table: Table, user: string, input: Row[], url: URL, representation: boolean): Response {
    const added: Row[] = [];
    for (const values of input) {
      if (values['user_id'] !== undefined && values['user_id'] !== user) return pgError('42501', 'new row violates row-level security policy', 403);
      const row: Row = { id: randomUUID(), created_at: new Date().toISOString(), ...(table === 'projects' ? { deleted_at: null } : {}), ...values, user_id: user };
      if (this.tables[table].some((r) => r['id'] === row['id'])) return pgError('23505', 'duplicate key value violates unique constraint', 409);
      if (table === 'projects' && this.tables.projects.some((r) => r['user_id'] === user && r['kind'] === row['kind'] && r['location'] === row['location'])) {
        return pgError('23505', 'duplicate key value violates unique constraint "projects_user_id_kind_location_key"', 409);
      }
      if (table === 'analyses' && !this.tables.projects.some((p) => p['id'] === row['project_id'] && p['user_id'] === user)) {
        return pgError('42501', 'new row violates row-level security policy for table "analyses"', 403);
      }
      this.tables[table].push(row);
      added.push(row);
      if (table === 'analyses') this.keepLatest(String(row['project_id']));
    }
    return representation ? json(added.map((r) => pick(r, url.searchParams.get('select'))), 201) : new Response(null, { status: 201 });
  }

  private update(table: Table, user: string, url: URL, values: Row): Response {
    const denied = Object.keys(values).find((k) => !UPDATABLE[table].includes(k));
    if (denied) return pgError('42501', `permission denied for table ${table}`, 403);
    for (const r of this.mine(table, user, url)) Object.assign(r, values);
    return new Response(null, { status: 204 });
  }

  private remove(table: Table, user: string, url: URL): void {
    const gone = new Set(this.mine(table, user, url));
    this.tables[table] = this.tables[table].filter((r) => !gone.has(r));
    if (table === 'projects') {
      const ids = new Set([...gone].map((r) => r['id']));
      this.tables.analyses = this.tables.analyses.filter((a) => !ids.has(a['project_id']));
    }
  }

  private keepLatest(projectId: string): void {
    const sorted = this.tables.analyses.filter((a) => a['project_id'] === projectId).sort((a, b) => String(b['finished_at']).localeCompare(String(a['finished_at'])));
    const drop = new Set(sorted.slice(KEEP));
    this.tables.analyses = this.tables.analyses.filter((a) => !drop.has(a));
  }
}

/** Filtros de PostgREST: columna=eq.valor, neq.valor, is.null y not.is.null. */
function matches(r: Row, params: URLSearchParams): boolean {
  for (const [key, value] of params) {
    if (['select', 'order', 'offset', 'limit', 'columns'].includes(key)) continue;
    const v = r[key];
    if (value.startsWith('eq.') && String(v) !== value.slice(3)) return false;
    if (value.startsWith('neq.') && String(v) === value.slice(4)) return false;
    if (value === 'is.null' && v !== null && v !== undefined) return false;
    if (value === 'not.is.null' && (v === null || v === undefined)) return false;
  }
  return true;
}

function sortRows(rows: Row[], order: string | null): Row[] {
  if (!order) return rows;
  const keys = order.split(',').map((o) => {
    const [col = '', dir = 'asc'] = o.split('.');
    return { col, desc: dir === 'desc' };
  });
  return [...rows].sort((a, b) => {
    for (const k of keys) {
      const c = String(a[k.col] ?? '').localeCompare(String(b[k.col] ?? ''));
      if (c !== 0) return k.desc ? -c : c;
    }
    return 0;
  });
}

function pick(r: Row, select: string | null): Row {
  if (!select || select === '*') return { ...r };
  return Object.fromEntries(select.split(',').map((c) => [c, r[c] ?? null]));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function pgError(code: string, message: string, status: number): Response {
  return json({ code, message, details: null, hint: null }, status);
}
