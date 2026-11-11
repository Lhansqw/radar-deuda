import type { DiffHunk } from '@radar/engine';
import { tr } from '../i18n.js';

const SIGN = { context: ' ', removed: '−', added: '+' } as const;
const spoken = (kind: 'context' | 'removed' | 'added'): string => (kind === 'context' ? '' : kind === 'removed' ? tr('eliminada: ', 'removed: ') : tr('añadida: ', 'added: '));

/**
 * Diferencia unificada: un bloque por cambio con el número de línea antes y
 * después. El signo y la posición dicen lo mismo que el color.
 */
export function DiffView({ hunks }: { hunks: readonly DiffHunk[] }) {
  return (
    <div className="diff">
      {hunks.map((h, i) => (
        <figure key={`${h.file}:${h.oldStart}:${i}`} className="code diff-hunk">
          <figcaption>
            <span className="mono">{h.file}</span>
            <span className="mono muted">
              {tr('líneas', 'lines')} {h.oldStart}–{h.oldStart + Math.max(0, h.oldLines - 1)} → {h.newStart}–{h.newStart + Math.max(0, h.newLines - 1)}
            </span>
          </figcaption>
          <pre>
            {h.lines.map((l, k) => (
              <span key={k} className="diff-line" data-kind={l.kind}>
                <span className="ln">{l.oldLine ?? ''}</span>
                <span className="ln">{l.newLine ?? ''}</span>
                <span className="diff-sign" aria-hidden="true">
                  {SIGN[l.kind]}
                </span>
                {spoken(l.kind) ? <span className="visually-hidden">{spoken(l.kind)}</span> : null}
                {l.text === '' ? ' ' : l.text}
                {'\n'}
              </span>
            ))}
          </pre>
        </figure>
      ))}
    </div>
  );
}
