import { useEffect, useState } from 'react';
import type { AiExplanation, AnalysisReport, Evidence, Finding, Location } from '@radar/engine';
import type { CodeSnippet } from '../../shared/model.js';
import { Icon } from '../components/Icon.js';
import { SeverityMark } from '../components/SeverityMark.js';
import { formatEffort } from '../lib/format.js';
import { CATEGORY_LABEL, CONFIDENCE_LABEL } from '../lib/labels.js';

/** Líneas de contexto alrededor de la ubicación. */
const CONTEXT = 4;

export function FindingDetail({ finding, report, analysisId }: { finding: Finding; report: AnalysisReport; analysisId: number }) {
  const ai = report.ai?.explanations.find((e) => e.findingId === finding.id);
  const codeLocations = finding.locations.filter((l) => l.file !== '.' && l.startLine > 0);
  return (
    <article className="detail">
      <header className="detail-head">
        <div className="detail-tags">
          <SeverityMark severity={finding.severity} />
          <span>{CATEGORY_LABEL[finding.category]}</span>
          <span>Confianza {CONFIDENCE_LABEL[finding.confidence]}</span>
          <span className="mono">{finding.ruleId}</span>
        </div>
        <h2>{finding.title}</h2>
        <p className="detail-message">{finding.message}</p>
      </header>

      {codeLocations.slice(0, 3).map((loc, i) => (
        <CodeBlock key={`${loc.file}:${loc.startLine}:${i}`} location={loc} analysisId={analysisId} />
      ))}
      {codeLocations.length > 3 ? <p className="muted">Y {codeLocations.length - 3} ubicaciones más con el mismo problema.</p> : null}

      <section className="detail-section">
        <h3>Por qué importa</h3>
        <p>{finding.impact}</p>
      </section>

      {finding.evidence.length > 0 ? (
        <section className="detail-section">
          <h3>Evidencia</h3>
          <ul className="evidence">
            {finding.evidence.map((e, i) => (
              <EvidenceItem key={i} evidence={e} />
            ))}
          </ul>
        </section>
      ) : null}

      <section className="detail-section">
        <h3>Esfuerzo estimado: {formatEffort(finding.effort.minutes)}</h3>
        <p className="muted">{finding.effort.rationale}</p>
      </section>

      {ai ? <AiBlock explanation={ai} /> : null}
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
          <span className="muted">umbral {m.threshold}</span>
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
      .catch((err: unknown) => !cancelled && setState({ key, snippet: null, error: err instanceof Error ? err.message : String(err) }));
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
          <Icon name="reveal" size={14} /> Mostrar en la carpeta
        </button>
      </figcaption>
      {current?.error ? <p className="code-error">{current.error}</p> : null}
      {snippet ? (
        <>
          {snippet.changedSinceAnalysis ? <p className="code-warn">El archivo cambió después del análisis: las líneas pueden no coincidir.</p> : null}
          <pre>
            {snippet.lines.map((text, i) => {
              const n = snippet.startLine + i;
              const hit = n >= location.startLine && n <= location.endLine;
              const hidden = snippet.redactedLines.includes(n);
              return (
                <span key={n} className="code-line" data-hit={hit || undefined} data-hidden={hidden || undefined}>
                  <span className="ln">{n}</span>
                  {text === '' ? ' ' : text}
                  {hidden ? <span className="code-note">valor oculto</span> : null}
                  {'\n'}
                </span>
              );
            })}
          </pre>
        </>
      ) : current ? null : <p className="code-loading">Cargando…</p>}
    </figure>
  );
}

const CLAIM_LABEL = { evidencia: 'Evidencia', inferencia: 'Inferencia', recomendacion: 'Recomendación' } as const;

function AiBlock({ explanation: e }: { explanation: AiExplanation }) {
  return (
    <section className="detail-section ai">
      <h3>
        <Icon name="sparkle" size={16} /> Explicación de la IA
      </h3>
      <p className="muted">Orientativa: la evidencia verificable es la de arriba. Modelo {e.model}{e.fromCache ? ', desde caché' : ''}.</p>
      <dl className="ai-fields">
        <dt>Qué ocurre</dt>
        <dd>{e.summary}</dd>
        <dt>Causa probable (inferencia)</dt>
        <dd>{e.rootCause}</dd>
        <dt>Recomendación</dt>
        <dd>{e.recommendation}</dd>
      </dl>
      {e.claims.length > 0 ? (
        <ul className="claims">
          {e.claims.map((c, i) => (
            <li key={i} data-kind={c.kind}>
              <span className="claim-kind">{CLAIM_LABEL[c.kind]}</span>
              {c.text}
              {c.lines ? <span className="mono muted"> ({c.lines.file}:{c.lines.startLine}–{c.lines.endLine})</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="muted">
        Confianza {e.confidence}
        {e.insufficientInformation ? '. El modelo indica que la información no basta para concluir.' : '.'}
      </p>
      {e.validationNotes.length > 0 ? (
        <ul className="validation">
          {e.validationNotes.map((n, i) => (
            <li key={i}>Validación: {n}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
