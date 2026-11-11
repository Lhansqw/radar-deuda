import { useEffect, useState } from 'react';
import { errorMessage } from '../../../shared/errors.js';
import type { AppInfo } from '../../../shared/ipc.js';
import type { StorageInfo } from '../../../shared/model.js';
import type { ThemeSetting, UpdateSettings } from '../../../shared/settings.js';
import { formatBytes } from '../../lib/format.js';
import { Diagnostics } from './Diagnostics.js';
import { CheckField, SettingsSection } from './SettingsSection.js';
import { tr } from '../../i18n.js';

/** Versiones, tema, actualizaciones, dónde guarda los datos, espacio en disco y diagnóstico. */
export function AppSection({ info, updates, onUpdatesChange }: { info: AppInfo; updates: UpdateSettings; onUpdatesChange: (patch: Partial<UpdateSettings>) => void }) {
  return (
    <SettingsSection id="s-acerca" title={tr('Aplicación', 'App')}>
      <dl className="about">
        <dt>{tr('Versión', 'Version')}</dt>
        <dd>{info.versions.app}</dd>
        <dt>{tr('Electron, Chromium y Node', 'Electron, Chromium and Node')}</dt>
        <dd>
          {info.versions.electron}, {info.versions.chrome} {tr('y', 'and')} {info.versions.node}
        </dd>
        <dt>{tr('Proyectos, historial y ajustes', 'Projects, history and settings')}</dt>
        <dd className="mono">{info.dataDir}</dd>
        <dt>{tr('Caché (compartida con la CLI)', 'Cache (shared with the CLI)')}</dt>
        <dd className="mono">{info.cacheDir}</dd>
        <dt>{tr('Clones de GitHub', 'GitHub clones')}</dt>
        <dd className="mono">{info.reposDir}</dd>
      </dl>
      <Appearance />
      <Updates updates={updates} onChange={onUpdatesChange} />
      <Storage />
      <Diagnostics />
    </SettingsSection>
  );
}

const themes = (): readonly { value: ThemeSetting; label: string }[] => [
  { value: 'dark', label: tr('Oscuro', 'Dark') },
  { value: 'light', label: tr('Claro', 'Light') },
  { value: 'system', label: tr('Como el sistema', 'Same as the system') },
];

/**
 * Tema de la interfaz. Se aplica al elegirlo, sin pasar por «Guardar»: es un
 * ajuste de este equipo, no de la cuenta.
 */
function Appearance() {
  const [theme, setTheme] = useState<ThemeSetting | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.radar.app.theme().then((t) => !cancelled && setTheme(t));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!theme) return null;
  const choose = async (next: ThemeSetting): Promise<void> => {
    setError(null);
    try {
      setTheme(await window.radar.app.setTheme(next));
    } catch (err) {
      setError(tr(`No se pudo cambiar el tema: ${errorMessage(err)}`, `Could not change the theme: ${errorMessage(err)}`));
    }
  };
  return (
    <div className="storage">
      <h3>{tr('Apariencia', 'Appearance')}</h3>
      <fieldset className="field">
        <legend className="label">{tr('Tema', 'Theme')}</legend>
        <div className="radios">
          {themes().map((t) => (
            <label key={t.value} className="check">
              <input type="radio" name="tema" checked={theme === t.value} onChange={() => void choose(t.value)} />
              <span>{t.label}</span>
            </label>
          ))}
        </div>
        <p className="hint">{tr('Se guarda en este equipo y también se usa en la pantalla de acceso.', 'It is saved on this computer and also used on the sign-in screen.')}</p>
      </fieldset>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
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
        setNotice(tr(`Hay una versión nueva: ${u.latest}.`, `A new version is available: ${u.latest}.`));
        setUrl(u.url);
      } else {
        setNotice(u.latest ? tr(`Tienes la última versión (${u.current}).`, `You have the latest version (${u.current}).`) : tr('Aún no hay versiones publicadas.', 'No versions published yet.'));
      }
    } catch (err) {
      setNotice(tr(`No se pudo comprobar: ${errorMessage(err)}`, `Could not check: ${errorMessage(err)}`));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="storage">
      <h3>{tr('Actualizaciones', 'Updates')}</h3>
      <CheckField
        checked={updates.check}
        onChange={(check) => onChange({ check })}
        label={tr('Avisar al abrir si hay una versión nueva', 'Notify on startup if there is a new version')}
        hint={tr(
          'Consulta en GitHub cuál es la última versión publicada, sin enviar ningún dato tuyo. No descarga nada: la versión nueva se instala encima de la anterior y conserva los datos.',
          'Checks GitHub for the latest published version, without sending any of your data. It downloads nothing: the new version installs over the old one and keeps the data.',
        )}
      />
      <div className="storage-actions">
        <button type="button" className="btn btn-small" onClick={() => void check()} disabled={busy}>
          {tr('Buscar ahora', 'Check now')}
        </button>
        {url ? (
          <button type="button" className="btn btn-small" onClick={() => void window.radar.app.openExternal(url)}>
            {tr('Descargar', 'Download')}
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
      setNotice(
        tr(
          `Caché vaciada: ${formatBytes(r.bytes)} liberados. El siguiente análisis de cada proyecto será completo.`,
          `Cache cleared: ${formatBytes(r.bytes)} freed. The next analysis of each project will be a full one.`,
        ),
      );
      setInfo(await window.radar.app.storage());
    } catch (err) {
      setNotice(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="storage">
      <h3>{tr('Espacio en disco', 'Disk space')}</h3>
      <table className="table">
        <tbody>
          {info.cache.parts.map((p) => (
            <tr key={p.label}>
              <td>{p.label}</td>
              <td className="num">{formatBytes(p.bytes)}</td>
            </tr>
          ))}
          <tr>
            <td>{tr('Clones de GitHub', 'GitHub clones')}</td>
            <td className="num">{formatBytes(info.clones.bytes)}</td>
          </tr>
        </tbody>
      </table>
      <p className="hint">
        {tr(
          'La caché acelera los reanálisis y se limpia sola de lo que lleva 90 días sin usarse. Vaciarla no borra los proyectos ni el historial. El clon de un proyecto de GitHub se borra al quitarlo de la lista.',
          'The cache speeds up re-analyses and cleans itself of anything unused for 90 days. Clearing it does not delete projects or history. The clone of a GitHub project is deleted when you remove it from the list.',
        )}
      </p>
      <div className="storage-actions">
        <button type="button" className="btn btn-small" onClick={() => void clear()} disabled={busy || info.cache.bytes === 0}>
          {tr('Vaciar la caché', 'Clear the cache')} ({formatBytes(info.cache.bytes)})
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
