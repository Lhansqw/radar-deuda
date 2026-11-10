import { useState } from 'react';
import { errorMessage } from '../../../shared/errors.js';
import { tr } from '../../i18n.js';

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
      return tr('Diagnóstico copiado. Pégalo en el informe del error.', 'Diagnostics copied. Paste it into the error report.');
    });
  const clear = (): Promise<void> =>
    run(async () => {
      await window.radar.app.clearErrors();
      if (text !== null) await load();
      return tr('Registro de errores borrado.', 'Error log cleared.');
    });

  return (
    <div className="storage">
      <h3>{tr('Diagnóstico', 'Diagnostics')}</h3>
      <p className="hint">
        {tr(
          'Si algo falla, copia el diagnóstico y pégalo en el informe del error: versiones, sistema y los últimos errores de este equipo. No incluye rutas, código ni claves, y la aplicación no lo envía a ningún sitio.',
          'If something fails, copy the diagnostics and paste them into the error report: versions, system and the latest errors on this computer. It includes no paths, code or keys, and the app does not send it anywhere.',
        )}
      </p>
      <div className="storage-actions">
        <button type="button" className="btn btn-small" onClick={() => void copy()} disabled={busy}>
          {tr('Copiar diagnóstico', 'Copy diagnostics')}
        </button>
        <button type="button" className="btn btn-small btn-quiet" onClick={() => void run(async () => (await load(), tr('Esto es lo que se copia.', 'This is what gets copied.')))} disabled={busy}>
          {tr('Ver qué se copia', 'See what gets copied')}
        </button>
        <button type="button" className="btn btn-small btn-quiet" onClick={() => void clear()} disabled={busy}>
          {tr('Borrar el registro', 'Clear the log')}
        </button>
        {notice ? (
          <span className="small" role="status">
            {notice}
          </span>
        ) : null}
      </div>
      {text !== null ? (
        <pre className="consent-text" aria-label={tr('Diagnóstico', 'Diagnostics')}>
          {text}
        </pre>
      ) : null}
    </div>
  );
}
