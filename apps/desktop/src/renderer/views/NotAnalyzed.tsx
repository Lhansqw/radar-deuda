import { useEffect, useState } from 'react';
import { PHASE_LABELS, type JobState } from '../../shared/jobs.js';
import type { ProjectKind } from '../../shared/model.js';
import { EmptyRadar } from '../components/EmptyRadar.js';
import { Icon } from '../components/Icon.js';
import { formatDuration, formatNumber } from '../lib/format.js';
import { scanSteps } from '../lib/scan.js';

/** Proyecto añadido que todavía no tiene ningún análisis. */
export function NotAnalyzed({ job, kind, onAnalyze }: { job: JobState | undefined; kind: ProjectKind; onAnalyze: () => void }) {
  if (job?.status === 'running') return <Scanning job={job} kind={kind} />;
  return (
    <div className="empty">
      <h2>Este proyecto aún no se ha analizado</h2>
      <p>El primer análisis lee todos los archivos; los siguientes reutilizan lo que no ha cambiado y tardan mucho menos.</p>
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={onAnalyze}>
          <Icon name="play" size={16} /> Analizar ahora
        </button>
      </div>
    </div>
  );
}

/** Hora actual, renovada cada segundo. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Primer análisis en curso: el radar barre y el borde se llena con el avance de la etapa. */
function Scanning({ job, kind }: { job: JobState; kind: ProjectKind }) {
  const now = useNow();
  const p = job.progress;
  const ratio = p && p.total > 0 ? p.done / p.total : null;
  const elapsed = Math.max(0, now - new Date(job.startedAt).getTime());
  const lastLog = job.log.at(-1);
  const unit = job.phase === 'ai' ? 'hallazgos' : 'archivos';

  return (
    <div className="welcome scan">
      <div
        role="progressbar"
        aria-label="Avance del análisis"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={ratio === null ? undefined : Math.round(ratio * 100)}
        aria-valuetext={p ? `${PHASE_LABELS[job.phase]}: ${p.done} de ${p.total}` : PHASE_LABELS[job.phase]}
      >
        <EmptyRadar scanning progress={ratio} />
      </div>
      <div className="welcome-copy">
        <h2>Analizando el proyecto</h2>
        <div className="scan-now">
          <p className="scan-phase" aria-live="polite">
            {PHASE_LABELS[job.phase]}
          </p>
          <p className="scan-count">
            {p ? (
              <span className="scan-figures">
                <span className="mono">{formatNumber(p.done)}</span> de <span className="mono">{formatNumber(p.total)}</span> {unit}
              </span>
            ) : null}
            <span>{elapsed < 60_000 ? `${Math.floor(elapsed / 1000)} s` : formatDuration(elapsed - (elapsed % 1000))}</span>
          </p>
        </div>
        <ol className="scan-steps">
          {scanSteps(kind, job.phase).map((s) => (
            <li key={s.phase} data-state={s.state} aria-current={s.state === 'current' ? 'step' : undefined}>
              <span className="scan-dot" aria-hidden="true">
                {s.state === 'done' ? <Icon name="check" size={12} /> : null}
              </span>
              {s.label}
              {s.state === 'done' ? <span className="visually-hidden"> (hecho)</span> : null}
            </li>
          ))}
        </ol>
        {lastLog ? <p className="scan-log">{lastLog.message}</p> : null}
        <p className="muted small">Los resultados aparecerán aquí en cuanto termine. Puedes seguir usando la aplicación mientras tanto.</p>
      </div>
    </div>
  );
}
