import { CATEGORIES, CATEGORY_LABEL } from '../lib/labels.js';

const C = 170;
const R = 120;
const STEP = (2 * Math.PI) / CATEGORIES.length;

interface Props {
  /** Barrido continuo mientras se analiza (sin él, da una sola vuelta al abrir). */
  scanning?: boolean;
  /** Avance medible de la etapa (0–1): llena el anillo exterior desde las 12. */
  progress?: number | null;
}

/**
 * Radar vacío con los mismos sectores que tendrá el panel. No pinta ecos:
 * hasta que termina el análisis no se sabe dónde caerá cada hallazgo.
 */
export function EmptyRadar({ scanning = false, progress = null }: Props) {
  const p = progress === null ? null : Math.min(1, Math.max(0, progress));
  return (
    <svg className="welcome-radar" viewBox="-70 0 480 340" aria-hidden="true">
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <circle key={f} cx={C} cy={C} r={R * f} className="welcome-ring" />
      ))}
      {CATEGORIES.map((cat, i) => {
        const a = i * STEP;
        const mid = a + STEP / 2;
        const s = Math.sin(mid);
        const anchor = Math.abs(s) < 0.2 ? 'middle' : s > 0 ? 'start' : 'end';
        return (
          <g key={cat}>
            <line x1={C} y1={C} x2={C + R * Math.sin(a)} y2={C - R * Math.cos(a)} className="welcome-ring" />
            <text x={C + (R + 12) * Math.sin(mid)} y={C - (R + 12) * Math.cos(mid)} textAnchor={anchor} dominantBaseline="middle" className="welcome-label">
              {CATEGORY_LABEL[cat]}
            </text>
          </g>
        );
      })}
      {p === null ? null : (
        <circle cx={C} cy={C} r={R} pathLength={100} strokeDasharray={`${p * 100} 100`} transform={`rotate(-90 ${C} ${C})`} className="scan-arc" />
      )}
      <g className={scanning ? 'welcome-sweep scan-sweep' : 'welcome-sweep'}>
        <path d={`M${C} ${C}L${C} ${C - R}A${R} ${R} 0 0 0 ${C - R * Math.sin(0.6)} ${C - R * Math.cos(0.6)}Z`} className="access-wedge" />
        <path d={`M${C} ${C}L${C} ${C - R}`} className="access-beam" />
      </g>
    </svg>
  );
}
