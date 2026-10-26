import { Icon } from '../components/Icon.js';

/** Proyecto añadido que todavía no tiene ningún análisis. */
export function NotAnalyzed({ running, onAnalyze }: { running: boolean; onAnalyze: () => void }) {
  return (
    <div className="empty">
      <h2>{running ? 'Analizando el proyecto…' : 'Este proyecto aún no se ha analizado'}</h2>
      <p>
        {running
          ? 'Los resultados aparecerán aquí en cuanto termine. Puedes seguir usando la aplicación mientras tanto.'
          : 'El primer análisis lee todos los archivos; los siguientes reutilizan lo que no ha cambiado y tardan mucho menos.'}
      </p>
      {running ? null : (
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={onAnalyze}>
            <Icon name="play" size={16} /> Analizar ahora
          </button>
        </div>
      )}
    </div>
  );
}
