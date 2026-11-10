import { useEffect, useState } from 'react';
import type { AiFixProposal, Finding } from '@radar/engine';
import { errorMessage } from '../../shared/errors.js';
import type { FixPreviewInfo, StoredFixProposal } from '../../shared/model.js';
import { DiffView } from '../components/DiffView.js';
import { FixConsentDialog } from '../components/FixConsentDialog.js';
import { Icon } from '../components/Icon.js';
import { formatDateTime } from '../lib/format.js';
import { diffStats, fixAvailability, secretFixAdvice } from '../lib/fix.js';
import { tr } from '../i18n.js';


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
        <h3>{tr('Cómo corregirlo', 'How to fix it')}</h3>
        <p>{secretFixAdvice()}</p>
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
      setError(errorMessage(err));
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
      setError(errorMessage(err));
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
        <Icon name="sparkle" size={16} /> {tr('Propuesta de corrección', 'Fix proposal')}
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
  const label = busy ? tr('Proponiendo…', 'Proposing…') : error ? tr('Reintentar', 'Retry') : tr('Proponer una corrección', 'Propose a fix');
  return (
    <div className="ai-ask">
      <p>
        {busy
          ? tr('Preparando la propuesta… Con los modelos gratuitos puede tardar hasta un minuto.', 'Preparing the proposal… With free models it can take up to a minute.')
          : tr(
              'La IA puede proponer el cambio como una diferencia que revisas antes de aplicarla tú. Necesita ver el fragmento de código del hallazgo.',
              'The AI can propose the change as a diff that you review before applying it yourself. It needs to see the code snippet of the finding.',
            )}
      </p>
      <ErrorText error={error} />
      <div className="buttons">
        <button type="button" className="btn" onClick={onStart} disabled={busy} aria-busy={busy || undefined}>
          {label}
        </button>
        {error ? (
          <button type="button" className="btn btn-quiet" onClick={onOpenSettings}>
            <Icon name="settings" size={16} /> {tr('Configuración', 'Settings')}
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
        {tr('Orientativa: revísala antes de aplicarla. Modelo', 'For guidance only: review it before applying it. Model')} {p.model}, {formatDateTime(p.createdAt)}
        {p.fromCache ? tr(', desde caché', ', from cache') : ''}.
      </p>
      {stale ? (
        <p className="fix-warn" role="status">
          <Icon name="alert" size={14} /> {tr('El archivo cambió después de la propuesta: puede que el parche ya no se aplique.', 'The file changed after the proposal: the patch may no longer apply.')}
        </p>
      ) : null}
      <p>{p.applicable ? p.summary : tr(`La IA no propone cambios: ${p.summary}`, `The AI proposes no changes: ${p.summary}`)}</p>
      {p.hunks.length > 0 ? (
        <>
          <p className="small muted">
            {tr(
              `${stats.removed} ${stats.removed === 1 ? 'línea eliminada' : 'líneas eliminadas'} y ${stats.added} ${stats.added === 1 ? 'añadida' : 'añadidas'}`,
              `${stats.removed} ${stats.removed === 1 ? 'line' : 'lines'} removed and ${stats.added} added`,
            )}
            {stats.files > 1 ? tr(` en ${stats.files} archivos`, ` in ${stats.files} files`) : ''}.
          </p>
          <DiffView hunks={p.hunks} />
        </>
      ) : null}
      <TitledList title={tr('Qué revisar', 'What to review')} items={p.risks} />
      <TitledList title={tr('Cómo comprobarlo', 'How to check it')} items={p.verification} />
      {p.validationNotes.length > 0 ? (
        <ul className="validation">
          {p.validationNotes.map((n, i) => (
            <li key={i}>
              {tr('Validación:', 'Validation:')} {n}
            </li>
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
      .then(() => setNotice(tr('Parche copiado al portapapeles.', 'Patch copied to the clipboard.')))
      .catch((err: unknown) => onError(errorMessage(err)));
  const save = (): void =>
    void window.radar.files
      .savePatch(analysisId, proposal.findingId)
      .then((path) => path && setNotice(tr(`Parche guardado en ${path}.`, `Patch saved to ${path}.`)))
      .catch((err: unknown) => onError(errorMessage(err)));
  return (
    <>
      <div className="fix-actions">
        {hasPatch ? (
          <>
            <button type="button" className="btn" onClick={copy}>
              {tr('Copiar el parche', 'Copy the patch')}
            </button>
            <button type="button" className="btn" onClick={save}>
              {tr('Guardar el parche…', 'Save the patch…')}
            </button>
          </>
        ) : null}
        <button type="button" className="btn btn-quiet" onClick={onAgain} disabled={busy} aria-busy={busy || undefined}>
          {busy ? tr('Proponiendo…', 'Proposing…') : tr('Volver a proponer', 'Propose again')}
        </button>
      </div>
      {notice ? (
        <p className="small" role="status">
          {notice}
        </p>
      ) : null}
      {hasPatch ? (
        <p className="small muted">
          {tr('La aplicación nunca modifica tus archivos. Para aplicarlo, en la carpeta del proyecto:', 'The app never changes your files. To apply it, in the project folder:')}{' '}
          <code>{tr('git apply nombre.patch', 'git apply name.patch')}</code>
        </p>
      ) : null}
    </>
  );
}
