-- Pruebas de las políticas de seguridad por filas y de los permisos de
-- supabase/migrations, como los vería la aplicación: con el rol authenticated
-- y el usuario en request.jwt.claim.sub. Cada comprobación que falla detiene el
-- script con su mensaje (npm run test:db).

insert into auth.users (id) values
  ('11111111-1111-4111-8111-111111111111'), -- Ana
  ('22222222-2222-4222-8222-222222222222'); -- Luis

-- Inserta un análisis mínimo del proyecto indicado.
create function pg_temp.analysis(project uuid, finished timestamptz default now()) returns void
  language sql
as $$
  insert into public.analyses (id, project_id, started_at, finished_at, duration_ms, score, rating, debt_ratio,
    effort_minutes, findings, critical, high, medium, low, info, report_gz)
  values (gen_random_uuid(), project, finished, finished, 1000, 90, 'A', 0.01, 30, 3, 0, 1, 1, 1, 0, 'H4sI');
$$;

create function pg_temp.expect(ok boolean, message text) returns void
  language plpgsql
as $$
begin
  if not ok then
    raise exception 'FALLA: %', message;
  end if;
end;
$$;

grant execute on function pg_temp.analysis(uuid, timestamptz), pg_temp.expect(boolean, text) to authenticated;

-- ── Ana añade un proyecto y un análisis ────────────────────────────────────
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

insert into public.projects (name, kind, location) values ('tienda', 'github', 'ana/tienda');
select pg_temp.analysis((select id from public.projects where location = 'ana/tienda'));
select pg_temp.expect((select user_id from public.projects) = '11111111-1111-4111-8111-111111111111', 'el proyecto debería ser de Ana (user_id por defecto)');
select pg_temp.expect((select count(*) from public.analyses) = 1, 'Ana debería ver su análisis');

-- Cambiar el nombre y la rama sí; el tipo, la ubicación o el dueño, no.
update public.projects set name = 'tienda-web', branch = 'main';
do $$
begin
  update public.projects set location = 'ana/otra';
  raise exception 'FALLA: no debería poder cambiar la ubicación';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  update public.projects set user_id = '22222222-2222-4222-8222-222222222222';
  raise exception 'FALLA: no debería poder regalar el proyecto';
exception when insufficient_privilege then null;
end $$;
-- De un análisis solo se puede cambiar el informe.
update public.analyses set report_gz = 'H4sIAAAA';
do $$
begin
  update public.analyses set score = 100;
  raise exception 'FALLA: no debería poder cambiar la puntuación de un análisis';
exception when insufficient_privilege then null;
end $$;

-- El mismo proyecto dos veces, no.
do $$
begin
  insert into public.projects (name, kind, location) values ('otra vez', 'github', 'ana/tienda');
  raise exception 'FALLA: no debería poder repetir el proyecto';
exception when unique_violation then null;
end $$;

-- ── Luis no ve ni toca nada de Ana ─────────────────────────────────────────
set request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';

select pg_temp.expect((select count(*) from public.projects) = 0, 'Luis no debería ver los proyectos de Ana');
select pg_temp.expect((select count(*) from public.analyses) = 0, 'Luis no debería ver los análisis de Ana');
update public.projects set name = 'mío';
delete from public.analyses;
delete from public.projects;

do $$
declare
  ana_project uuid;
begin
  reset role;
  select id into ana_project from public.projects where location = 'ana/tienda';
  set role authenticated;
  perform pg_temp.analysis(ana_project);
  raise exception 'FALLA: Luis no debería poder guardar análisis en un proyecto de Ana';
exception when insufficient_privilege then null;
end $$;

do $$
begin
  insert into public.projects (user_id, name, kind, location) values ('11111111-1111-4111-8111-111111111111', 'trampa', 'github', 'ana/trampa');
  raise exception 'FALLA: Luis no debería poder crear proyectos a nombre de Ana';
exception when insufficient_privilege then null;
end $$;

-- Luis puede tener el mismo repositorio que Ana: es otra cuenta.
insert into public.projects (name, kind, location) values ('tienda', 'github', 'ana/tienda');

reset role;
select pg_temp.expect((select name from public.projects where user_id = '11111111-1111-4111-8111-111111111111') = 'tienda-web', 'Luis no debería poder cambiar el proyecto de Ana');
select pg_temp.expect((select count(*) from public.analyses) = 1, 'Luis no debería poder borrar los análisis de Ana');
select pg_temp.expect((select count(*) from public.projects) = 2, 'cada cuenta tiene su proyecto');

-- ── Sin sesión, nada ───────────────────────────────────────────────────────
set role anon;
reset request.jwt.claim.sub;
do $$
begin
  perform count(*) from public.projects;
  raise exception 'FALLA: el rol anónimo no debería poder leer proyectos';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  perform count(*) from public.analyses;
  raise exception 'FALLA: el rol anónimo no debería poder leer análisis';
exception when insufficient_privilege then null;
end $$;
reset role;

-- ── Historial acotado a 100 por proyecto ───────────────────────────────────
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
select pg_temp.analysis((select id from public.projects), now() - make_interval(days => n)) from generate_series(1, 105) as n;
select pg_temp.expect((select count(*) from public.analyses) = 100, 'deberían quedar los 100 análisis más recientes');
select pg_temp.expect((select min(finished_at) from public.analyses) > now() - interval '100 days', 'los que sobran deberían ser los más antiguos');

-- Quitar el proyecto se anota (deleted_at) y borrar el proyecto borra sus análisis.
update public.projects set deleted_at = now();
delete from public.projects;
select pg_temp.expect((select count(*) from public.analyses) = 0, 'borrar el proyecto debería borrar sus análisis');
reset role;

-- ── Cupo de la IA incluida (migración ia_incluida) ─────────────────────────
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
select pg_temp.expect(public.ai_requests_today() = 0, 'Ana aún no ha usado la IA hoy');
select pg_temp.expect(public.ai_count_request() = 1, 'la primera consulta de Ana cuenta 1');
select pg_temp.expect(public.ai_count_request() = 2, 'la segunda consulta de Ana cuenta 2');
select pg_temp.expect(public.ai_requests_today() = 2, 'Ana lleva 2 consultas hoy');
select pg_temp.expect((select count(*) from public.ai_usage) = 1, 'Ana ve su uso');
do $$
begin
  insert into public.ai_usage (user_id, day, requests) values ('11111111-1111-4111-8111-111111111111', current_date, 0);
  raise exception 'FALLA: nadie debería poder escribir el uso directamente';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  update public.ai_usage set requests = 0;
  raise exception 'FALLA: nadie debería poder borrar su propio contador';
exception when insufficient_privilege then null;
end $$;

set request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
select pg_temp.expect(public.ai_requests_today() = 0, 'el uso de Ana no cuenta para Luis');
select pg_temp.expect((select count(*) from public.ai_usage) = 0, 'Luis no ve el uso de Ana');
select pg_temp.expect(public.ai_count_request() = 1, 'Luis tiene su propio contador');

set role anon;
reset request.jwt.claim.sub;
do $$
begin
  perform public.ai_count_request();
  raise exception 'FALLA: sin sesión no se debería poder contar consultas';
exception when insufficient_privilege then null;
end $$;
reset role;

select 'Políticas de seguridad por filas: todas las comprobaciones superadas.' as resultado;
