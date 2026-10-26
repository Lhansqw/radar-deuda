import { useMemo, useState } from 'react';
import type { Finding } from '@radar/engine';
import { formatEffort } from '../lib/format.js';
import { CATEGORY_LABEL, SEVERITY_LABEL } from '../lib/labels.js';
import { layoutRadar } from '../lib/radar.js';
import { SeverityMark } from './SeverityMark.js';

const SIZE = 460;
/** Margen lateral dentro del dibujo para las etiquetas de los sectores de los lados. */
const PAD_X = 92;
const WIDTH = SIZE + 2 * PAD_X;

/**
 * Radar de hallazgos: un sector por categoría y un anillo por severidad, con
 * lo crítico en el centro. La posición codifica la severidad además del
 * color. La lista de hallazgos es su equivalente en tabla.
 */
export function Radar({ findings, onOpen }: { findings: readonly Finding[]; onOpen: (findingId: string) => void }) {
  const layout = useMemo(() => layoutRadar(findings, SIZE), [findings]);
  const byId = useMemo(() => new Map(findings.map((f) => [f.id, f])), [findings]);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const { center: c, radius: R } = layout;
  const hovered = hover ? byId.get(hover.id) : undefined;
  const drawn = layout.blips.length;

  return (
    <div className="radar">
      <svg viewBox={`${-PAD_X} 0 ${WIDTH} ${SIZE}`} role="img" aria-labelledby="radar-titulo radar-desc">
        <title id="radar-titulo">Radar de hallazgos</title>
        <desc id="radar-desc">
          {drawn} hallazgos por categoría (sectores) y severidad (anillos; crítica en el centro). La lista completa está en la vista Hallazgos.
        </desc>
        <defs>
          <linearGradient id="barrido" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="var(--tiza)" stopOpacity="0" />
            <stop offset="1" stopColor="var(--tiza)" stopOpacity="0.16" />
          </linearGradient>
        </defs>

        {/* Anillos (de fuera hacia dentro para que el relleno del centro quede encima) */}
        {[...layout.rings].reverse().map((r) => (
          <circle key={r.severity} cx={c} cy={c} r={r.outer} className="radar-ring" />
        ))}
        {layout.sectors.map((s) => {
          const x = c + R * Math.sin(s.start);
          const y = c - R * Math.cos(s.start);
          return <line key={s.category} x1={c} y1={c} x2={x} y2={y} className="radar-spoke" />;
        })}

        {/* Barrido: una sola vuelta al abrir el panel */}
        <g className="radar-sweep" style={{ transformOrigin: `${c}px ${c}px` }}>
          <path d={`M${c} ${c} L${c} ${c - R} A${R} ${R} 0 0 0 ${c - R * Math.sin(0.55)} ${c - R * Math.cos(0.55)} Z`} fill="url(#barrido)" transform={`rotate(31.5 ${c} ${c})`} />
          <line x1={c} y1={c} x2={c} y2={c - R} className="radar-sweep-line" />
        </g>

        {/* Nombres de los anillos, sobre el eje de las 12 */}
        {layout.rings.map((r) => (
          <text key={r.severity} x={c - 4} y={c - r.outer + 13} className="radar-ring-label" textAnchor="end">
            {SEVERITY_LABEL[r.severity]}
          </text>
        ))}

        {layout.sectors.map((s) => (
          <text key={s.category} x={s.labelX} y={s.labelY} textAnchor={s.anchor} dominantBaseline="middle" className="radar-sector-label">
            {CATEGORY_LABEL[s.category]}
            <tspan className="radar-sector-count"> {s.count}</tspan>
          </text>
        ))}

        {layout.overflow.map((o) => (
          <text key={`${o.category}-${o.severity}`} x={o.x} y={o.y} className="radar-overflow" textAnchor="middle" dominantBaseline="middle">
            +{o.extra}
          </text>
        ))}

        {layout.blips.map((b) => {
          const f = byId.get(b.findingId);
          const active = hover?.id === b.findingId;
          return (
            <g
              key={b.findingId}
              className="radar-blip"
              data-active={active || undefined}
              tabIndex={0}
              role="button"
              aria-label={f ? `${SEVERITY_LABEL[b.severity]}: ${f.title}` : undefined}
              onPointerEnter={() => setHover({ id: b.findingId, x: b.x, y: b.y })}
              onPointerLeave={() => setHover((h) => (h?.id === b.findingId ? null : h))}
              onFocus={() => setHover({ id: b.findingId, x: b.x, y: b.y })}
              onBlur={() => setHover((h) => (h?.id === b.findingId ? null : h))}
              onClick={() => onOpen(b.findingId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpen(b.findingId);
                }
              }}
            >
              {/* Zona de interacción mayor que la marca */}
              <circle cx={b.x} cy={b.y} r={12} fill="transparent" />
              <circle cx={b.x} cy={b.y} r={active ? 6.5 : 5} fill={`var(--sev-${b.severity})`} stroke="var(--plano)" strokeWidth={2} />
            </g>
          );
        })}
      </svg>
      {hover && hovered ? (
        <div className="tooltip" data-below={hover.y < SIZE * 0.35 || undefined} style={{ left: `${((hover.x + PAD_X) / WIDTH) * 100}%`, top: `${(hover.y / SIZE) * 100}%` }} role="tooltip">
          <SeverityMark severity={hovered.severity} />
          <strong>{hovered.title}</strong>
          <span className="mono">
            {hovered.locations[0]?.file === '.' ? 'Proyecto' : `${hovered.locations[0]?.file}:${hovered.locations[0]?.startLine}`}
          </span>
          <span>Corregirlo: {formatEffort(hovered.effort.minutes)}</span>
        </div>
      ) : null}
    </div>
  );
}
