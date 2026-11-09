/**
 * Texto de un error para mostrarlo (los valores lanzados que no son Error, tal
 * cual). Es la misma función que errorMessage de @radar/engine, aquí para la
 * interfaz, que no puede importar paquetes de Node.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
