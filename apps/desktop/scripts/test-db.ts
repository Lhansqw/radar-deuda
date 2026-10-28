/**
 * Prueba el esquema de la nube (supabase/migrations) en un PostgreSQL normal:
 * crea una base de datos temporal, le pone lo mínimo de Supabase
 * (supabase/tests/supabase-stub.sql), aplica las migraciones en orden y ejecuta
 * supabase/tests/politicas.sql, que comprueba las políticas de seguridad por
 * filas y los permisos. Después borra la base de datos.
 *
 * Uso: RADAR_TEST_DATABASE_URL=postgresql://postgres@localhost:5432/postgres npm run test:db
 * (un servidor donde ese usuario pueda crear bases de datos; necesita psql).
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const supabase = path.join(root, 'supabase');
const base = process.env['RADAR_TEST_DATABASE_URL'];
if (!base) {
  console.error('Define RADAR_TEST_DATABASE_URL (p. ej. postgresql://postgres@localhost:5432/postgres): un servidor PostgreSQL donde se pueda crear una base de datos temporal.');
  process.exit(2);
}

function psql(url: string, args: string[]): { ok: boolean; output: string } {
  const r = spawnSync('psql', [url, '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8' });
  if (r.error) throw new Error(`No se pudo ejecutar psql: ${r.error.message}`);
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}`.trim() };
}

const name = `radar_prueba_${process.pid}_${Date.now()}`;
const target = new URL(base);
target.pathname = `/${name}`;

const created = psql(base, ['-c', `create database ${name}`]);
if (!created.ok) {
  console.error(`No se pudo crear la base de datos de prueba:\n${created.output}`);
  process.exit(1);
}
let ok: boolean;
try {
  const migrations = readdirSync(path.join(supabase, 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => path.join(supabase, 'migrations', f));
  const files = [path.join(supabase, 'tests', 'supabase-stub.sql'), ...migrations, path.join(supabase, 'tests', 'politicas.sql')];
  const r = psql(target.toString(), files.flatMap((f) => ['-f', f]));
  ok = r.ok;
  // Solo interesan los errores y el resultado final (no el eco de cada comprobación).
  const lines = r.output.split('\n').filter((l) => /ERROR|FALLA|superadas/.test(l));
  console.log(`Migraciones aplicadas: ${migrations.map((m) => path.basename(m)).join(', ')}`);
  console.log(lines.join('\n') || r.output);
} finally {
  psql(base, ['-c', `drop database if exists ${name}`]);
}
process.exit(ok ? 0 : 1);
