import { useState } from 'react';
import { errorMessage } from '../../../shared/errors.js';

/**
 * Diagnóstico para un informe de error: versiones, sistema y errores
 * recientes del registro local. Se puede ver antes de copiarlo; no incluye
 * rutas, código ni claves (el proceso principal lo limpia al guardar).
 */
export function Diagnostics() {
  const [text, setText] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<string>): Promise<void> => {
    setBusy(true);
    try {
      setNotice(await action());
    } catch (err) {
      setNotice(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const load = async (): Promise<string> => {
    const t = await window.radar.app.diagnostics();
    setText(t);
    return t;
  };
  const copy = (): Promise<void> =>
    run(async () => {
      await window.radar.app.copyText(await load());
      return 'Diagnóstico copiado. Pégalo en el informe del error.';
    });
  const clear = (): Promise<void> =>
    run(async () => {
      await window.radar.app.clearErrors();
      if (text !== null) await load();
      return 'Registro de errores borrado.';
    });

  return (
    <div className="storage">
      <h3>Diagnóstico</h3>
      <p className="hint">
        Si algo falla, copia el diagnóstico y pégalo en el informe del error: versiones, sistema y los últimos errores de este equipo. No incluye rutas, código ni
        claves, y la aplicación no lo envía a ningún sitio.
      </p>
      <div className="storage-actions">
        <button type="button" className="btn btn-small" onClick={() => void copy()} disabled={busy}>
          Copiar diagnóstico
        </button>
        <button type="button" className="btn btn-small btn-quiet" onClick={() => void run(async () => (await load(), 'Esto es lo que se copia.'))} disabled={busy}>
          Ver qué se copia
        </button>
        <button type="button" className="btn btn-small btn-quiet" onClick={() => void clear()} disabled={busy}>
          Borrar el registro
        </button>
        {notice ? (
          <span className="small" role="status">
            {notice}
          </span>
        ) : null}
      </div>
      {text !== null ? (
        <pre className="consent-text" aria-label="Diagnóstico">
          {text}
        </pre>
      ) : null}
    </div>
  );
}
