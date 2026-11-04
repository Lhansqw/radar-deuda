import { Icon } from '../components/Icon.js';
import { CATEGORIES, CATEGORY_LABEL } from '../lib/labels.js';

const C = 170;
const R = 120;
const STEP = (2 * Math.PI) / CATEGORIES.length;

/**
 * Radar vacío con los mismos sectores que tendrá el panel: enseña qué busca
 * el análisis antes de que haya ningún proyecto. El barrido da una vuelta al abrir.
 */
function EmptyRadar() {
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
      <g className="welcome-sweep">
        <path d={`M${C} ${C}L${C} ${C - R}A${R} ${R} 0 0 0 ${C - R * Math.sin(0.6)} ${C - R * Math.cos(0.6)}Z`} className="access-wedge" />
        <path d={`M${C} ${C}L${C} ${C - R}`} className="access-beam" />
      </g>
    </svg>
  );
}

/** Primera apertura: sin proyectos todavía. */
export function Welcome({ onAddFolder, onAddGithub }: { onAddFolder: () => void; onAddGithub: () => void }) {
  return (
    <div className="welcome">
      <EmptyRadar />
      <div className="welcome-copy">
        <h2>Añade tu primer proyecto</h2>
        <p>
          Elige una carpeta con código o un repositorio de GitHub. Cada hallazgo aparecerá en el radar, en el sector de su categoría: cuanto más cerca del
          centro, más urgente.
        </p>
        <p className="muted small">El análisis solo lee archivos: no ejecuta nada del proyecto. La IA es opcional y, por defecto, no envía código.</p>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={onAddFolder}>
            <Icon name="folder" size={16} /> Añadir carpeta
          </button>
          <button type="button" className="btn" onClick={onAddGithub}>
            <Icon name="github" size={16} /> Añadir de GitHub
          </button>
        </div>
      </div>
    </div>
  );
}
