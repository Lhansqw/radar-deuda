import type { Finding } from '@radar/engine';
import { formatEffort } from '../lib/format.js';
import { SeverityGlyph } from './SeverityMark.js';

/** Un hallazgo en una línea: severidad, título, esfuerzo y ubicación (en listas de prioridades y cambios). */
export function FindingLine({ finding: f }: { finding: Finding }) {
  const loc = f.locations[0];
  return (
    <>
      <SeverityGlyph severity={f.severity} />
      <span className="priority-title">{f.title}</span>
      <span className="priority-effort">{formatEffort(f.effort.minutes)}</span>
      <span className="priority-loc mono">{loc && loc.file !== '.' ? `${loc.file}:${loc.startLine}` : 'Proyecto'}</span>
    </>
  );
}
