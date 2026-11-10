import { Icon } from '../components/Icon.js';
import { EmptyRadar } from '../components/EmptyRadar.js';
import { tr } from '../i18n.js';

/** Primera apertura: sin proyectos todavía. */
export function Welcome({ onAddFolder, onAddGithub }: { onAddFolder: () => void; onAddGithub: () => void }) {
  return (
    <div className="welcome">
      <EmptyRadar />
      <div className="welcome-copy">
        <h2>{tr('Añade tu primer proyecto', 'Add your first project')}</h2>
        <p>
          {tr(
            'Elige una carpeta con código o un repositorio de GitHub. Cada hallazgo aparecerá en el radar, en el sector de su categoría: cuanto más cerca del centro, más urgente.',
            'Choose a folder with code or a GitHub repository. Each finding will appear on the radar, in the sector of its category: the closer to the center, the more urgent.',
          )}
        </p>
        <p className="muted small">
          {tr(
            'El análisis solo lee archivos: no ejecuta nada del proyecto. La IA es opcional y, por defecto, no envía código.',
            'The analysis only reads files: it does not run anything from the project. AI is optional and, by default, sends no code.',
          )}
        </p>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={onAddFolder}>
            <Icon name="folder" size={16} /> {tr('Añadir carpeta', 'Add folder')}
          </button>
          <button type="button" className="btn" onClick={onAddGithub}>
            <Icon name="github" size={16} /> {tr('Añadir de GitHub', 'Add from GitHub')}
          </button>
        </div>
      </div>
    </div>
  );
}
