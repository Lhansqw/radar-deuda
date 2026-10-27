/**
 * Vigilancia de memoria del proceso de análisis. El proceso arranca con un
 * límite de montículo (--max-old-space-size); si V8 lo alcanza, el proceso
 * muere sin explicación. Antes de eso, al superar el 90 % del límite, el
 * análisis se detiene con un mensaje que dice qué hacer.
 */
export interface HeapStats {
  used_heap_size: number;
  heap_size_limit: number;
}

export const MEMORY_THRESHOLD = 0.9;

/** Mensaje si el uso de memoria supera el umbral, o null si no. */
export function memoryPressure(s: HeapStats, threshold = MEMORY_THRESHOLD): string | null {
  if (s.heap_size_limit <= 0 || s.used_heap_size < s.heap_size_limit * threshold) return null;
  const mb = (n: number): number => Math.round(n / (1024 * 1024));
  return `El análisis se detuvo antes de agotar la memoria: usaba ${mb(s.used_heap_size)} MB de un límite de ${mb(s.heap_size_limit)} MB. Sube el límite en Configuración → Análisis o excluye carpetas generadas (build, vendor) con un archivo .radarignore.`;
}
