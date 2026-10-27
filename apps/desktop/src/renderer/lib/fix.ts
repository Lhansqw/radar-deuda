import type { DiffHunk, Finding } from '@radar/engine';

/** Consejo fijo para los secretos (no se envía su código a la IA). Mismo texto que @radar/ai. */
export const SECRET_FIX_ADVICE =
  'Para un posible secreto no se envía código a la IA. La corrección es siempre la misma: retirarlo del código, revocarlo (rotarlo) y leerlo de una variable de entorno o de un gestor de secretos.';

/**
 * Si se puede pedir una propuesta de corrección para el hallazgo. Mismas
 * reglas que fixUnavailableReason de @radar/ai: nunca para secretos ni para
 * hallazgos del proyecto en conjunto (no hay líneas que cambiar).
 */
export function fixAvailability(f: Finding): 'available' | 'secret' | 'no-code' {
  if (f.category === 'security') return 'secret';
  return f.locations.some((l) => l.file !== '.' && l.startLine > 0) ? 'available' : 'no-code';
}

/** Líneas añadidas y eliminadas de una diferencia (para el resumen). */
export function diffStats(hunks: readonly DiffHunk[]): { added: number; removed: number; files: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    added += h.lines.filter((l) => l.kind === 'added').length;
    removed += h.lines.filter((l) => l.kind === 'removed').length;
  }
  return { added, removed, files: new Set(hunks.map((h) => h.file)).size };
}
