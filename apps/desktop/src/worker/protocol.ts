/**
 * Mensajes entre el proceso principal y el proceso de análisis
 * (utilityProcess). Se copian con el algoritmo de clonado estructurado.
 */
import type { AiSection, AnalysisReport } from '@radar/engine';
import type { AiOptions, ApiKeys, PipelineEvent, PipelineRequest } from '@radar/pipeline';

export interface StartMessage {
  type: 'start';
  /** Análisis sin IA: la IA va aparte para que su fallo no impida guardar el análisis. */
  request: Omit<PipelineRequest, 'ai' | 'keys'>;
  ai?: { options: AiOptions; keys: ApiKeys };
}

export type ToWorker = StartMessage | { type: 'cancel' };

export type FromWorker =
  | { type: 'event'; event: PipelineEvent }
  | { type: 'log'; level: 'info' | 'warn'; message: string }
  /** El motor terminó: el proceso principal ya puede guardar el análisis. */
  | { type: 'report'; report: AnalysisReport; durationMs: number }
  /** Resultado de la IA, si se pidió. */
  | { type: 'ai'; section: AiSection; label: string }
  | { type: 'ai-error'; message: string }
  | { type: 'error'; message: string; cancelled: boolean }
  /** Todo terminó (con o sin IA). */
  | { type: 'finished' };
