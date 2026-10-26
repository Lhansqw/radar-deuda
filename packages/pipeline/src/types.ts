/** Etapas de un análisis completo, para mostrar el progreso. */
export type PipelineEvent =
  | { phase: 'clone'; repo: string }
  | { phase: 'discovery' }
  | { phase: 'files'; done: number; total: number }
  | { phase: 'cross-file' }
  | { phase: 'project'; online: boolean }
  | { phase: 'history' }
  | { phase: 'ai'; done: number; total: number }
  | { phase: 'done' };

export interface PipelineHooks {
  info(message: string): void;
  warn(message: string): void;
  progress?(event: PipelineEvent): void;
}
