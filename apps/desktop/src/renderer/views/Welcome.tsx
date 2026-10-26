import { Icon } from '../components/Icon.js';

/** Primera apertura: sin proyectos todavía. */
export function Welcome({ onAddFolder, onAddGithub }: { onAddFolder: () => void; onAddGithub: () => void }) {
  return (
    <div className="empty">
      <h2>Añade tu primer proyecto</h2>
      <p>
        Elige una carpeta con código o un repositorio de GitHub. El análisis encuentra funciones difíciles de mantener, código duplicado, dependencias
        circulares, secretos en el código y problemas en las dependencias, y estima cuánto cuesta corregirlo.
      </p>
      <p>El análisis solo lee archivos: no ejecuta nada del proyecto. La IA es opcional y, por defecto, no envía código.</p>
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={onAddFolder}>
          <Icon name="folder" size={16} /> Añadir carpeta
        </button>
        <button type="button" className="btn" onClick={onAddGithub}>
          <Icon name="github" size={16} /> Añadir de GitHub
        </button>
      </div>
    </div>
  );
}
