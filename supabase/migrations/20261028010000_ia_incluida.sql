-- Fase 14: cupo diario de la IA incluida (supabase/functions/ia).
--
-- La función cuenta cada consulta del usuario con ai_count_request() y, si
-- pasa del límite del día, no la reenvía a OpenRouter. Las dos funciones
-- trabajan siempre sobre el usuario de la sesión (auth.uid()): llamarlas
-- directamente solo puede gastar el propio cupo. Nadie puede escribir la
-- tabla de otra forma.

create table public.ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Día UTC (el cupo se renueva a las 00:00 UTC).
  day date not null,
  requests integer not null default 0 check (requests >= 0),
  primary key (user_id, day)
);

comment on table public.ai_usage is 'Consultas de IA incluida de cada cuenta por día (fase 14).';

alter table public.ai_usage enable row level security;

create policy "Cada usuario ve su uso de la IA" on public.ai_usage
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.ai_usage from anon, authenticated;
grant select on public.ai_usage to authenticated;

-- Cuenta una consulta del usuario de la sesión y devuelve cuántas lleva hoy.
create function public.ai_count_request() returns integer
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  today date := (now() at time zone 'utc')::date;
  n integer;
begin
  if uid is null then
    raise exception 'Hace falta una sesión' using errcode = '42501';
  end if;
  insert into public.ai_usage as u (user_id, day, requests) values (uid, today, 1)
  on conflict (user_id, day) do update set requests = u.requests + 1
  returning u.requests into n;
  -- Lo de hace más de un mes ya no sirve.
  delete from public.ai_usage where user_id = uid and day < today - 31;
  return n;
end;
$$;

-- Consultas del usuario de la sesión hoy.
create function public.ai_requests_today() returns integer
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select coalesce(
    (select requests from public.ai_usage where user_id = auth.uid() and day = (now() at time zone 'utc')::date),
    0
  );
$$;

-- Las funciones nuevas se pueden ejecutar por defecto: solo los usuarios con sesión.
revoke all on function public.ai_count_request(), public.ai_requests_today() from public, anon;
grant execute on function public.ai_count_request(), public.ai_requests_today() to authenticated;
