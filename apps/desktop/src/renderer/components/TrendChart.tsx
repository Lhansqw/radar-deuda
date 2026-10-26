import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { AnalysisSummary } from '../../shared/model.js';
import { formatDateTime } from '../lib/format.js';

const W = 720;
const H = 200;
const PAD = { top: 14, right: 18, bottom: 28, left: 34 };
const TICKS = [0, 25, 50, 75, 100];

/**
 * Evolución de la puntuación (una serie, escala fija 0–100). Puntero o
 * flechas del teclado: la línea vertical busca el análisis más cercano. El
 * historial muestra los mismos valores en una tabla.
 */
export function TrendChart({ analyses, selectedId, onSelect }: { analyses: AnalysisSummary[]; selectedId: number | null; onSelect?: (id: number) => void }) {
  const points = [...analyses].reverse(); // del más antiguo al más reciente
  const [active, setActive] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i: number): number => PAD.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (score: number): number => PAD.top + (1 - score / 100) * plotH;
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(p.score).toFixed(1)}`).join(' ');
  // Si todos los análisis son del mismo día, el eje muestra la hora.
  const sameDay = points.length > 0 && new Date(points[0]?.finishedAt ?? 0).toDateString() === new Date(points.at(-1)?.finishedAt ?? 0).toDateString();
  const tickLabel = (iso: string): string =>
    sameDay ? new Date(iso).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : new Date(iso).toLocaleDateString('es', { day: 'numeric', month: 'short' });

  const nearest = (clientX: number): number | null => {
    const rect = svg.current?.getBoundingClientRect();
    if (!rect || points.length === 0) return null;
    const vx = ((clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(x(i) - vx) < Math.abs(x(best) - vx)) best = i;
    return best;
  };
  const onMove = (e: PointerEvent<SVGSVGElement>): void => setActive(nearest(e.clientX));
  const onKey = (e: KeyboardEvent<SVGSVGElement>): void => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const cur = active ?? points.length - 1;
      setActive(Math.max(0, Math.min(points.length - 1, cur + (e.key === 'ArrowRight' ? 1 : -1))));
    } else if ((e.key === 'Enter' || e.key === ' ') && active !== null && onSelect) {
      e.preventDefault();
      const p = points[active];
      if (p) onSelect(p.id);
    }
  };

  const a = active !== null ? points[active] : undefined;
  // Etiquetas del eje X: la primera, la última y alguna intermedia sin solaparse.
  const step = Math.max(1, Math.ceil(points.length / 6));
  return (
    <div className="trend">
      <svg
        ref={svg}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Evolución de la puntuación en ${points.length} análisis: de ${points[0]?.score ?? 0} a ${points.at(-1)?.score ?? 0} sobre 100.`}
        tabIndex={0}
        onPointerMove={onMove}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive(points.length - 1)}
        onBlur={() => setActive(null)}
        onKeyDown={onKey}
        onClick={() => a && onSelect?.(a.id)}
      >
        {TICKS.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis' : 'grid'} />
            <text x={PAD.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle" className="tick">
              {t}
            </text>
          </g>
        ))}
        {points.map((p, i) =>
          i % step === 0 || i === points.length - 1 ? (
            <text key={p.id} x={x(i)} y={H - 8} textAnchor={points.length === 1 ? 'middle' : i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'} className="tick">
              {tickLabel(p.finishedAt)}
            </text>
          ) : null,
        )}
        <path d={path} className="trend-line" />
        {a && active !== null ? <line x1={x(active)} x2={x(active)} y1={PAD.top} y2={y(0)} className="crosshair" /> : null}
        {points.map((p, i) => (
          <circle key={p.id} cx={x(i)} cy={y(p.score)} r={p.id === selectedId || i === active ? 5.5 : 4} className="trend-dot" data-selected={p.id === selectedId || undefined} />
        ))}
        {/* Valor directo solo en el último punto */}
        {points.length > 0 ? (
          <text x={x(points.length - 1) - 8} y={y(points.at(-1)?.score ?? 0) - 10} textAnchor="end" className="trend-label">
            {points.at(-1)?.score}
          </text>
        ) : null}
      </svg>
      {a && active !== null ? (
        <div className="tooltip tooltip-trend" data-below={y(a.score) < H * 0.35 || undefined} style={{ left: `${(x(active) / W) * 100}%`, top: `${(y(a.score) / H) * 100}%` }} role="tooltip">
          <strong>
            {a.score}/100, calificación {a.rating}
          </strong>
          <span>{a.findings} hallazgos</span>
          <span className="muted">{formatDateTime(a.finishedAt)}</span>
        </div>
      ) : null}
    </div>
  );
}
