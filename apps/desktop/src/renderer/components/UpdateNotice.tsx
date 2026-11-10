import { useEffect, useState } from 'react';
import type { UpdateInfo } from '../../shared/model.js';
import { Icon } from './Icon.js';
import { tr } from '../i18n.js';

/**
 * Al abrir la aplicación, si el ajuste lo permite, avisa de que hay una versión
 * nueva en GitHub Releases. Solo enlaza a su página: no descarga nada. Un fallo
 * de red no se muestra (se puede comprobar a mano en Configuración).
 */
export function UpdateNotice() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await window.radar.settings.get();
        if (!settings.updates.check) return;
        const u = await window.radar.app.checkUpdate();
        if (!cancelled && u.newer) setUpdate(u);
      } catch {
        /* sin conexión o GitHub no responde: no es un error para el usuario */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!update?.url) return null;
  const url = update.url;
  return (
    <div className="notice" data-tone="ok" role="status">
      <Icon name="sparkle" size={16} />
      <div>
        <p className="title">{tr(`Hay una versión nueva: ${update.latest}`, `A new version is available: ${update.latest}`)}</p>
        <p>
          {tr(
            `Tienes la ${update.current}. Descarga el instalador e instálalo encima: conservas tus proyectos, el historial y los ajustes.`,
            `You have ${update.current}. Download the installer and install it on top: you keep your projects, history and settings.`,
          )}
        </p>
        <p>
          <button type="button" className="btn btn-small" onClick={() => void window.radar.app.openExternal(url)}>
            {tr(`Descargar la versión ${update.latest}`, `Download version ${update.latest}`)}
          </button>
        </p>
      </div>
      <button type="button" className="btn btn-quiet btn-small" onClick={() => setUpdate(null)} aria-label={tr('Cerrar aviso', 'Close notice')}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
