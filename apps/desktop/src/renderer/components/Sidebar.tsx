import type { AccountState } from '../../shared/account.js';
import type { JobState } from '../../shared/jobs.js';
import type { Project } from '../../shared/model.js';
import { BrandMark, Icon, type IconName } from './Icon.js';

export type View = 'panel' | 'hallazgos' | 'archivos' | 'historial' | 'preguntar' | 'ajustes';

const PROJECT_VIEWS: Array<{ view: Exclude<View, 'ajustes'>; label: string; icon: IconName }> = [
  { view: 'panel', label: 'Panel', icon: 'panel' },
  { view: 'hallazgos', label: 'Hallazgos', icon: 'list' },
  { view: 'archivos', label: 'Archivos', icon: 'tree' },
  { view: 'historial', label: 'Historial', icon: 'history' },
  { view: 'preguntar', label: 'Preguntar', icon: 'chat' },
];

interface Props {
  projects: Project[];
  selectedId: number | null;
  view: View;
  jobs: Record<number, JobState>;
  /** Vistas del proyecto disponibles en esta versión de la interfaz. */
  views: ReadonlyArray<Exclude<View, 'ajustes'>>;
  counts: Partial<Record<View, number>>;
  onSelect: (id: number) => void;
  onView: (view: View) => void;
  onAddFolder: () => void;
  onAddGithub: () => void;
  /** Cuenta con la sesión iniciada. */
  account?: Extract<AccountState, { status: 'signed-in' }>;
  settingsAvailable: boolean;
}

export function Sidebar(p: Props) {
  return (
    <nav className="sidebar" aria-label="Proyectos y secciones">
      <div className="brand">
        <BrandMark />
        Radar de deuda
      </div>
      <div className="sidebar-scroll">
        <h2 className="sidebar-heading" id="proyectos">
          Proyectos
        </h2>
        <ul className="project-list" aria-labelledby="proyectos">
          {p.projects.map((project) => {
            const running = p.jobs[project.id]?.status === 'running';
            const last = project.lastAnalysis;
            return (
              <li key={project.id}>
                <button type="button" className="project-item" aria-current={project.id === p.selectedId} onClick={() => p.onSelect(project.id)} title={project.location}>
                  <span className="kind">
                    <Icon name={project.kind === 'github' ? 'github' : 'folder'} size={16} />
                  </span>
                  <span className="name">{project.name}</span>
                  {running ? (
                    <span className="rating-empty">analizando…</span>
                  ) : last ? (
                    <span className="rating" data-rating={last.rating} title={`Puntuación ${last.score}/100`}>
                      {last.rating}
                    </span>
                  ) : (
                    <span className="rating-empty">sin analizar</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="sidebar-actions">
          <button type="button" className="btn btn-quiet btn-small btn-block" onClick={p.onAddFolder}>
            <Icon name="plus" size={16} /> Añadir carpeta
          </button>
          <button type="button" className="btn btn-quiet btn-small btn-block" onClick={p.onAddGithub}>
            <Icon name="github" size={16} /> Añadir de GitHub
          </button>
        </div>

        {p.selectedId !== null ? (
          <>
            <h2 className="sidebar-heading">Proyecto</h2>
            <ul className="nav">
              {PROJECT_VIEWS.filter((v) => p.views.includes(v.view)).map((v) => (
                <li key={v.view}>
                  <button type="button" className="nav-item" aria-current={p.view === v.view ? 'page' : undefined} onClick={() => p.onView(v.view)}>
                    <Icon name={v.icon} size={16} />
                    {v.label}
                    {p.counts[v.view] !== undefined ? <span className="count">{p.counts[v.view]}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
      {p.settingsAvailable ? (
        <div className="sidebar-footer">
          {p.account ? (
            <p className="sidebar-account" title={p.account.email}>
              <Icon name="user" size={14} />
              <span className="email">{p.account.email}</span>
              {p.account.offline ? <span className="tag">sin conexión</span> : null}
            </p>
          ) : null}
          <button type="button" className="nav-item" aria-current={p.view === 'ajustes' ? 'page' : undefined} onClick={() => p.onView('ajustes')}>
            <Icon name="settings" size={16} /> Configuración
          </button>
        </div>
      ) : null}
    </nav>
  );
}
