import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { AnalysisReport, Finding } from '@radar/engine';
import type { ChatMessage } from '../../shared/model.js';
import { Icon } from '../components/Icon.js';
import { SeverityGlyph } from '../components/SeverityMark.js';
import { parseAnswer, type Inline } from '../lib/answer.js';
import { formatDateTime } from '../lib/format.js';

/** Igual que MAX_QUESTION_CHARS de @radar/ai (lo comprueba también el proceso principal). */
const MAX_QUESTION = 2000;

const SUGGESTIONS = [
  '¿Por dónde empiezo a reducir la deuda?',
  '¿Qué deuda es nueva desde el análisis anterior?',
  '¿Qué archivos concentran más riesgo y por qué?',
  'Resume el estado del proyecto para el equipo en cinco frases.',
];

interface Props {
  report: AnalysisReport;
  analysisId: number;
  /** El análisis que se ve no es el más reciente. */
  isOld: boolean;
  onOpenFinding: (findingId: string) => void;
  onOpenSettings: () => void;
}

/**
 * Preguntas a la IA sobre el análisis que se está viendo. Solo se envían los
 * datos del informe (nunca código); las referencias a hallazgos de la
 * respuesta se comprueban y llevan a su detalle.
 */
export function Ask({ report, analysisId, isOld, onOpenFinding, onOpenSettings }: Props) {
  const [loaded, setLoaded] = useState<{ id: number; messages: ChatMessage[] } | null>(null);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const byId = useMemo(() => new Map(report.findings.map((f) => [f.id, f])), [report.findings]);

  useEffect(() => {
    let cancelled = false;
    window.radar.chat
      .list(analysisId)
      .then((messages) => !cancelled && setLoaded({ id: analysisId, messages }))
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoaded({ id: analysisId, messages: [] });
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [analysisId]);

  const messages = loaded?.id === analysisId ? loaded.messages : null;
  const count = (messages?.length ?? 0) + (pending ? 1 : 0);
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);

  async function ask(question: string): Promise<void> {
    const q = question.trim();
    if (q === '' || pending) return;
    setPending(q);
    setError(null);
    setDraft('');
    try {
      const added = await window.radar.chat.ask(analysisId, q);
      setLoaded((l) => (l && l.id === analysisId ? { id: analysisId, messages: [...l.messages, ...added] } : l));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // La pregunta vuelve al cuadro de texto para reintentarla o corregirla.
      setDraft(q);
    } finally {
      setPending(null);
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void ask(draft);
    }
  };

  const clear = async (): Promise<void> => {
    await window.radar.chat.clear(analysisId);
    setLoaded({ id: analysisId, messages: [] });
  };

  if (!messages) return null;
  const empty = messages.length === 0 && !pending;
  return (
    <div className="ask">
      <div className="ask-head">
        <div>
          <h2>Preguntar sobre el análisis</h2>
          <p className="muted small">
            {isOld ? `Análisis del ${formatDateTime(report.generatedAt)}. ` : ''}La IA solo recibe los datos del análisis (hallazgos, métricas, rutas y cambios
            desde el anterior), nunca el código.
          </p>
        </div>
        {messages.length > 0 ? (
          <button type="button" className="btn btn-quiet btn-small" onClick={() => void clear()} disabled={pending !== null}>
            <Icon name="trash" size={14} /> Borrar la conversación
          </button>
        ) : null}
      </div>

      <div className="ask-log" ref={log} aria-live="polite">
        {empty ? (
          <div className="ask-empty">
            <p>Prueba con una de estas preguntas o escribe la tuya.</p>
            <div className="ask-suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="chip" onClick={() => void ask(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="msg msg-user">
              <span className="msg-who">Tú</span>
              <p>{m.content}</p>
            </div>
          ) : (
            <Answer key={m.id} message={m} byId={byId} onOpenFinding={onOpenFinding} />
          ),
        )}
        {pending ? (
          <>
            <div className="msg msg-user">
              <span className="msg-who">Tú</span>
              <p>{pending}</p>
            </div>
            <div className="msg msg-ai" aria-busy="true">
              <span className="msg-who">IA</span>
              <p className="muted">Pensando… Con los modelos gratuitos puede tardar hasta un minuto.</p>
            </div>
          </>
        ) : null}
      </div>

      <form
        className="ask-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(draft);
        }}
      >
        {error ? (
          <div className="ask-error" role="alert">
            <p className="form-error">{error}</p>
            <button type="button" className="btn btn-quiet btn-small" onClick={onOpenSettings}>
              <Icon name="settings" size={14} /> Configuración
            </button>
          </div>
        ) : null}
        <div className="ask-input">
          <label htmlFor="pregunta" className="visually-hidden">
            Pregunta
          </label>
          <textarea
            id="pregunta"
            className="input"
            rows={2}
            value={draft}
            maxLength={MAX_QUESTION}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder="Pregunta sobre la deuda de este proyecto (Intro para enviar, Mayús+Intro para otra línea)"
            disabled={pending !== null}
          />
          <button type="submit" className="btn btn-primary" disabled={pending !== null || draft.trim() === ''}>
            Preguntar
          </button>
        </div>
      </form>
    </div>
  );
}

function Answer({ message: m, byId, onOpenFinding }: { message: ChatMessage; byId: ReadonlyMap<string, Finding>; onOpenFinding: (id: string) => void }) {
  const refs = new Map((m.meta?.references ?? []).map((r) => [r.alias, r.findingId]));
  const cited = [...new Set(m.meta?.references.map((r) => r.findingId) ?? [])].map((id) => byId.get(id)).filter((f): f is Finding => f !== undefined);
  return (
    <div className="msg msg-ai">
      <span className="msg-who">IA</span>
      <div className="msg-body">{renderAnswer(m.content, refs, byId, onOpenFinding)}</div>
      {m.meta?.truncated ? <p className="small muted">La respuesta se cortó por el límite de longitud.</p> : null}
      {m.meta && m.meta.unknownReferences.length > 0 ? (
        <p className="small muted">La IA citó referencias que no existen en el análisis ({m.meta.unknownReferences.join(', ')}): ignóralas.</p>
      ) : null}
      {m.meta ? (
        <p className="small muted">
          Modelo {m.meta.model}
          {m.meta.costUsd ? `, ${m.meta.costUsd.toFixed(4)} USD` : ''}. Orientativa: compruébalo en los hallazgos citados.
        </p>
      ) : null}
      {cited.length > 0 ? (
        <ul className="msg-refs" aria-label="Hallazgos citados">
          {cited.map((f) => (
            <li key={f.id}>
              <button type="button" className="ref-link" onClick={() => onOpenFinding(f.id)}>
                <SeverityGlyph severity={f.severity} />
                <span>{f.title}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Respuesta como texto (nunca HTML); [H3] se convierte en un enlace al hallazgo. */
function renderAnswer(text: string, refs: ReadonlyMap<string, string>, byId: ReadonlyMap<string, Finding>, open: (id: string) => void): ReactNode {
  const inline = (parts: Inline[]): ReactNode =>
    parts.map((p, i) => {
      if (p.kind === 'text') return <Fragment key={i}>{p.text}</Fragment>;
      if (p.kind === 'strong') return <strong key={i}>{p.text}</strong>;
      const id = refs.get(p.alias);
      const f = id ? byId.get(id) : undefined;
      return f ? (
        <button key={i} type="button" className="ref-inline" onClick={() => open(f.id)} title={f.title}>
          {p.alias}
        </button>
      ) : (
        <span key={i} className="ref-unknown" title="No existe en el análisis">
          {p.alias}
        </span>
      );
    });
  return parseAnswer(text).map((b, k) => {
    if (b.kind === 'p') {
      return (
        <p key={k}>
          {b.lines.map((l, i) => (
            <Fragment key={i}>
              {i > 0 ? <br /> : null}
              {inline(l)}
            </Fragment>
          ))}
        </p>
      );
    }
    const items = b.items.map((it, i) => <li key={i}>{inline(it)}</li>);
    return b.kind === 'ol' ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>;
  });
}
