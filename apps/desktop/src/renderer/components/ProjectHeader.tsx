import { useState } from 'react';
import type { JobState } from '../../shared/jobs.js';
import type { Project } from '../../shared/model.js';
import { formatRelative } from '../lib/format.js';
import { Icon } from './Icon.js';

interface Props {
  project: Project;
  job: JobState | undefined;
  onAnalyze: () => void;
  onCancel: (jobId: string) => void;
  onRemove: () => void;
}

export function ProjectHeader({ project, job, onAnalyze, onCancel, onRemove }: Props) {
  const [confirming, setConfirming] = useState(false);
  const running = job?.status === 'running';
  const last = project.lastAnalysis;
  return (
    <header className="project-header">
      <div>
        <h1>{project.name}</h1>
        <div className="project-meta">
          <span className="mono" title={project.kind === 'github' ? 'Repositorio de GitHub' : 'Carpeta local'}>
            {project.kind === 'github' ? `github.com/${project.location}${project.branch ? ` (rama ${project.branch})` : ''}` : project.location}
          </span>
          {last ? (
            <span>
              Analizado {formatRelative(last.finishedAt)}
              {last.head ? ` en el commit ${last.head.slice(0, 7)}` : ''}
            </span>
          ) : (
            <span>Aún sin analizar</span>
          )}
        </div>
      </div>
      <div className="header-actions">
        {confirming ? (
          <>
            <span className="form-hint">¿Quitar de la lista? Se borra su historial; los archivos no se tocan.</span>
            <button type="button" className="btn btn-small btn-danger" onClick={onRemove}>
              Quitar
            </button>
            <button type="button" className="btn btn-small btn-quiet" onClick={() => setConfirming(false)}>
              Cancelar
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-quiet btn-small" onClick={() => setConfirming(true)} disabled={running}>
              <Icon name="trash" size={16} /> Quitar
            </button>
            {running ? (
              <button type="button" className="btn" onClick={() => onCancel(job.jobId)}>
                <Icon name="stop" size={16} /> Cancelar análisis
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={onAnalyze}>
                <Icon name="play" size={16} /> Analizar
              </button>
            )}
          </>
        )}
      </div>
    </header>
  );
}
