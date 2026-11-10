import { useEffect, useMemo, useState } from 'react';
import { findingRefs } from '@radar/engine/refs';
import type { AiExplanation, AnalysisReport, Evidence, Finding, Location } from '@radar/engine';
import { errorMessage } from '../../shared/errors.js';
import type { CodeSnippet } from '../../shared/model.js';
import { Icon } from '../components/Icon.js';
import { SeverityMark } from '../components/SeverityMark.js';
import { useAction } from '../lib/action.js';
import { formatEffort } from '../lib/format.js';
import { CATEGORY_LABEL, CONFIDENCE_LABEL } from '../lib/labels.js';
import { FixProposal } from './FixProposal.js';
import { tr } from '../i18n.js';

/** Líneas de contexto alrededor de la ubicación. */
const CONTEXT = 4;

interface Props {
  finding: Finding;
  report: AnalysisReport;
  analysisId: number;
  /** Pide la explicación de la IA y recarga el informe al terminar. */
  onExplain: (findingId: string) => Promise<void>;
  onOpenSettings: () => void;
}

export function FindingDetail({ finding, report, analysisId, onExplain, onOpenSettings }: Props) {
  const ref = useMemo(() => findingRefs(report.findings).get(finding.id), [report.findings, finding.id]);
  const ai = report.ai?.explanations.find((e) => e.findingId === finding.id);
  const codeLocations = finding.locations.filter((l) => l.file !== '.' && l.startLine > 0);
  return (
    <article className="detail">
      <header className="detail-head">
        <div className="detail-tags">
          <SeverityMark severity={finding.severity} />
          <span>{CATEGORY_LABEL[finding.category]}</span>
          <span>
            {tr('Confianza', 'Confidence')} {CONFIDENCE_LABEL[finding.confidence]}
          </span>
          <span className="mono">{finding.ruleId}</span>
          {ref ? (
            <span className="mono" title={tr('Referencia del hallazgo en este análisis (la que cita la IA al preguntar)', 'Reference of the finding in this analysis (the one the AI cites when you ask)')}>
              {ref}
            </span>
          ) : null}
        </div>
        <h2>{finding.title}</h2>
        <p className="detail-message">{finding.message}</p>
      </header>

      {codeLocations.slice(0, 3).map((loc, i) => (
        <CodeBlock key={`${loc.file}:${loc.startLine}:${i}`} location={loc} analysisId={analysisId} />
      ))}
      {codeLocations.length > 3 ? (
        <p className="muted">{tr(`Y ${codeLocations.length - 3} ubicaciones más con el mismo problema.`, `And ${codeLocations.length - 3} more locations with the same problem.`)}</p>
      ) : null}

      <section className="detail-section">
        <h3>{tr('Por qué importa', 'Why it matters')}</h3>
        <p>{finding.impact}</p>
      </section>

      {finding.evidence.length > 0 ? (
        <section className="detail-section">
          <h3>{tr('Evidencia', 'Evidence')}</h3>
          <ul className="evidence">
            {finding.evidence.map((e, i) => (
              <EvidenceItem key={i} evidence={e} />
            ))}
          </ul>
        </section>
      ) : null}

      <section className="detail-section">
        <h3>
          {tr('Esfuerzo estimado:', 'Estimated effort:')} {formatEffort(finding.effort.minutes)}
        </h3>
        <p className="muted">{finding.effort.rationale}</p>
      </section>

      {ai ? <AiBlock explanation={ai} /> : <AiRequest onExplain={() => onExplain(finding.id)} onOpenSettings={onOpenSettings} />}

      <FixProposal key={`${analysisId}:${finding.id}`} finding={finding} analysisId={analysisId} onOpenSettings={onOpenSettings} />
    </article>
  );
}

function EvidenceItem({ evidence: e }: { evidence: Evidence }) {
  const m = e.metric;
  return (
    <li>
      <p>{e.description}</p>
      {m ? (
        <div className="metric">
          <span>
            {m.name}: <strong>{m.value}</strong> {m.unit ?? ''}
          </span>
          {/* La barra solo tiene sentido cuando el problema es superar el umbral (complejidad, líneas…). */}
          {m.value > m.threshold && m.threshold > 0 ? (
            <span className="metric-bar" aria-hidden="true">
              <span style={{ width: `${Math.min(100, (m.value / Math.max(m.value, m.threshold * 2)) * 100)}%` }} />
              <i style={{ left: `${(m.threshold / Math.max(m.value, m.threshold * 2)) * 100}%` }} />
            </span>
          ) : null}
          <span className="muted">
            {tr('umbral', 'threshold')} {m.threshold}
          </span>
        </div>
      ) : null}
      {e.snippet ? <pre className="evidence-snippet">{e.snippet}</pre> : null}
      <p className="evidence-tool mono">{e.tool}</p>
    </li>
  );
}

function CodeBlock({ location, analysisId }: { location: Location; analysisId: number }) {
  const [state, setState] = useState<{ key: string; snippet: CodeSnippet | null; error: string | null } | null>(null);
  const key = `${analysisId}:${location.file}:${location.startLine}:${location.endLine}`;
  useEffect(() => {
    let cancelled = false;
    window.radar.files
      .snippet(analysisId, location.file, Math.max(1, location.startLine - CONTEXT), location.endLine + CONTEXT)
      .then((snippet) => !cancelled && setState({ key, snippet, error: null }))
      .catch((err: unknown) => !cancelled && setState({ key, snippet: null, error: errorMessage(err) }));
    return () => {
      cancelled = true;
    };
  }, [key, analysisId, location.file, location.startLine, location.endLine]);

  const current = state?.key === key ? state : null;
  const snippet = current?.snippet ?? null;
  return (
    <figure className="code">
      <figcaption>
        <span className="mono">
          {location.file}:{location.startLine}
          {location.endLine > location.startLine ? `–${location.endLine}` : ''}
        </span>
        {location.symbol ? <span className="muted">{location.symbol}</span> : null}
        <button type="button" className="btn btn-quiet btn-small" onClick={() => void window.radar.files.reveal(analysisId, location.file).catch(() => undefined)}>
          <Icon name="reveal" size={14} /> {tr('Mostrar en la carpeta', 'Show in folder')}
        </button>
      </figcaption>
      {current?.error ? <p className="code-error">{current.error}</p> : null}
      {snippet ? (
        <>
          {snippet.changedSinceAnalysis ? (
            <p className="code-warn">{tr('El archivo cambió después del análisis: las líneas pueden no coincidir.', 'The file changed after the analysis: the lines may not match.')}</p>
          ) : null}
          <pre>
            {snippet.lines.map((text, i) => {
              const n = snippet.startLine + i;
              const hit = n >= location.startLine && n <= location.endLine;
              const hidden = snippet.redactedLines.includes(n);
              return (
                <span key={n} className="code-line" data-hit={hit || undefined} data-hidden={hidden || undefined}>
                  <span className="ln">{n}</span>
                  {text === '' ? ' ' : text}
                  {hidden ? <span className="code-note">{tr('valor oculto', 'hidden value')}</span> : null}
                  {'\n'}
                </span>
              );
            })}
          </pre>
        </>
      ) : current ? null : <p className="code-loading">{tr('Cargando…', 'Loading…')}</p>}
    </figure>
  );
}

const claimLabel = (kind: 'evidencia' | 'inferencia' | 'recomendacion'): string =>
  kind === 'evidencia' ? tr('Evidencia', 'Evidence') : kind === 'inferencia' ? tr('Inferencia', 'Inference') : tr('Recomendación', 'Recommendation');
const aiConfidence = (c: 'alta' | 'media' | 'baja'): string => (c === 'alta' ? tr('alta', 'high') : c === 'media' ? tr('media', 'medium') : tr('baja', 'low'));

function AiRequest({ onExplain, onOpenSettings }: { onExplain: () => Promise<void>; onOpenSettings: () => void }) {
  const { busy, error, run } = useAction();
  const explain = (): Promise<void> => run(onExplain);
  return (
    <section className="ai-ask" aria-label={tr('Explicación de la IA', 'AI explanation')}>
      <p>
        {busy
          ? tr('Explicando… Con los modelos gratuitos puede tardar hasta un minuto.', 'Explaining… With free models it can take up to a minute.')
          : tr(
              'La IA puede explicar este hallazgo y proponer cómo corregirlo. Se usan el proveedor y la privacidad elegidos en Configuración.',
              'The AI can explain this finding and propose how to fix it. The provider and privacy chosen in Settings are used.',
            )}
      </p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="buttons">
        <button type="button" className="btn" onClick={() => void explain()} disabled={busy} aria-busy={busy || undefined}>
          <Icon name="sparkle" size={16} /> {busy ? tr('Explicando…', 'Explaining…') : error ? tr('Reintentar', 'Retry') : tr('Explicar con IA', 'Explain with AI')}
        </button>
        {error ? (
          <button type="button" className="btn btn-quiet" onClick={onOpenSettings}>
            <Icon name="settings" size={16} /> {tr('Configuración', 'Settings')}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function AiBlock({ explanation: e }: { explanation: AiExplanation }) {
  return (
    <section className="detail-section ai">
      <h3>
        <Icon name="sparkle" size={16} /> {tr('Explicación de la IA', 'AI explanation')}
      </h3>
      <p className="muted">
        {tr('Orientativa: la evidencia verificable es la de arriba. Modelo', 'For guidance only: the verifiable evidence is the one above. Model')} {e.model}
        {e.fromCache ? tr(', desde caché', ', from cache') : ''}.
      </p>
      <dl className="ai-fields">
        <dt>{tr('Qué ocurre', 'What happens')}</dt>
        <dd>{e.summary}</dd>
        <dt>{tr('Causa probable (inferencia)', 'Probable cause (inference)')}</dt>
        <dd>{e.rootCause}</dd>
        <dt>{tr('Recomendación', 'Recommendation')}</dt>
        <dd>{e.recommendation}</dd>
      </dl>
      {e.claims.length > 0 ? (
        <ul className="claims">
          {e.claims.map((c, i) => (
            <li key={i} data-kind={c.kind}>
              <span className="claim-kind">{claimLabel(c.kind)}</span>
              <span>
                {c.text}
                {c.lines ? <span className="mono muted"> ({c.lines.file}:{c.lines.startLine}–{c.lines.endLine})</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="muted">
        {tr('Confianza', 'Confidence')} {aiConfidence(e.confidence)}
        {e.insufficientInformation ? tr('. El modelo indica que la información no basta para concluir.', '. The model says the information is not enough to conclude.') : '.'}
      </p>
      {e.validationNotes.length > 0 ? (
        <ul className="validation">
          {e.validationNotes.map((n, i) => (
            <li key={i}>
              {tr('Validación:', 'Validation:')} {n}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
