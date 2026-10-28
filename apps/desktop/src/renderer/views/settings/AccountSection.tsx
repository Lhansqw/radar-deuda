import { useEffect, useState } from 'react';
import type { AccountState } from '../../../shared/account.js';
import type { CloudSettings } from '../../../shared/settings.js';
import type { SyncState } from '../../../shared/sync.js';
import { Icon } from '../../components/Icon.js';
import { formatDateTime } from '../../lib/format.js';
import { CheckField, errorText, FormError, SettingsSection } from './SettingsSection.js';

/** La cuenta con la sesión iniciada, su copia en la nube y el botón para cerrar la sesión. */
export function AccountSection({
  account,
  cloud,
  onCloudChange,
  onSettingsChanged,
}: {
  account: Extract<AccountState, { status: 'signed-in' }>;
  cloud: CloudSettings;
  onCloudChange: (patch: Partial<CloudSettings>) => void;
  /** El proceso principal cambió los ajustes (al borrar la copia en la nube se desactiva). */
  onSettingsChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signOut = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      // El proceso principal avisa del cierre y la interfaz vuelve al acceso (Root.tsx).
      await window.radar.account.signOut();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <SettingsSection id="s-cuenta" title="Cuenta" intro="Los proyectos, el historial, los ajustes y las claves de esta pantalla son de tu cuenta: otra persona que inicie sesión en este equipo no los ve.">
      <dl className="about">
        <dt>Correo</dt>
        <dd>{account.email}</dd>
        <dt>Sesión</dt>
        <dd>{account.offline ? 'Sin conexión con Supabase: sigues trabajando con los datos de este equipo y la sesión se comprobará cuando vuelva la red.' : 'Iniciada en este equipo.'}</dd>
      </dl>
      <CloudCopy cloud={cloud} onCloudChange={onCloudChange} onSettingsChanged={onSettingsChanged} />
      <div className="account-actions">
        <button type="button" className="btn" onClick={() => void signOut()} disabled={busy}>
          <Icon name="logout" size={16} /> Cerrar sesión
        </button>
        <p className="hint">Si hay un análisis en curso, se detiene. Tus datos se quedan en este equipo para la próxima vez.</p>
      </div>
      <FormError error={error} />
    </SettingsSection>
  );
}

/** Estado de la copia en la nube, al día con los avisos del proceso principal. */
function useSyncState(): SyncState | null {
  const [state, setState] = useState<SyncState | null>(null);
  useEffect(() => {
    void window.radar.sync.state().then(setState);
    return window.radar.sync.onChange(setState);
  }, []);
  return state;
}

function pendingText(p: SyncState['pending']): string {
  const parts = [p.projects > 0 ? `${p.projects} proyecto(s)` : null, p.analyses > 0 ? `${p.analyses} análisis` : null, p.removals > 0 ? `${p.removals} proyecto(s) quitado(s)` : null].filter(Boolean);
  return parts.length > 0 ? ` Pendiente de subir: ${parts.join(', ')}.` : '';
}

function statusText(s: SyncState): string {
  switch (s.status) {
    case 'off':
      return 'Desactivada: los proyectos y el historial solo están en este equipo.';
    case 'syncing':
      return 'Sincronizando…';
    case 'offline':
      return `Sin conexión con Supabase: se sincronizará cuando vuelva la red.${pendingText(s.pending)}`;
    case 'error':
      return `${s.message ?? 'No se pudo sincronizar.'}${pendingText(s.pending)}`;
    default:
      return `${s.lastSyncAt ? `Al día: última sincronización el ${formatDateTime(s.lastSyncAt)}.` : 'Aún no se ha sincronizado.'}${pendingText(s.pending)}`;
  }
}

function CloudCopy({ cloud, onCloudChange, onSettingsChanged }: { cloud: CloudSettings; onCloudChange: (patch: Partial<CloudSettings>) => void; onSettingsChanged: () => void }) {
  const state = useSyncState();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cloud-copy">
      <CheckField
        checked={cloud.sync}
        onChange={(sync) => onCloudChange({ sync })}
        label="Guardar los proyectos y el historial en la nube"
        hint="Para verlos desde otro equipo con esta cuenta. Sube la lista de proyectos y los resultados de cada análisis, sin código: ni fragmentos, ni claves, ni lo que dice la IA, ni las conversaciones."
      />
      {state ? (
        <p className="cloud-status" data-status={state.status} role="status">
          {statusText(state)}
        </p>
      ) : null}
      <div className="cloud-actions">
        <button type="button" className="btn btn-small" disabled={busy || state?.status === 'off' || state?.status === 'syncing'} onClick={() => void run(() => window.radar.sync.now())}>
          Sincronizar ahora
        </button>
        {confirming ? (
          <div className="confirm" role="group" aria-label="Confirmar el borrado de la copia en la nube">
            <span>Se borran de Supabase los proyectos y el historial de tu cuenta, y la copia se desactiva. En este equipo no se borra nada.</span>
            <button
              type="button"
              className="btn btn-small btn-danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setConfirming(false);
                  try {
                    await window.radar.sync.deleteCloud();
                  } finally {
                    // Se desactiva aunque el borrado falle: los ajustes cambiaron en el proceso principal.
                    onSettingsChanged();
                  }
                })
              }
            >
              Borrar la copia
            </button>
            <button type="button" className="btn btn-small btn-quiet" onClick={() => setConfirming(false)}>
              Cancelar
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn-small btn-quiet" disabled={busy} onClick={() => setConfirming(true)}>
            Borrar la copia en la nube
          </button>
        )}
      </div>
      <FormError error={error} />
    </div>
  );
}
