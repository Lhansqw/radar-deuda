import type { ReactNode } from 'react';
import { BrandMark } from './Icon.js';

/** Ecos del radar de la portada: anillo (0 = centro) y ángulo en grados, con la severidad de su color. */
const BLIPS = [
  { ring: 0.32, angle: 212, sev: 'critical', r: 7 },
  { ring: 0.55, angle: 128, sev: 'high', r: 6 },
  { ring: 0.71, angle: 300, sev: 'medium', r: 6.5 },
  { ring: 0.86, angle: 40, sev: 'low', r: 5 },
  { ring: 0.48, angle: 345, sev: 'medium', r: 5 },
  { ring: 0.9, angle: 168, sev: 'info', r: 4.5 },
] as const;

const C = 200;
const R = 180;

/**
 * Pantallas de acceso (inicio de sesión, registro, recuperación): a la
 * izquierda el radar de la marca, a la derecha el formulario. El barrido gira
 * una sola vez al abrir.
 */
export function AccessFrame({ children }: { children: ReactNode }) {
  return (
    <div className="access">
      <section className="access-art" aria-hidden="true">
        <svg className="access-radar" viewBox="0 0 400 400">
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <circle key={f} cx={C} cy={C} r={R * f} />
          ))}
          <path d={`M${C - R} ${C}H${C + R}M${C} ${C - R}V${C + R}`} />
          <g className="access-sweep">
            <path d={`M${C} ${C}L${C + R} ${C}A${R} ${R} 0 0 0 ${C + R * Math.cos(-Math.PI / 5)} ${C + R * Math.sin(-Math.PI / 5)}Z`} className="access-wedge" />
            <path d={`M${C} ${C}L${C + R} ${C}`} className="access-beam" />
          </g>
          {BLIPS.map((b) => {
            const a = (b.angle * Math.PI) / 180;
            return <circle key={`${b.ring}-${b.angle}`} cx={C + R * b.ring * Math.cos(a)} cy={C + R * b.ring * Math.sin(a)} r={b.r} className="access-blip" data-sev={b.sev} />;
          })}
        </svg>
        <div className="access-title">
          <BrandMark size={28} />
          <h1>Radar de Deuda Técnica</h1>
          <p>Encuentra el código que más cuesta mantener, en tus carpetas y en tus repositorios de GitHub.</p>
        </div>
      </section>
      <section className="access-panel">{children}</section>
    </div>
  );
}
