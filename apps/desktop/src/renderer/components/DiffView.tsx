import type { DiffHunk } from '@radar/engine';

const SIGN = { context: ' ', removed: '−', added: '+' } as const;
const SPOKEN = { context: '', removed: 'eliminada: ', added: 'añadida: ' } as const;

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
              líneas {h.oldStart}–{h.oldStart + Math.max(0, h.oldLines - 1)} → {h.newStart}–{h.newStart + Math.max(0, h.newLines - 1)}
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
                {SPOKEN[l.kind] ? <span className="visually-hidden">{SPOKEN[l.kind]}</span> : null}
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
