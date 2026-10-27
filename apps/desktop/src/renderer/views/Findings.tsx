import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { AnalysisReport, Category, Finding, Severity } from '@radar/engine';
import { Icon } from '../components/Icon.js';
import { SeverityGlyph } from '../components/SeverityMark.js';
import { countBySeverity, filterFindings, sortFindings, type FindingFilter, type FindingSort } from '../lib/findings.js';
import { formatEffort, formatNumber } from '../lib/format.js';
import { CATEGORIES, CATEGORY_LABEL, SEVERITIES, SEVERITY_LABEL } from '../lib/labels.js';
import { visibleRange } from '../lib/virtual.js';
import { FindingDetail } from './FindingDetail.js';

const ROW = 58;

interface Props {
  report: AnalysisReport;
  analysisId: number;
  filter: FindingFilter;
  onFilter: (f: FindingFilter) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Explicar con IA un hallazgo de este análisis. */
  onExplain: (analysisId: number, findingId: string) => Promise<void>;
  /** Hallazgos nuevos respecto al análisis anterior (sin análisis anterior, undefined). */
  newIds?: ReadonlySet<string> | undefined;
  onOpenSettings: () => void;
}

export function Findings({ report, analysisId, filter, onFilter, selectedId, onSelect, onExplain, onOpenSettings, newIds }: Props) {
  const [sort, setSort] = useState<FindingSort>('severity');
  const counts = useMemo(() => countBySeverity(report.findings), [report.findings]);
  const list = useMemo(() => sortFindings(filterFindings(report.findings, filter, newIds), sort), [report.findings, filter, sort, newIds]);
  const selected = list.find((f) => f.id === selectedId) ?? report.findings.find((f) => f.id === selectedId) ?? list[0] ?? null;

  const toggleSeverity = (s: Severity): void => {
    const next = new Set(filter.severities);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    onFilter({ ...filter, severities: next });
  };

  return (
    <div className="findings">
      <div className="filters" role="toolbar" aria-label="Filtros de hallazgos">
        <div className="sev-toggles" role="group" aria-label="Severidad">
          {SEVERITIES.map((s) => (
            <button key={s} type="button" className="chip" aria-pressed={filter.severities.has(s)} onClick={() => toggleSeverity(s)} disabled={counts[s] === 0}>
              <SeverityGlyph severity={s} />
              {SEVERITY_LABEL[s]}
              <span className="chip-count">{counts[s]}</span>
            </button>
          ))}
        </div>
        <select className="select" aria-label="Categoría" value={[...filter.categories][0] ?? ''} onChange={(e) => onFilter({ ...filter, categories: e.target.value ? new Set([e.target.value as Category]) : new Set() })}>
          <option value="">Todas las categorías</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>
        <label className="search">
          <Icon name="search" size={16} />
          <span className="visually-hidden">Buscar</span>
          <input className="input" type="search" placeholder="Buscar por título, archivo o función" value={filter.text} onChange={(e) => onFilter({ ...filter, text: e.target.value })} />
        </label>
        <select className="select" aria-label="Orden" value={sort} onChange={(e) => setSort(e.target.value as FindingSort)}>
          <option value="severity">Por severidad</option>
          <option value="effort">Por esfuerzo</option>
          <option value="file">Por archivo</option>
        </select>
        {newIds ? (
          <button type="button" className="chip" aria-pressed={filter.onlyNew} onClick={() => onFilter({ ...filter, onlyNew: !filter.onlyNew })} disabled={newIds.size === 0 && !filter.onlyNew} title="Deuda que no estaba en el análisis anterior">
            Solo nuevos
            <span className="chip-count">{newIds.size}</span>
          </button>
        ) : null}
        {filter.path !== null ? (
          <button type="button" className="chip" aria-pressed="true" onClick={() => onFilter({ ...filter, path: null })} title="Quitar el filtro de carpeta">
            <Icon name="folder" size={14} />
            <span className="mono">{filter.path}</span>
            <Icon name="close" size={12} />
          </button>
        ) : null}
      </div>

      <div className="findings-split">
        <FindingList findings={list} total={report.findings.length} selectedId={selected?.id ?? null} onSelect={onSelect} newIds={newIds} />
        <section className="detail-pane" aria-label="Detalle del hallazgo">
          {selected ? <FindingDetail key={selected.id} finding={selected} report={report} analysisId={analysisId} onExplain={(id) => onExplain(analysisId, id)} onOpenSettings={onOpenSettings} /> : <p className="pane-empty">Ningún hallazgo coincide con los filtros.</p>}
        </section>
      </div>
    </div>
  );
}

function FindingList({
  findings,
  total,
  selectedId,
  onSelect,
  newIds,
}: {
  findings: Finding[];
  total: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  newIds: ReadonlySet<string> | undefined;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(600);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Mantiene visible la fila seleccionada al moverse con el teclado.
  const index = findings.findIndex((f) => f.id === selectedId);
  useEffect(() => {
    const el = box.current;
    if (!el || index < 0) return;
    const top = index * ROW;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight;
  }, [index]);

  const range = visibleRange(scroll, height, ROW, findings.length);
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const next = findings[Math.min(findings.length - 1, Math.max(0, index + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) onSelect(next.id);
  };

  return (
    <div className="finding-list-wrap">
      <p className="list-count">
        {findings.length === total ? `${formatNumber(total)} hallazgos` : `${formatNumber(findings.length)} de ${formatNumber(total)} hallazgos`}
      </p>
      <div
        className="finding-list"
        ref={box}
        onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
        role="listbox"
        aria-label="Hallazgos"
        aria-activedescendant={selectedId ? `h-${selectedId}` : undefined}
        tabIndex={0}
        onKeyDown={onKey}
      >
        <div style={{ height: range.totalHeight, position: 'relative' }}>
          <div style={{ transform: `translateY(${range.offsetTop}px)` }}>
            {findings.slice(range.start, range.end).map((f) => {
              const loc = f.locations[0];
              return (
                <div key={f.id} id={`h-${f.id}`} role="option" aria-selected={f.id === selectedId} className="finding-row" style={{ height: ROW }} onClick={() => onSelect(f.id)}>
                  <SeverityGlyph severity={f.severity} />
                  <span className="row-title">
                    {newIds?.has(f.id) ? <span className="tag-new">Nuevo</span> : null}
                    {f.title}
                  </span>
                  <span className="row-effort">{formatEffort(f.effort.minutes)}</span>
                  <span className="row-loc mono">
                    {loc && loc.file !== '.' ? `${loc.file}:${loc.startLine}` : 'Proyecto'}
                    {f.locations.length > 1 ? ` y ${f.locations.length - 1} más` : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
