import type ts from 'typescript';

/**
 * El compilador de TypeScript pesa ~9 MB: cargarlo cuesta unos 300 ms y
 * bastante memoria. Con la caché caliente no hace falta (no se analiza ningún
 * archivo), así que se carga solo antes del primer análisis que no sale de la
 * caché (`prepare` de cada analizador) o cuando la duplicación tiene que
 * verificar un par nuevo.
 */
let api: typeof ts | null = null;

export async function loadTypeScript(): Promise<typeof ts> {
  api ??= (await import('typescript')).default;
  return api;
}

/** El compilador ya cargado. Los analizadores lo garantizan con `prepare` antes de `analyze`. */
export function tsApi(): typeof ts {
  if (!api) throw new Error('El compilador de TypeScript no está cargado: llama antes a loadTypeScript().');
  return api;
}

/** Valores derivados del compilador que se calculan una sola vez, cuando ya está cargado. */
export function lazy<T>(compute: (api: typeof ts) => T): () => T {
  let value: { v: T } | null = null;
  return () => (value ??= { v: compute(tsApi()) }).v;
}

/** Si el compilador está cargado en este proceso (para pruebas y diagnóstico). */
export function isTypeScriptLoaded(): boolean {
  return api !== null;
}

/** Solo para pruebas: olvida el compilador cargado para comprobar cuándo se vuelve a cargar. */
export function forgetTypeScriptForTests(): void {
  api = null;
}
