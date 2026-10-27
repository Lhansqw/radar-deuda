import { useState } from 'react';
import type { OpenRouterKeyCheck } from '../../../shared/model.js';
import { SECRET_LABELS, SECRET_NAMES, type SecretName, type SecretsStatus } from '../../../shared/secrets.js';
import { Icon } from '../../components/Icon.js';
import { errorText, FormError, SettingsSection } from './SettingsSection.js';

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
      title="Credenciales"
      intro="Se guardan cifradas con el sistema (en Windows, DPAPI) y nunca vuelven a mostrarse. También se aceptan las variables de entorno de la línea de comandos."
    >
      {status && !status.encryptionAvailable ? (
        <p className="form-error">Este equipo no ofrece un almacén cifrado: no se pueden guardar credenciales. Usa las variables de entorno indicadas.</p>
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
      setError(errorText(err));
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
      setCheck({ result: null, error: errorText(err) });
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
  const state = s.stored ? 'Guardada y cifrada' : s.fromEnv ? `Desde la variable ${ENV_NAMES[name]}` : 'Sin configurar';

  return (
    <div className="secret">
      <div className="secret-head">
        <span className="label">{SECRET_LABELS[name]}</span>
        <span className="secret-state" data-set={configured || undefined}>
          {configured ? <Icon name="check" size={14} /> : null}
          {state}
        </span>
        <button type="button" className="btn btn-quiet btn-small secret-link" onClick={() => void window.radar.app.openExternal(KEY_PAGES[name])}>
          <Icon name="external" size={14} /> {name === 'github' ? 'Crear un token' : 'Crear una clave'}
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
          placeholder={s.stored ? 'Pega una nueva para sustituirla' : 'Pega aquí la clave'}
          autoComplete="off"
          spellCheck={false}
          aria-label={SECRET_LABELS[name]}
          disabled={!status.encryptionAvailable}
        />
        <button type="submit" className="btn" disabled={secret.busy || secret.value.trim() === ''}>
          Guardar
        </button>
        {s.stored ? (
          <button type="button" className="btn btn-quiet" disabled={secret.busy} onClick={() => void secret.remove()}>
            Borrar
          </button>
        ) : null}
        {name === 'openrouter' && configured ? (
          <button type="button" className="btn btn-quiet" disabled={secret.busy} onClick={() => void secret.verify()}>
            Comprobar
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
      <Icon name="check" size={14} /> OpenRouter acepta la clave.
      {result.freeDaily ? ` Peticiones gratuitas hoy: ${result.freeDaily.remaining} de ${result.freeDaily.limit}.` : ''}
      {result.limitRemaining !== null ? ` Crédito restante de la clave: ${result.limitRemaining.toFixed(2)} USD.` : ' La clave no tiene límite de crédito.'}
    </p>
  );
}
