import { useEffect, useMemo, useState } from 'react';
import type { CatalogModel } from '../../../shared/model.js';
import { Icon } from '../../components/Icon.js';
import { CATALOG_PAGE, fallbackBlocked, filterCatalog, modelContext, modelPrice, type CatalogFilter } from '../../lib/catalog.js';
import { errorText } from './SettingsSection.js';

interface ModelChoice {
  model: string;
  fallback: string[];
  onModel: (m: string) => void;
  onFallback: (f: string[]) => void;
}

/** Modelo de OpenRouter: se escribe o se elige del catálogo, con hasta tres respaldos. */
export function OpenRouterModels(choice: ModelChoice) {
  const [open, setOpen] = useState(false);
  // El catálogo y los filtros se conservan al cerrar y volver a abrir la lista.
  const catalog = useCatalog(open);
  const [filter, setFilter] = useState<CatalogFilter>({ query: '', onlyFree: false, hideMandatory: true });
  return (
    <div className="field field-wide">
      <label htmlFor="modelo-or">Modelo</label>
      <div className="model-line">
        <input
          id="modelo-or"
          className="input mono"
          value={choice.model}
          onChange={(e) => choice.onModel(e.target.value.trim())}
          placeholder="proveedor/modelo"
          spellCheck={false}
        />
        <button type="button" className="btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Cerrar la lista' : 'Elegir de la lista'}
        </button>
      </div>
      <FallbackChips fallback={choice.fallback} onFallback={choice.onFallback} />
      {open ? <Catalog {...catalog} filter={filter} onFilter={(patch) => setFilter((f) => ({ ...f, ...patch }))} choice={choice} /> : null}
    </div>
  );
}

function FallbackChips({ fallback, onFallback }: { fallback: string[]; onFallback: (f: string[]) => void }) {
  if (fallback.length === 0) return null;
  return (
    <div className="fallbacks">
      <span className="hint">Respaldo, por orden, si el modelo falla o está saturado:</span>
      {fallback.map((f) => (
        <button key={f} type="button" className="chip" aria-pressed="true" onClick={() => onFallback(fallback.filter((x) => x !== f))} title="Quitar de los respaldos">
          <span className="mono">{f}</span>
          <Icon name="close" size={12} />
        </button>
      ))}
    </div>
  );
}

/** El catálogo se pide la primera vez que se abre la lista. */
function useCatalog(open: boolean): { catalog: CatalogModel[] | null; error: string | null } {
  const [catalog, setCatalog] = useState<CatalogModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || catalog) return;
    let cancelled = false;
    window.radar.ai
      .models()
      .then((m) => !cancelled && setCatalog(m))
      .catch((err: unknown) => !cancelled && setError(errorText(err)));
    return () => {
      cancelled = true;
    };
  }, [open, catalog]);
  return { catalog, error };
}

function Catalog({
  catalog,
  error,
  filter,
  onFilter,
  choice,
}: {
  catalog: CatalogModel[] | null;
  error: string | null;
  filter: CatalogFilter;
  onFilter: (patch: Partial<CatalogFilter>) => void;
  choice: ModelChoice;
}) {
  const filtered = useMemo(() => filterCatalog(catalog ?? [], filter), [catalog, filter]);
  return (
    <div className="catalog">
      <CatalogFilters filter={filter} onChange={onFilter} />
      {error ? <p className="form-error">{error}</p> : null}
      {!catalog && !error ? <p className="muted">Cargando el catálogo de OpenRouter…</p> : null}
      {catalog ? (
        <>
          <p className="hint">
            {filtered.length} modelos compatibles. Precio en USD por millón de tokens de entrada y de salida. Los gratuitos tienen un límite de peticiones al día y suelen requerir permitir
            proveedores que guardan datos.
          </p>
          <CatalogTable models={filtered.slice(0, CATALOG_PAGE)} {...choice} />
          {filtered.length > CATALOG_PAGE ? <p className="hint">Y {filtered.length - CATALOG_PAGE} más: afina la búsqueda.</p> : null}
        </>
      ) : null}
    </div>
  );
}

function CatalogFilters({ filter, onChange }: { filter: CatalogFilter; onChange: (patch: Partial<CatalogFilter>) => void }) {
  return (
    <div className="catalog-filters">
      <label className="search">
        <Icon name="search" size={16} />
        <span className="visually-hidden">Buscar modelo</span>
        <input className="input" type="search" value={filter.query} onChange={(e) => onChange({ query: e.target.value })} placeholder="Buscar (qwen, llama, nemotron…)" />
      </label>
      <label className="check">
        <input type="checkbox" checked={filter.onlyFree} onChange={(e) => onChange({ onlyFree: e.target.checked })} />
        <span>Solo gratuitos</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={filter.hideMandatory} onChange={(e) => onChange({ hideMandatory: e.target.checked })} />
        <span>Ocultar los que siempre razonan</span>
      </label>
    </div>
  );
}

function CatalogTable({ models, model, fallback, onModel, onFallback }: ModelChoice & { models: CatalogModel[] }) {
  return (
    <div className="catalog-scroll">
      <table className="table catalog-table">
        <thead>
          <tr>
            <th scope="col" className="col-model">
              Modelo
            </th>
            <th scope="col" className="num">
              Precio
            </th>
            <th scope="col" className="num">
              Contexto
            </th>
            <th scope="col">Razonamiento</th>
            <th scope="col">
              <span className="visually-hidden">Acciones</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => {
            const blocked = fallbackBlocked(m.id, model, fallback);
            return (
              <tr key={m.id} aria-current={m.id === model || undefined}>
                <td className="mono" title={m.name}>
                  {m.id}
                </td>
                <td className="num">{modelPrice(m)}</td>
                <td className="num">{modelContext(m)}</td>
                <td>{m.reasoning}</td>
                <td className="actions">
                  <button type="button" className="btn btn-small" onClick={() => onModel(m.id)} disabled={m.id === model}>
                    Usar
                  </button>
                  <button type="button" className="btn btn-quiet btn-small" onClick={() => onFallback([...fallback, m.id])} disabled={blocked !== null} title={blocked ?? undefined}>
                    Respaldo
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
