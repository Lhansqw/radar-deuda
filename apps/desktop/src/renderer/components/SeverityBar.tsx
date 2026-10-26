import type { Severity } from '@radar/engine';
import { SEVERITIES, SEVERITY_LABEL } from '../lib/labels.js';
import { SeverityGlyph } from './SeverityMark.js';

/** Reparto de hallazgos por severidad: barra apilada con separaciones de 2 px y leyenda con las cantidades. */
export function SeverityBar({ counts }: { counts: Record<Severity, number> }) {
  const total = SEVERITIES.reduce((n, s) => n + counts[s], 0);
  return (
    <div className="sevbar">
      <div className="sevbar-track" role="img" aria-label={SEVERITIES.map((s) => `${SEVERITY_LABEL[s]}: ${counts[s]}`).join(', ')}>
        {total === 0 ? null : SEVERITIES.filter((s) => counts[s] > 0).map((s) => <span key={s} title={`${SEVERITY_LABEL[s]}: ${counts[s]}`} style={{ flexGrow: counts[s], background: `var(--sev-${s})` }} />)}
      </div>
      <ul className="sevbar-legend">
        {SEVERITIES.map((s) => (
          <li key={s} data-zero={counts[s] === 0 || undefined}>
            <SeverityGlyph severity={s} />
            {SEVERITY_LABEL[s]}
            <strong>{counts[s]}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}
