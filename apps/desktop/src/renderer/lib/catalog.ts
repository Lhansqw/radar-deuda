import type { CatalogModel } from '../../shared/model.js';
import { fold } from './format.js';

/** Filtros de la lista de modelos de OpenRouter. */
export interface CatalogFilter {
  query: string;
  onlyFree: boolean;
  /** Ocultar los modelos cuyo razonamiento no se puede desactivar. */
  hideMandatory: boolean;
}

/** Cuántos modelos se muestran como mucho (el resto se alcanza buscando). */
export const CATALOG_PAGE = 60;
/** Modelos de respaldo como mucho. */
export const MAX_FALLBACKS = 3;

const alwaysReasons = (m: CatalogModel): boolean => m.reasoning === 'obligatorio' || m.reasoning === 'no ajustable';

/** Solo los que admiten salida estructurada (la aplicación la necesita) y cumplen los filtros. */
export function filterCatalog(catalog: readonly CatalogModel[], f: CatalogFilter): CatalogModel[] {
  const q = fold(f.query.trim());
  return catalog.filter(
    (m) => m.structuredOutputs && (!f.onlyFree || m.free) && !(f.hideMandatory && alwaysReasons(m)) && (q === '' || fold(`${m.id} ${m.name}`).includes(q)),
  );
}

const usd = (n: number): string => n.toLocaleString('es', { maximumFractionDigits: 2 });

/** «Gratis», «entrada / salida» en USD por millón de tokens o «—» si no se publica. */
export function modelPrice(m: CatalogModel): string {
  if (m.free) return 'Gratis';
  if (m.inputPerMTok === null || m.outputPerMTok === null) return '—';
  return `${usd(m.inputPerMTok)} / ${usd(m.outputPerMTok)}`;
}

/** «128k» o «—». */
export function modelContext(m: CatalogModel): string {
  return m.contextLength ? `${Math.round(m.contextLength / 1000)}k` : '—';
}

/** Por qué no se puede añadir como respaldo, o null si se puede. */
export function fallbackBlocked(id: string, model: string, fallback: readonly string[]): string | null {
  if (id === model) return 'Es el modelo elegido';
  if (fallback.includes(id)) return 'Ya es un respaldo';
  if (fallback.length >= MAX_FALLBACKS) return `Como mucho ${MAX_FALLBACKS} respaldos`;
  return null;
}
