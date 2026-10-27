import { useEffect, useState } from 'react';
import type { AppInfo } from '../../../shared/ipc.js';
import type { StorageInfo } from '../../../shared/model.js';
import { formatBytes } from '../../lib/format.js';
import { errorText, SettingsSection } from './SettingsSection.js';

/** Versiones, dónde guarda los datos y espacio en disco. */
export function AppSection({ info }: { info: AppInfo }) {
  return (
    <SettingsSection id="s-acerca" title="Aplicación">
      <dl className="about">
        <dt>Versión</dt>
        <dd>{info.versions.app}</dd>
        <dt>Electron, Chromium y Node</dt>
        <dd>
          {info.versions.electron}, {info.versions.chrome} y {info.versions.node}
        </dd>
        <dt>Proyectos, historial y ajustes</dt>
        <dd className="mono">{info.dataDir}</dd>
        <dt>Caché (compartida con la CLI)</dt>
        <dd className="mono">{info.cacheDir}</dd>
        <dt>Clones de GitHub</dt>
        <dd className="mono">{info.reposDir}</dd>
      </dl>
      <Storage />
    </SettingsSection>
  );
}

/** Espacio en disco: caché por partes, con opción de vaciarla, y clones. */
function Storage() {
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.radar.app.storage().then((s) => !cancelled && setInfo(s));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!info) return null;
  const clear = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await window.radar.app.clearCache();
      setNotice(`Caché vaciada: ${formatBytes(r.bytes)} liberados. El siguiente análisis de cada proyecto será completo.`);
      setInfo(await window.radar.app.storage());
    } catch (err) {
      setNotice(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="storage">
      <h3>Espacio en disco</h3>
      <table className="table">
        <tbody>
          {info.cache.parts.map((p) => (
            <tr key={p.label}>
              <td>{p.label}</td>
              <td className="num">{formatBytes(p.bytes)}</td>
            </tr>
          ))}
          <tr>
            <td>Clones de GitHub</td>
            <td className="num">{formatBytes(info.clones.bytes)}</td>
          </tr>
        </tbody>
      </table>
      <p className="hint">
        La caché acelera los reanálisis y se limpia sola de lo que lleva 90 días sin usarse. Vaciarla no borra los proyectos ni el historial. El clon de un proyecto de
        GitHub se borra al quitarlo de la lista.
      </p>
      <div className="storage-actions">
        <button type="button" className="btn btn-small" onClick={() => void clear()} disabled={busy || info.cache.bytes === 0}>
          Vaciar la caché ({formatBytes(info.cache.bytes)})
        </button>
        {notice ? (
          <span className="small" role="status">
            {notice}
          </span>
        ) : null}
      </div>
    </div>
  );
}
