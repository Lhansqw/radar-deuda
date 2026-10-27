import { useState } from 'react';
import type { AccountState } from '../../../shared/account.js';
import { Icon } from '../../components/Icon.js';
import { errorText, FormError, SettingsSection } from './SettingsSection.js';

/** La cuenta con la sesión iniciada y el botón para cerrarla. */
export function AccountSection({ account }: { account: Extract<AccountState, { status: 'signed-in' }> }) {
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
