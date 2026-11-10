import type { JobState } from '../../shared/jobs.js';
import { phaseLabel } from '../lib/labels.js';
import { formatDuration } from '../lib/format.js';
import { Icon } from './Icon.js';
import { tr } from '../i18n.js';

/** Progreso de un análisis en curso o resultado del último, bajo la cabecera del proyecto. */
export function JobStatus({ job, onDismiss }: { job: JobState; onDismiss: () => void }) {
  if (job.status === 'running') {
    const p = job.progress;
    const pct = p && p.total > 0 ? Math.round((p.done / p.total) * 100) : null;
    const lastLog = job.log.at(-1);
    return (
      <section className="job" aria-live="polite" aria-label={tr('Análisis en curso', 'Analysis in progress')}>
        <div className="job-line">
          <span className="phase">{phaseLabel(job.phase)}</span>
          {p ? (
            <span className="detail">
              {p.done} {tr('de', 'of')} {p.total}
            </span>
          ) : null}
          {lastLog ? <span className="detail">{lastLog.message}</span> : null}
        </div>
        <div className="progress" data-indeterminate={pct === null} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
          <span style={pct === null ? undefined : { width: `${pct}%` }} />
        </div>
      </section>
    );
  }

  const duration = job.finishedAt ? new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime() : 0;
  const warnings = job.log.filter((l) => l.level === 'warn');
  if (job.status === 'done' && !job.aiError && warnings.length === 0) {
    return (
      <div className="notice" data-tone="ok" role="status">
        <Icon name="check" size={16} />
        <p className="title">{tr(`Análisis terminado en ${formatDuration(duration)}.`, `Analysis finished in ${formatDuration(duration)}.`)}</p>
        <button type="button" className="btn btn-quiet btn-small" onClick={onDismiss} aria-label={tr('Cerrar aviso', 'Close notice')}>
          <Icon name="close" size={14} />
        </button>
      </div>
    );
  }
  const tone = job.status === 'failed' ? 'error' : 'warn';
  const title =
    job.status === 'failed'
      ? tr('El análisis no se pudo completar.', 'The analysis could not be completed.')
      : job.status === 'cancelled'
        ? tr('Análisis cancelado.', 'Analysis cancelled.')
        : tr(`Análisis terminado en ${formatDuration(duration)}, con avisos.`, `Analysis finished in ${formatDuration(duration)}, with warnings.`);
  return (
    <div className="notice" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name="alert" size={16} />
      <div>
        <p className="title">{title}</p>
        {job.error && job.status === 'failed' ? <p>{job.error}</p> : null}
        {job.aiError ? <p>{tr(`La IA no se pudo ejecutar: ${job.aiError}`, `The AI could not run: ${job.aiError}`)}</p> : null}
        {warnings.slice(-3).map((w) => (
          <p key={w.at + w.message}>{w.message}</p>
        ))}
      </div>
      <button type="button" className="btn btn-quiet btn-small" onClick={onDismiss} aria-label={tr('Cerrar aviso', 'Close notice')}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
