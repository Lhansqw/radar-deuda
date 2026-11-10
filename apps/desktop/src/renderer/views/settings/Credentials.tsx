import { useState } from 'react';
import { errorMessage } from '../../../shared/errors.js';
import type { OpenRouterKeyCheck } from '../../../shared/model.js';
import { SECRET_LABELS, SECRET_LABELS_EN, SECRET_NAMES, type SecretName, type SecretsStatus } from '../../../shared/secrets.js';
import { Icon } from '../../components/Icon.js';
import { FormError, SettingsSection } from './SettingsSection.js';
import { tr } from '../../i18n.js';

const KEY_PAGES: Record<SecretName, string> = {
  openrouter: 'https://openrouter.ai/settings/keys',
  anthropic: 'https://platform.claude.com/',
  openai: 'https://platform.openai.com/api-keys',
  github: 'https://github.com/settings/personal-access-tokens/new',
};

const ENV_NAMES: Record<SecretName, string> = {
  openrouter: 'RADAR_OPENROUTER_API_KEY',
  anthropic: 'RADAR_ANTHROPIC_API_KEY',
  openai: 'RADAR_OPENAI_API_KEY',
  github: 'RADAR_GITHUB_TOKEN',
};

/** Claves de los proveedores y token de GitHub. La interfaz nunca recibe su valor. */
export function Credentials({ status, onChange }: { status: SecretsStatus | null; onChange: (s: SecretsStatus) => void }) {
  return (
    <SettingsSection
      id="s-claves"
      title={tr('Credenciales', 'Credentials')}
      intro={tr(
        'Se guardan cifradas con el sistema (DPAPI en Windows, el Llavero en macOS, el llavero del escritorio en Linux) y nunca vuelven a mostrarse. También se aceptan las variables de entorno de la línea de comandos.',
        'They are stored encrypted by the system (DPAPI on Windows, the Keychain on macOS, the desktop keyring on Linux) and are never shown again. The command-line environment variables are also accepted.',
      )}
    >
      {status && !status.encryptionAvailable ? (
        <p className="form-error">
          {tr(
            'Este equipo no ofrece un almacén cifrado (en Linux, instala o desbloquea un llavero como GNOME Keyring o KWallet): no se pueden guardar credenciales. Usa las variables de entorno indicadas.',
            'This computer has no encrypted store (on Linux, install or unlock a keyring such as GNOME Keyring or KWallet): credentials cannot be saved. Use the environment variables shown.',
          )}
        </p>
      ) : null}
      {status ? SECRET_NAMES.map((name) => <SecretRow key={name} name={name} status={status} onChange={onChange} />) : null}
    </SettingsSection>
  );
}

type KeyCheck = { result: OpenRouterKeyCheck | null; error: string | null };

/** Guardar, borrar y comprobar una credencial. */
function useSecret(name: SecretName, onChange: (s: SecretsStatus) => void) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<KeyCheck | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(fn: () => Promise<SecretsStatus>): Promise<void> {
    setBusy(true);
    setError(null);
    setCheck(null);
    try {
      onChange(await fn());
      setValue('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function verify(): Promise<void> {
    setBusy(true);
    setCheck(null);
    try {
      setCheck({ result: await window.radar.ai.checkKey(), error: null });
    } catch (err) {
      setCheck({ result: null, error: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return {
    value,
    setValue,
    error,
    check,
    busy,
    save: () => act(() => window.radar.secrets.set(name, value)),
    remove: () => act(() => window.radar.secrets.delete(name)),
    verify,
  };
}

function SecretRow({ name, status, onChange }: { name: SecretName; status: SecretsStatus; onChange: (s: SecretsStatus) => void }) {
  const secret = useSecret(name, onChange);
  const s = status.secrets[name];
  const configured = s.stored || s.fromEnv;
  const state = s.stored ? tr('Guardada y cifrada', 'Saved and encrypted') : s.fromEnv ? tr(`Desde la variable ${ENV_NAMES[name]}`, `From the ${ENV_NAMES[name]} variable`) : tr('Sin configurar', 'Not set');
  const label = tr(SECRET_LABELS[name], SECRET_LABELS_EN[name]);

  return (
    <div className="secret">
      <div className="secret-head">
        <span className="label">{label}</span>
        <span className="secret-state" data-set={configured || undefined}>
          {configured ? <Icon name="check" size={14} /> : null}
          {state}
        </span>
        <button type="button" className="btn btn-quiet btn-small secret-link" onClick={() => void window.radar.app.openExternal(KEY_PAGES[name])}>
          <Icon name="external" size={14} /> {name === 'github' ? tr('Crear un token', 'Create a token') : tr('Crear una clave', 'Create a key')}
        </button>
      </div>
      <form
        className="secret-form"
        onSubmit={(e) => {
          e.preventDefault();
          void secret.save();
        }}
      >
        <input
          className="input mono"
          type="password"
          value={secret.value}
          onChange={(e) => secret.setValue(e.target.value)}
          placeholder={s.stored ? tr('Pega una nueva para sustituirla', 'Paste a new one to replace it') : tr('Pega aquí la clave', 'Paste the key here')}
          autoComplete="off"
          spellCheck={false}
          aria-label={label}
          disabled={!status.encryptionAvailable}
        />
        <button type="submit" className="btn" disabled={secret.busy || secret.value.trim() === ''}>
          {tr('Guardar', 'Save')}
        </button>
        {s.stored ? (
          <button type="button" className="btn btn-quiet" disabled={secret.busy} onClick={() => void secret.remove()}>
            {tr('Borrar', 'Delete')}
          </button>
        ) : null}
        {name === 'openrouter' && configured ? (
          <button type="button" className="btn btn-quiet" disabled={secret.busy} onClick={() => void secret.verify()}>
            {tr('Comprobar', 'Check')}
          </button>
        ) : null}
      </form>
      <FormError error={secret.error} />
      <FormError error={secret.check?.error} />
      {secret.check?.result ? <KeyCheckResult result={secret.check.result} /> : null}
    </div>
  );
}

/** Lo que dice OpenRouter de la clave: peticiones gratuitas de hoy y crédito. */
function KeyCheckResult({ result }: { result: OpenRouterKeyCheck }) {
  return (
    <p className="secret-ok" role="status">
      <Icon name="check" size={14} /> {tr('OpenRouter acepta la clave.', 'OpenRouter accepts the key.')}
      {result.freeDaily
        ? tr(` Peticiones gratuitas hoy: ${result.freeDaily.remaining} de ${result.freeDaily.limit}.`, ` Free requests today: ${result.freeDaily.remaining} of ${result.freeDaily.limit}.`)
        : ''}
      {result.limitRemaining !== null
        ? tr(` Crédito restante de la clave: ${result.limitRemaining.toFixed(2)} USD.`, ` Remaining key credit: ${result.limitRemaining.toFixed(2)} USD.`)
        : tr(' La clave no tiene límite de crédito.', ' The key has no credit limit.')}
    </p>
  );
}
