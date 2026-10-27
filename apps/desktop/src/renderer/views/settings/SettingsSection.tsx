import type { ReactNode } from 'react';

/** Una sección de la configuración: explicación a la izquierda, campos a la derecha. */
export function SettingsSection({ id, title, intro, children }: { id: string; title: string; intro?: string; children: ReactNode }) {
  return (
    <section className="settings-section" aria-labelledby={id}>
      <div className="settings-intro">
        <h2 id={id}>{title}</h2>
        {intro ? <p>{intro}</p> : null}
      </div>
      <div className="settings-fields">{children}</div>
    </section>
  );
}

/** Casilla con su explicación debajo. */
export function CheckField({
  checked,
  disabled,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint ? <span className="hint">{hint}</span> : null}
      </span>
    </label>
  );
}

/** Mensaje de error de una acción, anunciado a los lectores de pantalla. */
export function FormError({ error }: { error: string | null | undefined }) {
  return error ? (
    <p className="form-error" role="alert">
      {error}
    </p>
  ) : null;
}

export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
