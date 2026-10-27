import { useEffect, useState } from 'react';
import type { AiFixProposal, Finding } from '@radar/engine';
import type { FixPreviewInfo, StoredFixProposal } from '../../shared/model.js';
import { DiffView } from '../components/DiffView.js';
import { FixConsentDialog } from '../components/FixConsentDialog.js';
import { Icon } from '../components/Icon.js';
import { formatDateTime } from '../lib/format.js';
import { diffStats, fixAvailability, SECRET_FIX_ADVICE } from '../lib/fix.js';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * Propuesta de corrección de la IA como diferencia revisable. La aplicación
 * nunca la aplica: se copia o se guarda como parche y se aplica con Git.
 */
export function FixProposal({ finding, analysisId, onOpenSettings }: { finding: Finding; analysisId: number; onOpenSettings: () => void }) {
  const availability = fixAvailability(finding);
  if (availability === 'no-code') return null;
  if (availability === 'secret') {
    return (
      <section className="detail-section">
        <h3>Cómo corregirlo</h3>
        <p>{SECRET_FIX_ADVICE}</p>
      </section>
    );
  }
  return <FixSection findingId={finding.id} analysisId={analysisId} onOpenSettings={onOpenSettings} />;
}

/** Estado de la propuesta de un hallazgo y las acciones para pedirla. */
function useFixProposal(analysisId: number, findingId: string) {
  // undefined: cargando la propuesta guardada; null: no hay.
  const [stored, setStored] = useState<StoredFixProposal | null | undefined>(undefined);
  const [preview, setPreview] = useState<FixPreviewInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.radar.ai
      .getFix(analysisId, findingId)
      .then((s) => !cancelled && setStored(s))
      .catch(() => !cancelled && setStored(null));
    return () => {
      cancelled = true;
    };
  }, [analysisId, findingId]);

  /** Pide la propuesta; `consent`: el usuario aceptó enviar el código. */
  const send = async (consent: boolean): Promise<void> => {
    setPreview(null);
    setBusy(true);
    setError(null);
    try {
      setStored(await window.radar.ai.proposeFix(analysisId, findingId, consent));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  /** Comprueba antes qué se enviaría: si hace falta permiso, se pregunta (diálogo). */
  const start = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    let p: FixPreviewInfo;
    try {
      p = await window.radar.ai.fixPreview(analysisId, findingId);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
      return;
    }
    if (!p.needsConsent) return send(false);
    setPreview(p);
    setBusy(false);
  };

  return { stored, preview, busy, error, setError, start, send, cancelPreview: () => setPreview(null) };
}

function FixSection({ findingId, analysisId, onOpenSettings }: { findingId: string; analysisId: number; onOpenSettings: () => void }) {
  const fix = useFixProposal(analysisId, findingId);
  const proposal = fix.stored?.proposal;
  return (
    <section className="detail-section fix" aria-labelledby={`fix-${findingId}`}>
      <h3 id={`fix-${findingId}`}>
        <Icon name="sparkle" size={16} /> Propuesta de corrección
      </h3>
      {fix.stored === undefined ? null : proposal ? (
        <>
          <FixResult proposal={proposal} stale={fix.stored?.stale === true} />
          <ErrorText error={fix.error} />
          <FixActions key={proposal.createdAt} proposal={proposal} analysisId={analysisId} busy={fix.busy} onAgain={() => void fix.start()} onError={fix.setError} />
        </>
      ) : (
        <FixRequest busy={fix.busy} error={fix.error} onStart={() => void fix.start()} onOpenSettings={onOpenSettings} />
      )}
      {fix.preview ? <FixConsentDialog preview={fix.preview} onCancel={fix.cancelPreview} onConfirm={() => void fix.send(true)} /> : null}
    </section>
  );
}

function ErrorText({ error }: { error: string | null }) {
  return error ? (
    <p className="form-error" role="alert">
      {error}
    </p>
  ) : null;
}

/** Aún no hay propuesta: qué hace y el botón para pedirla. */
function FixRequest({ busy, error, onStart, onOpenSettings }: { busy: boolean; error: string | null; onStart: () => void; onOpenSettings: () => void }) {
  const label = busy ? 'Proponiendo…' : error ? 'Reintentar' : 'Proponer una corrección';
  return (
    <div className="ai-ask">
      <p>
        {busy
          ? 'Preparando la propuesta… Con los modelos gratuitos puede tardar hasta un minuto.'
          : 'La IA puede proponer el cambio como una diferencia que revisas antes de aplicarla tú. Necesita ver el fragmento de código del hallazgo.'}
      </p>
      <ErrorText error={error} />
      <div className="buttons">
        <button type="button" className="btn" onClick={onStart} disabled={busy} aria-busy={busy || undefined}>
          {label}
        </button>
        {error ? (
          <button type="button" className="btn btn-quiet" onClick={onOpenSettings}>
            <Icon name="settings" size={16} /> Configuración
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** La propuesta: resumen, diferencia, qué revisar y cómo comprobarla. */
function FixResult({ proposal: p, stale }: { proposal: AiFixProposal; stale: boolean }) {
  const stats = diffStats(p.hunks);
  return (
    <>
      <p className="muted">
        Orientativa: revísala antes de aplicarla. Modelo {p.model}, {formatDateTime(p.createdAt)}
        {p.fromCache ? ', desde caché' : ''}.
      </p>
      {stale ? (
        <p className="fix-warn" role="status">
          <Icon name="alert" size={14} /> El archivo cambió después de la propuesta: puede que el parche ya no se aplique.
        </p>
      ) : null}
      <p>{p.applicable ? p.summary : `La IA no propone cambios: ${p.summary}`}</p>
      {p.hunks.length > 0 ? (
        <>
          <p className="small muted">
            {plural(stats.removed, 'línea eliminada', 'líneas eliminadas')} y {stats.added} {stats.added === 1 ? 'añadida' : 'añadidas'}
            {stats.files > 1 ? ` en ${stats.files} archivos` : ''}.
          </p>
          <DiffView hunks={p.hunks} />
        </>
      ) : null}
      <TitledList title="Qué revisar" items={p.risks} />
      <TitledList title="Cómo comprobarlo" items={p.verification} />
      {p.validationNotes.length > 0 ? (
        <ul className="validation">
          {p.validationNotes.map((n, i) => (
            <li key={i}>Validación: {n}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function TitledList({ title, items }: { title: string; items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <>
      <h4>{title}</h4>
      <ul className="fix-list">
        {items.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
    </>
  );
}

/** Copiar o guardar el parche (nunca aplicarlo) y volver a proponer. */
function FixActions({
  proposal,
  analysisId,
  busy,
  onAgain,
  onError,
}: {
  proposal: AiFixProposal;
  analysisId: number;
  busy: boolean;
  onAgain: () => void;
  onError: (message: string) => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const hasPatch = proposal.patch !== '';
  const copy = (): void =>
    void window.radar.app
      .copyText(proposal.patch)
      .then(() => setNotice('Parche copiado al portapapeles.'))
      .catch((err: unknown) => onError(errorText(err)));
  const save = (): void =>
    void window.radar.files
      .savePatch(analysisId, proposal.findingId)
      .then((path) => path && setNotice(`Parche guardado en ${path}.`))
      .catch((err: unknown) => onError(errorText(err)));
  return (
    <>
      <div className="fix-actions">
        {hasPatch ? (
          <>
            <button type="button" className="btn" onClick={copy}>
              Copiar el parche
            </button>
            <button type="button" className="btn" onClick={save}>
              Guardar el parche…
            </button>
          </>
        ) : null}
        <button type="button" className="btn btn-quiet" onClick={onAgain} disabled={busy} aria-busy={busy || undefined}>
          {busy ? 'Proponiendo…' : 'Volver a proponer'}
        </button>
      </div>
      {notice ? (
        <p className="small" role="status">
          {notice}
        </p>
      ) : null}
      {hasPatch ? (
        <p className="small muted">
          La aplicación nunca modifica tus archivos. Para aplicarlo, en la carpeta del proyecto: <code>git apply nombre.patch</code>
        </p>
      ) : null}
    </>
  );
}
