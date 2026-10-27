import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';

/**
 * Datos de cada cuenta en este equipo (fase 13): proyectos, historial,
 * ajustes y claves de IA en usuarios/<id de Supabase>/radar.db, dentro de la
 * carpeta de datos de la aplicación. Dos personas que comparten el equipo no
 * ven los proyectos ni usan las claves de la otra.
 */
export const USERS_DIR = 'usuarios';
export const DB_FILE = 'radar.db';

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Carpeta de datos de un usuario. El identificador lo da Supabase: se comprueba que es un UUID. */
export function userDataDir(dataDir: string, userId: string): string {
  if (!USER_ID.test(userId)) throw new Error('Identificador de usuario no válido.');
  return path.join(dataDir, USERS_DIR, userId);
}

/**
 * Antes de las cuentas, los datos estaban en <carpeta de datos>/radar.db. La
 * primera cuenta que inicia sesión en el equipo se los queda (se mueven a su
 * carpeta, con los archivos de diario de SQLite); las siguientes empiezan
 * vacías. Devuelve true si los movió.
 */
export function adoptLegacyData(dataDir: string, userDir: string): boolean {
  const legacy = path.join(dataDir, DB_FILE);
  if (!existsSync(legacy)) return false;
  const others = existsSync(path.join(dataDir, USERS_DIR)) ? readdirSync(path.join(dataDir, USERS_DIR)).filter((d) => d !== path.basename(userDir)) : [];
  if (others.length > 0 || existsSync(path.join(userDir, DB_FILE))) return false;
  mkdirSync(userDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(legacy + suffix)) renameSync(legacy + suffix, path.join(userDir, DB_FILE + suffix));
  }
  return true;
}
