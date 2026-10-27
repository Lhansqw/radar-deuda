import { useMemo } from 'react';
import type { AnalysisReport, Finding, ReportComparison } from '@radar/engine';
import type { AnalysisSummary } from '../../shared/model.js';
import { Radar } from '../components/Radar.js';
import { SeverityBar } from '../components/SeverityBar.js';
import { SeverityGlyph } from '../components/SeverityMark.js';
import { TrendChart } from '../components/TrendChart.js';
import { sortFindings } from '../lib/findings.js';
import { formatDateTime, formatEffort, formatNumber, formatPercent, formatRelative } from '../lib/format.js';
import { RATING_HINT } from '../lib/labels.js';

interface Props {
  report: AnalysisReport;
  analyses: AnalysisSummary[];
  analysisId: number;
  onOpenFinding: (id: string) => void;
  onOpenFiles?: () => void;
  onShowLatest?: () => void;
  /** Respecto al análisis anterior (null si es el primero). */
  comparison?: ReportComparison | null;
  onShowNew?: () => void;
  onOpenHistory?: () => void;
}

const HORIZON: Record<'inmediato' | 'corto' | 'medio', string> = { inmediato: 'Ya', corto: 'Pronto', medio: 'Más adelante' };

export function Panel({ report, analyses, analysisId, onOpenFinding, onOpenFiles, onShowLatest, comparison, onShowNew, onOpenHistory }: Props) {
  const s = report.score;
  const latest = analyses[0]?.id === analysisId;
  const byId = useMemo(() => new Map(report.findings.map((f) => [f.id, f])), [report.findings]);
  const priorities = useMemo(() => sortFindings(report.findings.filter((f) => f.severity !== 'info'), 'severity').slice(0, 6), [report.findings]);
  const hotspots = (report.hotspots ?? []).slice(0, 6);
  const plan = report.ai?.plan;
  const limits = report.coverage.filter((c) => c.status !== 'analyzed');

  return (
    <div className="panel">
      {!latest ? (
        <div className="panel-banner">
          <p>Estás viendo el análisis del {formatDateTime(report.generatedAt)}, no el más reciente.</p>
          {onShowLatest ? (
            <button type="button" className="btn btn-small" onClick={onShowLatest}>
              Ver el más reciente
            </button>
          ) : null}
        </div>
      ) : null}

      <section className="panel-top">
        <div className="panel-radar">
          <Radar findings={report.findings} onOpen={onOpenFinding} />
        </div>
        <div className="panel-summary">
          <div className="score">
            <p className="score-figure">
              {s.score}
              <span>/100</span>
            </p>
            <p className="score-rating">
              Calificación <strong>{s.rating}</strong>. {RATING_HINT[s.rating]}.
            </p>
          </div>
          <dl className="facts">
            <div>
              <dt>Ratio de deuda</dt>
              <dd>{formatPercent(s.debtRatio)}</dd>
            </div>
            <div>
              <dt>Para corregirlo todo</dt>
              <dd>{formatEffort(s.remediationMinutes)}</dd>
            </div>
            <div>
              <dt>Código analizado</dt>
              <dd>{formatNumber(s.codeLines)} líneas</dd>
            </div>
            <div>
              <dt>Hallazgos</dt>
              <dd>{formatNumber(report.findings.length)}</dd>
            </div>
          </dl>
          <SeverityBar counts={report.summary.bySeverity} />
          {comparison ? <SinceLast c={comparison} onShowNew={onShowNew} onOpenHistory={onOpenHistory} /> : null}
          <p className="muted small">
            Puntuación según el método SQALE: esfuerzo de corrección frente al coste estimado de escribir el código. Análisis de {formatRelative(report.generatedAt)}.
          </p>
        </div>
      </section>

      <section className="panel-section">
        <h2>Evolución de la puntuación</h2>
        {analyses.length >= 2 ? (
          <TrendChart analyses={analyses} selectedId={analysisId} />
        ) : (
          <p className="muted">Con dos análisis o más verás aquí cómo cambia la puntuación. Vuelve a analizar después de hacer cambios.</p>
        )}
      </section>

      <div className="panel-columns">
        <section className="panel-section">
          <h2>{plan ? 'Plan de reducción propuesto por la IA' : 'Por dónde empezar'}</h2>
          {plan ? (
            <ol className="plan">
              {plan.steps.map((step) => (
                <li key={step.order}>
                  <p>
                    <span className="horizon">{HORIZON[step.horizon]}</span> <strong>{step.title}</strong>
                  </p>
                  <p className="muted">{step.rationale}</p>
                  <ul className="plan-findings">
                    {step.findingIds
                      .map((id) => byId.get(id))
                      .filter((f): f is Finding => f !== undefined)
                      .slice(0, 4)
                      .map((f) => (
                        <li key={f.id}>
                          <PriorityRow finding={f} onOpen={onOpenFinding} />
                        </li>
                      ))}
                  </ul>
                </li>
              ))}
            </ol>
          ) : priorities.length > 0 ? (
            <ul className="priorities">
              {priorities.map((f) => (
                <li key={f.id}>
                  <PriorityRow finding={f} onOpen={onOpenFinding} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No hay hallazgos que priorizar.</p>
          )}
        </section>

        <section className="panel-section">
          <h2>Puntos críticos</h2>
          {hotspots.length > 0 ? (
            <>
              <p className="muted small">Archivos que cambian a menudo y además acumulan deuda: donde reducirla rinde más.</p>
              <ul className="hotspots">
                {hotspots.map((h) => (
                  <li key={h.file}>
                    <span className="mono">{h.file}</span>
                    <span className="hotspot-bar" aria-hidden="true">
                      <span style={{ width: `${h.score}%` }} />
                    </span>
                    <span className="muted">
                      {h.commits} cambios, {formatEffort(h.debtMinutes)} de deuda
                    </span>
                  </li>
                ))}
              </ul>
              {onOpenFiles ? (
                <button type="button" className="btn btn-quiet btn-small" onClick={onOpenFiles}>
                  Ver la deuda por carpeta
                </button>
              ) : null}
            </>
          ) : (
            <p className="muted">
              {report.vcs
                ? 'No hay archivos con cambios frecuentes y deuda en el periodo analizado.'
                : 'Sin historial de Git: los puntos críticos necesitan que el proyecto sea un repositorio Git.'}
            </p>
          )}
        </section>
      </div>

      {limits.length > 0 || report.errors.length > 0 ? (
        <section className="panel-section">
          <h2>Límites de este análisis</h2>
          <ul className="limits">
            {limits.map((c) => (
              <li key={c.area}>
                <strong>{c.area}.</strong> {c.detail}
              </li>
            ))}
            {report.errors.map((e, i) => (
              <li key={`e${i}`}>
                <strong>{e.analyzer}.</strong> {e.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function PriorityRow({ finding: f, onOpen }: { finding: Finding; onOpen: (id: string) => void }) {
  const loc = f.locations[0];
  return (
    <button type="button" className="priority" onClick={() => onOpen(f.id)}>
      <SeverityGlyph severity={f.severity} />
      <span className="priority-title">{f.title}</span>
      <span className="priority-effort">{formatEffort(f.effort.minutes)}</span>
      <span className="priority-loc mono">{loc && loc.file !== '.' ? `${loc.file}:${loc.startLine}` : 'Proyecto'}</span>
    </button>
  );
}

/** Una línea con lo que cambió desde el análisis anterior, con acceso a la deuda nueva. */
function SinceLast({ c, onShowNew, onOpenHistory }: { c: ReportComparison; onShowNew?: (() => void) | undefined; onOpenHistory?: (() => void) | undefined }) {
  const delta = c.scoreDelta === 0 ? 'misma puntuación' : `${c.scoreDelta > 0 ? '+' : '−'}${Math.abs(c.scoreDelta)} puntos`;
  const unchanged = c.added.length === 0 && c.resolved.length === 0 && c.changed.length === 0;
  return (
    <div className="since">
      <p>
        Desde el análisis anterior ({formatRelative(c.baseline.generatedAt)}):{' '}
        {unchanged ? (
          'sin cambios en los hallazgos'
        ) : (
          <>
            <strong>{c.added.length}</strong> {c.added.length === 1 ? 'nuevo' : 'nuevos'}, <strong>{c.resolved.length}</strong> {c.resolved.length === 1 ? 'resuelto' : 'resueltos'}
            {c.changed.length > 0 ? `, ${c.changed.length} con otra severidad` : ''}
          </>
        )}
        , {delta}.
      </p>
      <div className="since-actions">
        {c.added.length > 0 && onShowNew ? (
          <button type="button" className="btn btn-small" onClick={onShowNew}>
            Ver la deuda nueva
          </button>
        ) : null}
        {onOpenHistory ? (
          <button type="button" className="btn btn-quiet btn-small" onClick={onOpenHistory}>
            Comparar en el historial
          </button>
        ) : null}
      </div>
    </div>
  );
}
