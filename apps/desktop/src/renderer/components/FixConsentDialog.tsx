import { useEffect, useRef } from 'react';
import type { FixPreviewInfo } from '../../shared/model.js';

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
        <h2 id="titulo-envio">¿Enviar este fragmento de código a {preview.provider}?</h2>
        <div id="desc-envio" className="consent">
          <p>
            Para proponer una corrección, la IA necesita ver el código. Tu configuración solo permite enviar metadatos, así que se pide permiso para esta propuesta y
            nada más.
          </p>
          <ul className="consent-files">
            {preview.snippets.map((s) => (
              <li key={`${s.file}:${s.startLine}`} className="mono">
                {s.file}, líneas {s.startLine}–{s.endLine}
              </li>
            ))}
          </ul>
          <p className="muted">
            Las líneas con posibles secretos se sustituyen por un aviso antes de enviarse.
            {preview.mayRetain ? ' Tienes permitido en OpenRouter que el proveedor guarde o entrene con los datos: este código podría conservarse.' : ''}
          </p>
          <details>
            <summary>Ver exactamente lo que se envía</summary>
            <pre className="consent-text">{preview.text}</pre>
          </details>
        </div>
        <div className="buttons">
          <button ref={cancel} type="button" className="btn btn-quiet" onClick={onCancel}>
            Cancelar
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            Enviar {preview.snippets.length === 1 ? 'el fragmento' : `los ${preview.snippets.length} fragmentos`} y proponer
          </button>
        </div>
      </div>
    </div>
  );
}
