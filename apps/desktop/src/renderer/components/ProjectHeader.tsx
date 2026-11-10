import { useState } from 'react';
import type { JobState } from '../../shared/jobs.js';
import type { Project } from '../../shared/model.js';
import { formatRelative } from '../lib/format.js';
import { Icon } from './Icon.js';
import { tr } from '../i18n.js';

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
          <span className="mono" title={project.kind === 'github' ? tr('Repositorio de GitHub', 'GitHub repository') : tr('Carpeta local', 'Local folder')}>
            {project.kind === 'github' ? `github.com/${project.location}${project.branch ? ` (${tr('rama', 'branch')} ${project.branch})` : ''}` : project.location}
          </span>
          {last ? (
            <span>
              {tr('Analizado', 'Analyzed')} {formatRelative(last.finishedAt)}
              {last.head ? tr(` en el commit ${last.head.slice(0, 7)}`, ` at commit ${last.head.slice(0, 7)}`) : ''}
            </span>
          ) : (
            <span>{tr('Aún sin analizar', 'Not analyzed yet')}</span>
          )}
        </div>
      </div>
      <div className="header-actions">
        {confirming ? (
          <>
            <span className="form-hint">{tr('¿Quitar de la lista? Se borra su historial; los archivos no se tocan.', 'Remove from the list? Its history is deleted; the files are not touched.')}</span>
            <button type="button" className="btn btn-small btn-danger" onClick={onRemove}>
              {tr('Quitar', 'Remove')}
            </button>
            <button type="button" className="btn btn-small btn-quiet" onClick={() => setConfirming(false)}>
              {tr('Cancelar', 'Cancel')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-quiet btn-small" onClick={() => setConfirming(true)} disabled={running}>
              <Icon name="trash" size={16} /> {tr('Quitar', 'Remove')}
            </button>
            {running ? (
              <button type="button" className="btn" onClick={() => onCancel(job.jobId)}>
                <Icon name="stop" size={16} /> {tr('Cancelar análisis', 'Cancel analysis')}
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={onAnalyze}>
                <Icon name="play" size={16} /> {tr('Analizar', 'Analyze')}
              </button>
            )}
          </>
        )}
      </div>
    </header>
  );
}
