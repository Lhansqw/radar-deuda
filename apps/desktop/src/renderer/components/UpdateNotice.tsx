import { useEffect, useState } from 'react';
import type { UpdateInfo } from '../../shared/model.js';
import { Icon } from './Icon.js';

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
        <p className="title">Hay una versión nueva: {update.latest}</p>
        <p>Tienes la {update.current}. Descarga el instalador e instálalo encima: conservas tus proyectos, el historial y los ajustes.</p>
        <p>
          <button type="button" className="btn btn-small" onClick={() => void window.radar.app.openExternal(url)}>
            Descargar la versión {update.latest}
          </button>
        </p>
      </div>
      <button type="button" className="btn btn-quiet btn-small" onClick={() => setUpdate(null)} aria-label="Cerrar aviso">
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
