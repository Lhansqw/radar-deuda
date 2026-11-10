import { useEffect, useState } from 'react';
import type { AccountState } from '../../../shared/account.js';
import { errorMessage } from '../../../shared/errors.js';
import type { CloudSettings } from '../../../shared/settings.js';
import type { SyncState } from '../../../shared/sync.js';
import { Icon } from '../../components/Icon.js';
import { useAction } from '../../lib/action.js';
import { formatDateTime } from '../../lib/format.js';
import { CheckField, FormError, SettingsSection } from './SettingsSection.js';
import { tr } from '../../i18n.js';

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
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      id="s-cuenta"
      title={tr('Cuenta', 'Account')}
      intro={tr(
        'Los proyectos, el historial, los ajustes y las claves de esta pantalla son de tu cuenta: otra persona que inicie sesión en este equipo no los ve.',
        'The projects, history, settings and keys on this screen belong to your account: someone else who signs in on this computer does not see them.',
      )}
    >
      <dl className="about">
        <dt>{tr('Correo', 'Email')}</dt>
        <dd>{account.email}</dd>
        <dt>{tr('Sesión', 'Session')}</dt>
        <dd>
          {account.offline
            ? tr(
                'Sin conexión con Supabase: sigues trabajando con los datos de este equipo y la sesión se comprobará cuando vuelva la red.',
                'No connection to Supabase: you keep working with the data on this computer and the session will be checked when the network is back.',
              )
            : tr('Iniciada en este equipo.', 'Signed in on this computer.')}
        </dd>
      </dl>
      <CloudCopy cloud={cloud} onCloudChange={onCloudChange} onSettingsChanged={onSettingsChanged} />
      <div className="account-actions">
        <button type="button" className="btn" onClick={() => void signOut()} disabled={busy}>
          <Icon name="logout" size={16} /> {tr('Cerrar sesión', 'Sign out')}
        </button>
        <p className="hint">{tr('Si hay un análisis en curso, se detiene. Tus datos se quedan en este equipo para la próxima vez.', 'If an analysis is running, it stops. Your data stays on this computer for next time.')}</p>
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
  const parts = [
    p.projects > 0 ? tr(`${p.projects} proyecto(s)`, `${p.projects} project(s)`) : null,
    p.analyses > 0 ? tr(`${p.analyses} análisis`, `${p.analyses} analys${p.analyses === 1 ? 'is' : 'es'}`) : null,
    p.removals > 0 ? tr(`${p.removals} proyecto(s) quitado(s)`, `${p.removals} removed project(s)`) : null,
  ].filter(Boolean);
  return parts.length > 0 ? tr(` Pendiente de subir: ${parts.join(', ')}.`, ` Waiting to upload: ${parts.join(', ')}.`) : '';
}

function statusText(s: SyncState): string {
  switch (s.status) {
    case 'off':
      return tr('Desactivada: los proyectos y el historial solo están en este equipo.', 'Off: the projects and history are only on this computer.');
    case 'syncing':
      return tr('Sincronizando…', 'Syncing…');
    case 'offline':
      return tr('Sin conexión con Supabase: se sincronizará cuando vuelva la red.', 'No connection to Supabase: it will sync when the network is back.') + pendingText(s.pending);
    case 'error':
      return `${s.message ?? tr('No se pudo sincronizar.', 'Could not sync.')}${pendingText(s.pending)}`;
    default:
      return (
        (s.lastSyncAt
          ? tr(`Al día: última sincronización el ${formatDateTime(s.lastSyncAt)}.`, `Up to date: last sync on ${formatDateTime(s.lastSyncAt)}.`)
          : tr('Aún no se ha sincronizado.', 'Not synced yet.')) + pendingText(s.pending)
      );
  }
}

function CloudCopy({ cloud, onCloudChange, onSettingsChanged }: { cloud: CloudSettings; onCloudChange: (patch: Partial<CloudSettings>) => void; onSettingsChanged: () => void }) {
  const state = useSyncState();
  const [confirming, setConfirming] = useState(false);
  const { busy, error, run } = useAction();

  return (
    <div className="cloud-copy">
      <CheckField
        checked={cloud.sync}
        onChange={(sync) => onCloudChange({ sync })}
        label={tr('Guardar los proyectos y el historial en la nube', 'Save the projects and history in the cloud')}
        hint={tr(
          'Para verlos desde otro equipo con esta cuenta. Sube la lista de proyectos y los resultados de cada análisis, sin código: ni fragmentos, ni claves, ni lo que dice la IA, ni las conversaciones.',
          'To see them from another computer with this account. It uploads the project list and the results of each analysis, with no code: no snippets, no keys, nothing the AI says and no conversations.',
        )}
      />
      {state ? (
        <p className="cloud-status" data-status={state.status} role="status">
          {statusText(state)}
        </p>
      ) : null}
      <div className="cloud-actions">
        <button type="button" className="btn btn-small" disabled={busy || state?.status === 'off' || state?.status === 'syncing'} onClick={() => void run(() => window.radar.sync.now())}>
          {tr('Sincronizar ahora', 'Sync now')}
        </button>
        {confirming ? (
          <div className="confirm" role="group" aria-label={tr('Confirmar el borrado de la copia en la nube', 'Confirm deleting the cloud copy')}>
            <span>
              {tr(
                'Se borran de Supabase los proyectos y el historial de tu cuenta, y la copia se desactiva. En este equipo no se borra nada.',
                'The projects and history of your account are deleted from Supabase, and the copy is turned off. Nothing is deleted on this computer.',
              )}
            </span>
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
              {tr('Borrar la copia', 'Delete the copy')}
            </button>
            <button type="button" className="btn btn-small btn-quiet" onClick={() => setConfirming(false)}>
              {tr('Cancelar', 'Cancel')}
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn-small btn-quiet" disabled={busy} onClick={() => setConfirming(true)}>
            {tr('Borrar la copia en la nube', 'Delete the cloud copy')}
          </button>
        )}
      </div>
      <FormError error={error} />
    </div>
  );
}
