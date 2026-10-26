import type { Severity } from '@radar/engine';
import { SEVERITY_LABEL } from '../lib/labels.js';

/**
 * Cada severidad tiene forma propia además de color (rombo, triángulo,
 * círculo, anillo, guion): se distingue sin depender del color.
 */
export function SeverityGlyph({ severity, size = 10 }: { severity: Severity; size?: number }) {
  const c = `var(--sev-${severity})`;
  const s = size;
  const h = s / 2;
  let shape;
  switch (severity) {
    case 'critical':
      shape = <path d={`M${h} 0.5 L${s - 0.5} ${h} L${h} ${s - 0.5} L0.5 ${h}Z`} fill={c} />;
      break;
    case 'high':
      shape = <path d={`M${h} 0.8 L${s - 0.4} ${s - 1} L0.4 ${s - 1}Z`} fill={c} />;
      break;
    case 'medium':
      shape = <circle cx={h} cy={h} r={h - 0.8} fill={c} />;
      break;
    case 'low':
      shape = <circle cx={h} cy={h} r={h - 1.4} fill="none" stroke={c} strokeWidth={1.6} />;
      break;
    default:
      shape = <rect x={1} y={h - 1} width={s - 2} height={2} rx={1} fill={c} />;
  }
  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} aria-hidden="true">
      {shape}
    </svg>
  );
}

export function SeverityMark({ severity, label = true }: { severity: Severity; label?: boolean }) {
  return (
    <span className="sev" title={label ? undefined : `Severidad ${SEVERITY_LABEL[severity].toLowerCase()}`}>
      <SeverityGlyph severity={severity} />
      {label ? SEVERITY_LABEL[severity] : <span className="visually-hidden">{SEVERITY_LABEL[severity]}</span>}
    </span>
  );
}
