import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Project } from '../../shared/model.js';
import { useAction } from '../lib/action.js';
import { tr } from '../i18n.js';

/** Alta de un repositorio de GitHub (público, o privado con un token configurado). */
export function AddGithubDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (p: Project) => void }) {
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('');
  const { busy, error, run } = useAction();
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
    await run(async () => onAdded(await window.radar.projects.addGithub(repo.trim(), branch.trim() === '' ? null : branch.trim())));
  }

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="titulo-github" onSubmit={(e) => void submit(e)}>
        <h2 id="titulo-github">{tr('Añadir un repositorio de GitHub', 'Add a GitHub repository')}</h2>
        <div className="field">
          <label htmlFor="repo">{tr('Repositorio', 'Repository')}</label>
          <input id="repo" ref={input} className="input" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder={tr('owner/repo o https://github.com/owner/repo', 'owner/repo or https://github.com/owner/repo')} autoComplete="off" spellCheck={false} required />
          <span className="hint">
            {tr(
              'Se descarga una copia en la carpeta de la aplicación. Para repositorios privados, guarda antes un token de GitHub en Configuración.',
              "A copy is downloaded into the app's folder. For private repositories, first save a GitHub token in Settings.",
            )}
          </span>
        </div>
        <div className="field">
          <label htmlFor="rama">{tr('Rama (opcional)', 'Branch (optional)')}</label>
          <input id="rama" className="input" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={tr('La principal', 'The default one')} autoComplete="off" spellCheck={false} />
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="buttons">
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            {tr('Cancelar', 'Cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || repo.trim() === ''}>
            {tr('Añadir repositorio', 'Add repository')}
          </button>
        </div>
      </form>
    </div>
  );
}
