/** Estado de un análisis en curso o recién terminado, tal como lo ve la interfaz. */

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled';

/** Etapas, en el orden en que suelen ocurrir. */
export type JobPhase = 'starting' | 'clone' | 'discovery' | 'files' | 'cross-file' | 'project' | 'history' | 'saving' | 'ai' | 'finished';

export interface JobLogEntry {
  level: 'info' | 'warn';
  message: string;
  at: string;
}

export interface JobState {
  jobId: string;
  projectId: number;
  status: JobStatus;
  phase: JobPhase;
  /** Avance de la etapa actual, si se puede medir (archivos, consultas de IA). */
  progress: { done: number; total: number } | null;
  startedAt: string;
  finishedAt: string | null;
  /** Análisis guardado (existe en cuanto termina el motor, aunque la IA siga trabajando). */
  analysisId: number | null;
  /** Avisos e información de la ejecución (los más recientes). */
  log: JobLogEntry[];
  error: string | null;
  /** La IA falló o no se pudo ejecutar; el análisis del motor sí se guardó. */
  aiError: string | null;
}

