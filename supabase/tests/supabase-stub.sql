-- Lo mínimo de Supabase para aplicar y probar las migraciones en un PostgreSQL
-- normal (integración continua y desarrollo): los roles anon y authenticated,
-- el esquema auth con su tabla de usuarios y auth.uid(), que en Supabase lee el
-- usuario del token de la petición. Nunca se aplica en Supabase.

-- Los roles son de todo el servidor: pueden existir de una ejecución anterior.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;

create schema auth;
create table auth.users (id uuid primary key);

create function auth.uid() returns uuid
  language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant usage on schema public to anon, authenticated;
