import { Icon } from '../components/Icon.js';
import { EmptyRadar } from '../components/EmptyRadar.js';

/** Primera apertura: sin proyectos todavía. */
export function Welcome({ onAddFolder, onAddGithub }: { onAddFolder: () => void; onAddGithub: () => void }) {
  return (
    <div className="welcome">
      <EmptyRadar />
      <div className="welcome-copy">
        <h2>Añade tu primer proyecto</h2>
        <p>
          Elige una carpeta con código o un repositorio de GitHub. Cada hallazgo aparecerá en el radar, en el sector de su categoría: cuanto más cerca del
          centro, más urgente.
        </p>
        <p className="muted small">El análisis solo lee archivos: no ejecuta nada del proyecto. La IA es opcional y, por defecto, no envía código.</p>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={onAddFolder}>
            <Icon name="folder" size={16} /> Añadir carpeta
          </button>
          <button type="button" className="btn" onClick={onAddGithub}>
            <Icon name="github" size={16} /> Añadir de GitHub
          </button>
        </div>
      </div>
    </div>
  );
}
