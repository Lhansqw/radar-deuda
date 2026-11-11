/** Rectángulo de un elemento del mapa, en las mismas unidades que el área de entrada. */
export interface TreemapCell<T> {
  item: T;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Mapa de rectángulos «squarified» (Bruls, Huizing y van Wijk): reparte el
 * área w×h entre los elementos en proporción a su valor, buscando celdas lo
 * más cuadradas posible para que se puedan comparar y leer. Los elementos con
 * valor 0 o negativo se omiten.
 */
export function squarify<T>(items: readonly T[], value: (item: T) => number, w: number, h: number): TreemapCell<T>[] {
  const entries = items.map((item) => ({ item, v: value(item) })).filter((e) => e.v > 0 && Number.isFinite(e.v));
  const total = entries.reduce((n, e) => n + e.v, 0);
  if (total <= 0 || w <= 0 || h <= 0) return [];
  entries.sort((a, b) => b.v - a.v);
  const scale = (w * h) / total;
  const areas = entries.map((e) => ({ item: e.item, a: e.v * scale }));

  const out: TreemapCell<T>[] = [];
  let x = 0;
  let y = 0;
  let rw = w;
  let rh = h;
  let row: typeof areas = [];

  const worst = (r: typeof areas, side: number): number => {
    if (r.length === 0) return Infinity;
    let sum = 0;
    let max = 0;
    let min = Infinity;
    for (const e of r) {
      sum += e.a;
      max = Math.max(max, e.a);
      min = Math.min(min, e.a);
    }
    const s2 = side * side;
    return Math.max((s2 * max) / (sum * sum), (sum * sum) / (s2 * min));
  };

  const place = (r: typeof areas): void => {
    const sum = r.reduce((n, e) => n + e.a, 0);
    if (rw >= rh) {
      // Columna a la izquierda del espacio que queda.
      const colW = sum / rh;
      let cy = y;
      for (const e of r) {
        const ch = e.a / colW;
        out.push({ item: e.item, x, y: cy, w: colW, h: ch });
        cy += ch;
      }
      x += colW;
      rw -= colW;
    } else {
      // Fila arriba del espacio que queda.
      const rowH = sum / rw;
      let cx = x;
      for (const e of r) {
        const cw = e.a / rowH;
        out.push({ item: e.item, x: cx, y, w: cw, h: rowH });
        cx += cw;
      }
      y += rowH;
      rh -= rowH;
    }
  };

  for (const e of areas) {
    const side = Math.min(rw, rh);
    if (row.length === 0 || worst([...row, e], side) <= worst(row, side)) {
      row.push(e);
    } else {
      place(row);
      row = [e];
    }
  }
  if (row.length > 0) place(row);
  return out;
}
