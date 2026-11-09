import { useEffect, useState } from 'react';
import { errorMessage } from '../../../shared/errors.js';
import type { AppInfo } from '../../../shared/ipc.js';
import type { StorageInfo } from '../../../shared/model.js';
import type { UpdateSettings } from '../../../shared/settings.js';
import { formatBytes } from '../../lib/format.js';
import { CheckField, SettingsSection } from './SettingsSection.js';

/** Versiones, actualizaciones, dónde guarda los datos y espacio en disco. */
export function AppSection({ info, updates, onUpdatesChange }: { info: AppInfo; updates: UpdateSettings; onUpdatesChange: (patch: Partial<UpdateSettings>) => void }) {
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
      <Updates updates={updates} onChange={onUpdatesChange} />
      <Storage />
    </SettingsSection>
  );
}

/** Aviso de versiones nuevas: automático al abrir (si está activado) o a mano. */
function Updates({ updates, onChange }: { updates: UpdateSettings; onChange: (patch: Partial<UpdateSettings>) => void }) {
  const [notice, setNotice] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async (): Promise<void> => {
    setBusy(true);
    setUrl(null);
    try {
      const u = await window.radar.app.checkUpdate();
      if (u.newer && u.url) {
        setNotice(`Hay una versión nueva: ${u.latest}.`);
        setUrl(u.url);
      } else {
        setNotice(u.latest ? `Tienes la última versión (${u.current}).` : 'Aún no hay versiones publicadas.');
      }
    } catch (err) {
      setNotice(`No se pudo comprobar: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="storage">
      <h3>Actualizaciones</h3>
      <CheckField
        checked={updates.check}
        onChange={(check) => onChange({ check })}
        label="Avisar al abrir si hay una versión nueva"
        hint="Consulta en GitHub cuál es la última versión publicada, sin enviar ningún dato tuyo. No descarga nada: la versión nueva se instala encima de la anterior y conserva los datos."
      />
      <div className="storage-actions">
        <button type="button" className="btn btn-small" onClick={() => void check()} disabled={busy}>
          Buscar ahora
        </button>
        {url ? (
          <button type="button" className="btn btn-small" onClick={() => void window.radar.app.openExternal(url)}>
            Descargar
          </button>
        ) : null}
        {notice ? (
          <span className="small" role="status">
            {notice}
          </span>
        ) : null}
      </div>
    </div>
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
      setNotice(errorMessage(err));
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
