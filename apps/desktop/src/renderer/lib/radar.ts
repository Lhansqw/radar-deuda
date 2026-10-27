import type { Category, Finding, Severity } from '@radar/engine';
import { CATEGORIES } from './labels.js';

/**
 * Geometría del radar del panel: cada categoría es un sector y cada
 * severidad un anillo, con lo crítico en el centro ("lo más cercano"). Cada
 * hallazgo es un punto en su celda (sector × anillo). La colocación es
 * determinista (depende del id del hallazgo), así el radar no "baila" entre
 * renderizados ni entre análisis.
 */

export const RADAR_RINGS: readonly Exclude<Severity, 'info'>[] = ['critical', 'high', 'medium', 'low'];

export interface RadarBlip {
  findingId: string;
  severity: Severity;
  category: Category;
  x: number;
  y: number;
}

export interface RadarSector {
  category: Category;
  /** Ángulos en radianes, en sentido horario desde las 12. */
  start: number;
  end: number;
  count: number;
  labelX: number;
  labelY: number;
  anchor: 'start' | 'middle' | 'end';
}

export interface RadarOverflow {
  category: Category;
  severity: Severity;
  x: number;
  y: number;
  extra: number;
}

export interface RadarLayout {
  size: number;
  center: number;
  radius: number;
  rings: Array<{ severity: Severity; inner: number; outer: number }>;
  sectors: RadarSector[];
  blips: RadarBlip[];
  overflow: RadarOverflow[];
  /** Los hallazgos informativos no se dibujan (no son deuda que priorizar). */
  info: number;
}

/** Hash FNV-1a: semilla estable a partir del id del hallazgo. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Generador pseudoaleatorio pequeño y determinista (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const polar = (c: number, r: number, angle: number): [number, number] => [c + r * Math.sin(angle), c - r * Math.cos(angle)];

export function layoutRadar(findings: readonly Finding[], size: number, maxPerCell = 10, labelMargin = 34): RadarLayout {
  const center = size / 2;
  const radius = center - labelMargin;
  const band = radius / RADAR_RINGS.length;
  const rings = RADAR_RINGS.map((severity, i) => ({ severity, inner: i * band, outer: (i + 1) * band }));
  const step = (2 * Math.PI) / CATEGORIES.length;
  const sectors = CATEGORIES.map((category, i) => sectorAt(category, i, step, center, radius));
  const { cells, info } = groupByCell(findings, sectors);

  const blips: RadarBlip[] = [];
  const overflow: RadarOverflow[] = [];
  for (const [key, list] of cells) {
    const [category, severity] = key.split('|') as [Category, Exclude<Severity, 'info'>];
    const sector = sectors.find((s) => s.category === category);
    const ring = rings.find((r) => r.severity === severity);
    if (!sector || !ring) continue;
    const cell = placeCell(list, { sector, ring, band, step, center, maxPerCell });
    blips.push(...cell.blips);
    if (cell.overflow) overflow.push(cell.overflow);
  }
  return { size, center, radius, rings, sectors, blips, overflow, info };
}

/** Un sector por categoría, con su etiqueta fuera del círculo alineada según el lado. */
function sectorAt(category: Category, i: number, step: number, center: number, radius: number): RadarSector {
  const start = i * step;
  const mid = start + step / 2;
  const [labelX, labelY] = polar(center, radius + 14, mid);
  const s = Math.sin(mid);
  return { category, start, end: start + step, count: 0, labelX, labelY, anchor: Math.abs(s) < 0.2 ? 'middle' : s > 0 ? 'start' : 'end' };
}

/** Hallazgos por celda «categoría|severidad» (cuenta los de cada sector); los informativos solo se cuentan. */
function groupByCell(findings: readonly Finding[], sectors: RadarSector[]): { cells: Map<string, Finding[]>; info: number } {
  const cells = new Map<string, Finding[]>();
  let info = 0;
  for (const f of findings) {
    if (f.severity === 'info') {
      info++;
      continue;
    }
    const key = `${f.category}|${f.severity}`;
    const list = cells.get(key) ?? [];
    list.push(f);
    cells.set(key, list);
    const sector = sectors.find((s) => s.category === f.category);
    if (sector) sector.count++;
  }
  return { cells, info };
}

interface Cell {
  sector: RadarSector;
  ring: RadarLayout['rings'][number];
  band: number;
  step: number;
  center: number;
  maxPerCell: number;
}

/** Coloca los hallazgos de una celda; si no caben todos, un indicador con cuántos faltan. */
function placeCell(list: readonly Finding[], cell: Cell): { blips: RadarBlip[]; overflow: RadarOverflow | null } {
  const { sector, ring, band, step, center, maxPerCell } = cell;
  const severity = ring.severity;
  // Primero los de más esfuerzo: si la celda se llena, los que quedan fuera son los menores.
  const sorted = [...list].sort((a, b) => b.effort.minutes - a.effort.minutes || a.id.localeCompare(b.id));
  const shown = sorted.slice(0, maxPerCell);
  const padA = step * 0.12;
  const area = {
    fromAngle: sector.start + padA,
    angleSpan: step - 2 * padA,
    innerR: ring.inner + band * (ring.inner === 0 ? 0.35 : 0.2),
    outerR: ring.outer - band * 0.2,
  };
  const placed: Array<[number, number]> = [];
  const blips = shown.map((f): RadarBlip => {
    const [x, y] = placeBlip(f.id, area, center, placed);
    placed.push([x, y]);
    return { findingId: f.id, severity, category: sector.category, x, y };
  });
  if (sorted.length === shown.length) return { blips, overflow: null };
  const [x, y] = polar(center, (ring.inner + ring.outer) / 2, sector.end - padA * 1.6);
  return { blips, overflow: { category: sector.category, severity, x, y, extra: sorted.length - shown.length } };
}

/**
 * Prueba varias posiciones (deterministas a partir del id) dentro de la celda
 * y se queda con la más alejada de los puntos ya colocados, para evitar solapes.
 */
function placeBlip(id: string, area: { fromAngle: number; angleSpan: number; innerR: number; outerR: number }, center: number, placed: ReadonlyArray<[number, number]>): [number, number] {
  const rand = rng(hash(id));
  let best: [number, number] = [center, center];
  let bestDist = -1;
  for (let k = 0; k < 16; k++) {
    const a = area.fromAngle + rand() * area.angleSpan;
    const r = area.innerR + rand() * Math.max(0, area.outerR - area.innerR);
    const p = polar(center, r, a);
    const d = placed.length === 0 ? Infinity : Math.min(...placed.map(([x, y]) => Math.hypot(x - p[0], y - p[1])));
    if (d > bestDist) {
      best = p;
      bestDist = d;
    }
    if (d > 18) break;
  }
  return best;
}
