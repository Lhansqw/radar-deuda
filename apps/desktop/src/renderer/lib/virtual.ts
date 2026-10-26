/** Ventana de filas visibles de una lista larga (solo se pintan esas y unas pocas de margen). */
export interface VisibleRange {
  start: number;
  end: number;
  offsetTop: number;
  totalHeight: number;
}

export function visibleRange(scrollTop: number, viewport: number, rowHeight: number, count: number, overscan = 6): VisibleRange {
  const totalHeight = count * rowHeight;
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, Math.ceil((Math.max(0, scrollTop) + viewport) / rowHeight) + overscan);
  return { start, end: Math.max(start, end), offsetTop: start * rowHeight, totalHeight };
}
