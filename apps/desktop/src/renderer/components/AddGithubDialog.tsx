import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Project } from '../../shared/model.js';

/** Alta de un repositorio de GitHub (público, o privado con un token configurado). */
export function AddGithubDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (p: Project) => void }) {
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onAdded(await window.radar.projects.addGithub(repo.trim(), branch.trim() === '' ? null : branch.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="titulo-github" onSubmit={(e) => void submit(e)}>
        <h2 id="titulo-github">Añadir un repositorio de GitHub</h2>
        <div className="field">
          <label htmlFor="repo">Repositorio</label>
          <input id="repo" ref={input} className="input" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo o https://github.com/owner/repo" autoComplete="off" spellCheck={false} required />
          <span className="hint">Se descarga una copia en la carpeta de la aplicación. Para repositorios privados, guarda antes un token de GitHub en Configuración.</span>
        </div>
        <div className="field">
          <label htmlFor="rama">Rama (opcional)</label>
          <input id="rama" className="input" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="La principal" autoComplete="off" spellCheck={false} />
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="buttons">
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || repo.trim() === ''}>
            Añadir repositorio
          </button>
        </div>
      </form>
    </div>
  );
}
