import { useEffect, useRef } from 'react';
import type { FixPreviewInfo } from '../../shared/model.js';
import { tr } from '../i18n.js';

/**
 * Antes de enviar código a un proveedor en la nube (si la privacidad
 * configurada no lo permite): qué archivos y líneas, a quién, y el texto
 * exacto que saldrá del equipo.
 */
export function FixConsentDialog({ preview, onCancel, onConfirm }: { preview: FixPreviewInfo; onCancel: () => void; onConfirm: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog dialog-wide" role="dialog" aria-modal="true" aria-labelledby="titulo-envio" aria-describedby="desc-envio">
        <h2 id="titulo-envio">{tr(`¿Enviar este fragmento de código a ${preview.provider}?`, `Send this code snippet to ${preview.provider}?`)}</h2>
        <div id="desc-envio" className="consent">
          <p>
            {tr(
              'Para proponer una corrección, la IA necesita ver el código. Tu configuración solo permite enviar metadatos, así que se pide permiso para esta propuesta y nada más.',
              'To propose a fix, the AI needs to see the code. Your settings only allow sending metadata, so permission is asked for this proposal and nothing else.',
            )}
          </p>
          <ul className="consent-files">
            {preview.snippets.map((s) => (
              <li key={`${s.file}:${s.startLine}`} className="mono">
                {s.file}, {tr('líneas', 'lines')} {s.startLine}–{s.endLine}
              </li>
            ))}
          </ul>
          <p className="muted">
            {tr('Las líneas con posibles secretos se sustituyen por un aviso antes de enviarse.', 'Lines with possible secrets are replaced with a notice before being sent.')}
            {preview.mayRetain
              ? tr(
                  ' Tienes permitido en OpenRouter que el proveedor guarde o entrene con los datos: este código podría conservarse.',
                  ' You allow the provider on OpenRouter to store or train on the data: this code could be kept.',
                )
              : ''}
          </p>
          <details>
            <summary>{tr('Ver exactamente lo que se envía', 'See exactly what is sent')}</summary>
            <pre className="consent-text">{preview.text}</pre>
          </details>
        </div>
        <div className="buttons">
          <button ref={cancel} type="button" className="btn btn-quiet" onClick={onCancel}>
            {tr('Cancelar', 'Cancel')}
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            {preview.snippets.length === 1
              ? tr('Enviar el fragmento y proponer', 'Send the snippet and propose')
              : tr(`Enviar los ${preview.snippets.length} fragmentos y proponer`, `Send the ${preview.snippets.length} snippets and propose`)}
          </button>
        </div>
      </div>
    </div>
  );
}
