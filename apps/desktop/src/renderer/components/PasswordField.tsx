import { useId, useState } from 'react';
import { Icon } from './Icon.js';

/** Campo de contraseña con botón para mostrarla mientras se escribe. */
export function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  hint,
  autoFocus = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: 'current-password' | 'new-password';
  hint?: string;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="password">
        <input
          id={id}
          className="input"
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          spellCheck={false}
          autoFocus={autoFocus}
          required
          {...(hint ? { 'aria-describedby': `${id}-ayuda` } : {})}
        />
        <button type="button" className="btn btn-quiet btn-small" onClick={() => setVisible((v) => !v)} aria-label={visible ? 'Ocultar la contraseña' : 'Mostrar la contraseña'} aria-pressed={visible}>
          <Icon name={visible ? 'eyeOff' : 'eye'} size={16} />
        </button>
      </div>
      {hint ? (
        <span className="hint" id={`${id}-ayuda`}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}
