import { useEffect, useState } from 'react';
import type { Finding, ReportComparison } from '@radar/engine';
import type { AnalysisSummary } from '../../shared/model.js';
import { FindingLine } from '../components/FindingLine.js';
import { SeverityGlyph } from '../components/SeverityMark.js';
import { formatDateTime, formatDuration, formatEffort } from '../lib/format.js';
import { SEVERITY_LABEL } from '../lib/labels.js';

interface Props {
  analyses: AnalysisSummary[];
  /** Análisis que se muestra en el resto de vistas. */
  viewingId: number | null;
  onView: (analysisId: number) => void;
  onOpenFinding: (analysisId: number, findingId: string) => void;
}

const signed = (n: number, unit = ''): string => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(Math.round(n))}${unit}`;

/** Lista de análisis y comparación entre dos de ellos (deuda nueva, resuelta y que cambió de severidad). */
export function History({ analyses, viewingId, onView, onOpenFinding }: Props) {
  const [after, setAfter] = useState<number | null>(analyses[0]?.id ?? null);
  const [before, setBefore] = useState<number | null>(analyses[1]?.id ?? null);
  const [result, setResult] = useState<{ key: string; comparison: ReportComparison | null; error: string | null } | null>(null);
  const key = `${before}-${after}`;

  useEffect(() => {
    if (before === null || after === null || before === after) return;
    let cancelled = false;
    window.radar.analyses
      .compare(before, after)
      .then((comparison) => !cancelled && setResult({ key, comparison, error: null }))
      .catch((err: unknown) => !cancelled && setResult({ key, comparison: null, error: err instanceof Error ? err.message : String(err) }));
    return () => {
      cancelled = true;
    };
  }, [key, before, after]);

  const comparison = result?.key === key ? result.comparison : null;
  const label = (a: AnalysisSummary): string => `${formatDateTime(a.finishedAt)} (${a.score}/100${a.head ? `, ${a.head.slice(0, 7)}` : ''})`;

  return (
    <div className="history">
      <section className="panel-section">
        <h2>Análisis guardados</h2>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Fecha</th>
              <th scope="col">Commit</th>
              <th scope="col" className="num">
                Puntuación
              </th>
              <th scope="col" className="num">
                Cambio
              </th>
              <th scope="col" className="num">
                Hallazgos
              </th>
              <th scope="col" className="num">
                Altas y críticas
              </th>
              <th scope="col" className="num">
                Esfuerzo
              </th>
              <th scope="col" className="num">
                Duración
              </th>
              <th scope="col">IA</th>
              <th scope="col">
                <span className="visually-hidden">Acciones</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {analyses.map((a, i) => {
              const prev = analyses[i + 1];
              return (
                <tr key={a.id} aria-current={a.id === viewingId || undefined}>
                  <td>{formatDateTime(a.finishedAt)}</td>
                  <td className="mono">{a.head ? a.head.slice(0, 7) : '—'}</td>
                  <td className="num">
                    {a.score} <span className="muted">{a.rating}</span>
                  </td>
                  <td className="num">{prev ? signed(a.score - prev.score) : <span className="muted">primero</span>}</td>
                  <td className="num">{a.findings}</td>
                  <td className="num">{a.bySeverity.critical + a.bySeverity.high}</td>
                  <td className="num">{formatEffort(a.effortMinutes)}</td>
                  <td className="num muted">{formatDuration(a.durationMs)}</td>
                  <td>{a.withAi ? 'Sí' : <span className="muted">No</span>}</td>
                  <td className="actions">
                    {a.id === viewingId ? (
                      <span className="muted">Mostrando</span>
                    ) : (
                      <button type="button" className="btn btn-quiet btn-small" onClick={() => onView(a.id)}>
                        Ver este análisis
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="panel-section">
        <h2>Comparar dos análisis</h2>
        {analyses.length < 2 ? (
          <p className="muted">Con dos análisis o más podrás ver qué deuda es nueva y cuál se resolvió.</p>
        ) : (
          <>
            <div className="compare-pick">
              <label className="field">
                <span className="label">Antes</span>
                <select className="select" value={before ?? ''} onChange={(e) => setBefore(Number(e.target.value))}>
                  {analyses.map((a) => (
                    <option key={a.id} value={a.id}>
                      {label(a)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="label">Después</span>
                <select className="select" value={after ?? ''} onChange={(e) => setAfter(Number(e.target.value))}>
                  {analyses.map((a) => (
                    <option key={a.id} value={a.id}>
                      {label(a)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {before === after ? <p className="muted">Elige dos análisis distintos.</p> : null}
            {result?.key === key && result.error ? <p className="form-error">{result.error}</p> : null}
            {comparison && after !== null && before !== after ? (
              <>
                <p className="compare-summary">
                  Puntuación {signed(comparison.scoreDelta)} y esfuerzo de corrección {signed(comparison.remediationDeltaMinutes, ' min')}. {comparison.persisting}{' '}
                  {comparison.persisting === 1 ? 'hallazgo sigue' : 'hallazgos siguen'} igual.
                </p>
                <div className="compare-columns">
                  <ChangeList title="Deuda nueva" empty="No hay." findings={comparison.added} onOpen={(id) => onOpenFinding(after, id)} />
                  <ChangeList title="Resuelta" empty="No hay." findings={comparison.resolved} />
                  <div>
                    <h3>Cambian de severidad ({comparison.changed.length})</h3>
                    {comparison.changed.length === 0 ? (
                      <p className="muted">No hay.</p>
                    ) : (
                      <ul className="changes">
                        {comparison.changed.map((c) => (
                          <li key={c.after.id}>
                            <button type="button" className="priority" onClick={() => onOpenFinding(after, c.after.id)}>
                              <SeverityGlyph severity={c.after.severity} />
                              <span className="priority-title">{c.after.title}</span>
                              <span className="priority-effort" />
                              <span className="priority-loc">
                                {SEVERITY_LABEL[c.before.severity]} → {SEVERITY_LABEL[c.after.severity]}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

function ChangeList({ title, empty, findings, onOpen }: { title: string; empty: string; findings: Finding[]; onOpen?: (id: string) => void }) {
  return (
    <div>
      <h3>
        {title} ({findings.length})
      </h3>
      {findings.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul className="changes">
          {findings.map((f) => {
            const content = <FindingLine finding={f} />;
            return (
              <li key={f.id}>
                {onOpen ? (
                  <button type="button" className="priority" onClick={() => onOpen(f.id)}>
                    {content}
                  </button>
                ) : (
                  <div className="priority" data-static>
                    {content}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
