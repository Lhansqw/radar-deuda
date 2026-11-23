import type { Severity } from '@radar/engine';
import { SEVERITIES, SEVERITY_LABEL } from '../lib/labels.js';
import { SeverityGlyph } from './SeverityMark.js';
import { tr } from '../i18n.js';

interface Props {
  counts: Record<Severity, number>;
  /** Severidad señalada (por la leyenda o desde el radar). */
  active?: Severity | null;
  /** Señalar una severidad al pasar por la leyenda (null al salir). */
  onHighlight?: ((severity: Severity | null) => void) | undefined;
  /** Abrir los hallazgos de esa severidad. */
  onOpen?: ((severity: Severity) => void) | undefined;
}

/** Reparto de hallazgos por severidad: barra apilada con separaciones de 2 px y leyenda con las cantidades. */
export function SeverityBar({ counts, active = null, onHighlight, onOpen }: Props) {
  const total = SEVERITIES.reduce((n, s) => n + counts[s], 0);
  const interactive = onHighlight !== undefined || onOpen !== undefined;
  return (
    <div className="sevbar" data-pointing={active !== null || undefined}>
      <div className="sevbar-track" role="img" aria-label={SEVERITIES.map((s) => `${SEVERITY_LABEL[s]}: ${counts[s]}`).join(', ')}>
        {total === 0
          ? null
          : SEVERITIES.filter((s) => counts[s] > 0).map((s) => (
              <span key={s} title={`${SEVERITY_LABEL[s]}: ${counts[s]}`} data-active={active === s || undefined} style={{ flexGrow: counts[s], background: `var(--sev-${s})` }} />
            ))}
      </div>
      <ul className="sevbar-legend">
        {SEVERITIES.map((s) => {
          const zero = counts[s] === 0;
          const content = (
            <>
              <SeverityGlyph severity={s} />
              {SEVERITY_LABEL[s]}
              <strong>{counts[s]}</strong>
            </>
          );
          return (
            <li key={s} data-zero={zero || undefined} data-active={active === s || undefined}>
              {interactive && !zero ? (
                <button
                  type="button"
                  className="sevbar-key"
                  onPointerEnter={() => onHighlight?.(s)}
                  onPointerLeave={() => onHighlight?.(null)}
                  onFocus={() => onHighlight?.(s)}
                  onBlur={() => onHighlight?.(null)}
                  onClick={() => onOpen?.(s)}
                  title={tr(`Ver los hallazgos de severidad ${SEVERITY_LABEL[s].toLowerCase()}`, `See the ${SEVERITY_LABEL[s].toLowerCase()} severity findings`)}
                >
                  {content}
                </button>
              ) : (
                content
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
