-- Fase 13b: proyectos e historial de análisis de cada cuenta, en la nube.
--
-- Cada fila pertenece a un usuario (user_id) y las políticas de seguridad por
-- filas (RLS) solo le dejan leer y escribir las suyas. Solo el rol de los
-- usuarios con sesión (authenticated) tiene permisos; el anónimo, ninguno.
--
-- Lo que no sube nunca: el código (el informe va sin fragmentos), las claves de
-- IA, las explicaciones y propuestas de la IA ni las conversaciones. Ver
-- docs/CUENTAS.md.
--
-- Se aplica una vez en el editor SQL de Supabase (o con `supabase db push`).

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 300),
  kind text not null check (kind in ('local', 'github')),
  -- Carpeta absoluta del equipo donde se añadió (local) u owner/repo (GitHub).
  location text not null check (char_length(location) between 1 and 1000),
  branch text check (char_length(branch) <= 200),
  created_at timestamptz not null default now(),
  -- Quitado en un equipo: los demás lo quitan al sincronizar. Volver a añadirlo lo recupera.
  deleted_at timestamptz,
  unique (user_id, kind, location)
);

comment on table public.projects is 'Proyectos de cada cuenta de Radar de Deuda Técnica (fase 13b).';

create table public.analyses (
  -- Lo genera la aplicación: identifica el análisis en todos los equipos.
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  duration_ms integer not null check (duration_ms >= 0),
  score smallint not null check (score between 0 and 100),
  rating text not null check (rating in ('A', 'B', 'C', 'D', 'E')),
  debt_ratio double precision not null check (debt_ratio >= 0),
  effort_minutes integer not null check (effort_minutes >= 0),
  findings integer not null check (findings >= 0),
  critical integer not null check (critical >= 0),
  high integer not null check (high >= 0),
  medium integer not null check (medium >= 0),
  low integer not null check (low >= 0),
  info integer not null check (info >= 0),
  head text check (char_length(head) <= 64),
  branch text check (char_length(branch) <= 200),
  -- Informe completo sin fragmentos de código ni anotaciones de la IA: JSON
  -- comprimido con gzip y codificado en base64 (suele quedar en un 10 %).
  report_gz text not null check (char_length(report_gz) <= 16777216),
  created_at timestamptz not null default now()
);

comment on table public.analyses is 'Historial de análisis de cada proyecto (los 100 más recientes), sin código (fase 13b).';

create index analyses_by_project on public.analyses (project_id, finished_at desc);
create index analyses_by_user on public.analyses (user_id);

-- ── Seguridad por filas ────────────────────────────────────────────────────

alter table public.projects enable row level security;
alter table public.analyses enable row level security;

create policy "Cada usuario ve sus proyectos" on public.projects
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Cada usuario añade sus proyectos" on public.projects
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Cada usuario cambia sus proyectos" on public.projects
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Cada usuario borra sus proyectos" on public.projects
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy "Cada usuario ve sus análisis" on public.analyses
  for select to authenticated using ((select auth.uid()) = user_id);
-- Solo en un proyecto propio: nadie puede colgar análisis en el proyecto de otro.
create policy "Cada usuario guarda análisis de sus proyectos" on public.analyses
  for insert to authenticated with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.projects p where p.id = project_id and p.user_id = (select auth.uid()))
  );
create policy "Cada usuario actualiza sus análisis" on public.analyses
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Cada usuario borra sus análisis" on public.analyses
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Permisos explícitos (Supabase ya no los da solos a las tablas nuevas). De un
-- proyecto solo se pueden cambiar el nombre, la rama y si está quitado; de un
-- análisis, solo el informe (al volver a subirlo).
revoke all on public.projects, public.analyses from anon, authenticated;
grant select, insert, delete on public.projects to authenticated;
grant update (name, branch, deleted_at) on public.projects to authenticated;
grant select, insert, delete on public.analyses to authenticated;
grant update (report_gz) on public.analyses to authenticated;

-- ── Historial acotado ──────────────────────────────────────────────────────

-- Como en el equipo: se conservan los 100 análisis más recientes de cada
-- proyecto. Se ejecuta con los permisos de quien inserta (las políticas siguen
-- aplicándose).
create function public.keep_latest_analyses() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  delete from public.analyses
  where project_id = new.project_id
    and id in (
      select a.id from public.analyses a
      where a.project_id = new.project_id
      order by a.finished_at desc, a.created_at desc
      offset 100
    );
  return null;
end;
$$;

revoke all on function public.keep_latest_analyses() from public, anon, authenticated;

create trigger analyses_keep_latest
  after insert on public.analyses
  for each row execute function public.keep_latest_analyses();
