import { useEffect, useState } from 'react';
import type { Finding } from '@radar/engine';
import type { FixPreviewInfo, StoredFixProposal } from '../../shared/model.js';
import { DiffView } from '../components/DiffView.js';
import { FixConsentDialog } from '../components/FixConsentDialog.js';
import { Icon } from '../components/Icon.js';
import { formatDateTime } from '../lib/format.js';
import { diffStats, fixAvailability, SECRET_FIX_ADVICE } from '../lib/fix.js';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Propuesta de corrección de la IA como diferencia revisable. La aplicación
 * nunca la aplica: se copia o se guarda como parche y se aplica con Git.
 */
export function FixProposal({ finding, analysisId, onOpenSettings }: { finding: Finding; analysisId: number; onOpenSettings: () => void }) {
  const availability = fixAvailability(finding);
  // undefined: cargando la propuesta guardada; null: no hay.
  const [stored, setStored] = useState<StoredFixProposal | null | undefined>(availability === 'available' ? undefined : null);
  const [preview, setPreview] = useState<FixPreviewInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (availability !== 'available') return;
    let cancelled = false;
    window.radar.ai
      .getFix(analysisId, finding.id)
      .then((s) => !cancelled && setStored(s))
      .catch(() => !cancelled && setStored(null));
    return () => {
      cancelled = true;
    };
  }, [analysisId, finding.id, availability]);

  if (availability === 'no-code') return null;
  if (availability === 'secret') {
    return (
      <section className="detail-section">
        <h3>Cómo corregirlo</h3>
        <p>{SECRET_FIX_ADVICE}</p>
      </section>
    );
  }

  const send = async (consent: boolean): Promise<void> => {
    setPreview(null);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setStored(await window.radar.ai.proposeFix(analysisId, finding.id, consent));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const start = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const p = await window.radar.ai.fixPreview(analysisId, finding.id);
      if (p.needsConsent) {
        setPreview(p);
        setBusy(false);
        return;
      }
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
      return;
    }
    await send(false);
  };

  const p = stored?.proposal;
  const stats = p ? diffStats(p.hunks) : null;
  return (
    <section className="detail-section fix" aria-labelledby={`fix-${finding.id}`}>
      <h3 id={`fix-${finding.id}`}>
        <Icon name="sparkle" size={16} /> Propuesta de corrección
      </h3>
      {stored === undefined ? null : !p ? (
        <div className="ai-ask">
          <p>
            {busy
              ? 'Preparando la propuesta… Con los modelos gratuitos puede tardar hasta un minuto.'
              : 'La IA puede proponer el cambio como una diferencia que revisas antes de aplicarla tú. Necesita ver el fragmento de código del hallazgo.'}
          </p>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="buttons">
            <button type="button" className="btn" onClick={() => void start()} disabled={busy} aria-busy={busy || undefined}>
              {busy ? 'Proponiendo…' : error ? 'Reintentar' : 'Proponer una corrección'}
            </button>
            {error ? (
              <button type="button" className="btn btn-quiet" onClick={onOpenSettings}>
                <Icon name="settings" size={16} /> Configuración
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <p className="muted">
            Orientativa: revísala antes de aplicarla. Modelo {p.model}, {formatDateTime(p.createdAt)}
            {p.fromCache ? ', desde caché' : ''}.
          </p>
          {stored?.stale ? (
            <p className="fix-warn" role="status">
              <Icon name="alert" size={14} /> El archivo cambió después de la propuesta: puede que el parche ya no se aplique.
            </p>
          ) : null}
          <p>{p.applicable ? p.summary : `La IA no propone cambios: ${p.summary}`}</p>
          {p.hunks.length > 0 && stats ? (
            <>
              <p className="small muted">
                {stats.removed} {stats.removed === 1 ? 'línea eliminada' : 'líneas eliminadas'} y {stats.added} {stats.added === 1 ? 'añadida' : 'añadidas'}
                {stats.files > 1 ? ` en ${stats.files} archivos` : ''}.
              </p>
              <DiffView hunks={p.hunks} />
            </>
          ) : null}
          {p.risks.length > 0 ? (
            <>
              <h4>Qué revisar</h4>
              <ul className="fix-list">
                {p.risks.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </>
          ) : null}
          {p.verification.length > 0 ? (
            <>
              <h4>Cómo comprobarlo</h4>
              <ul className="fix-list">
                {p.verification.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </>
          ) : null}
          {p.validationNotes.length > 0 ? (
            <ul className="validation">
              {p.validationNotes.map((n, i) => (
                <li key={i}>Validación: {n}</li>
              ))}
            </ul>
          ) : null}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="fix-actions">
            {p.patch !== '' ? (
              <>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    void window.radar.app
                      .copyText(p.patch)
                      .then(() => setNotice('Parche copiado al portapapeles.'))
                      .catch((err: unknown) => setError(errorText(err)))
                  }
                >
                  Copiar el parche
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    void window.radar.files
                      .savePatch(analysisId, finding.id)
                      .then((path) => path && setNotice(`Parche guardado en ${path}.`))
                      .catch((err: unknown) => setError(errorText(err)))
                  }
                >
                  Guardar el parche…
                </button>
              </>
            ) : null}
            <button type="button" className="btn btn-quiet" onClick={() => void start()} disabled={busy} aria-busy={busy || undefined}>
              {busy ? 'Proponiendo…' : 'Volver a proponer'}
            </button>
          </div>
          {notice ? (
            <p className="small" role="status">
              {notice}
            </p>
          ) : null}
          {p.patch !== '' ? (
            <p className="small muted">
              La aplicación nunca modifica tus archivos. Para aplicarlo, en la carpeta del proyecto: <code>git apply nombre.patch</code>
            </p>
          ) : null}
        </>
      )}
      {preview ? <FixConsentDialog preview={preview} onCancel={() => setPreview(null)} onConfirm={() => void send(true)} /> : null}
    </section>
  );
}
