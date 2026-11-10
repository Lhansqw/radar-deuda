import type { JobPhase } from '../../shared/jobs.js';
import { phaseLabel } from './labels.js';
import type { ProjectKind } from '../../shared/model.js';

export type StepState = 'done' | 'current' | 'pending';

export interface ScanStep {
  phase: JobPhase;
  label: string;
  state: StepState;
}

/** Orden de las etapas, el mismo de `JobPhase`. */
const ORDER: readonly JobPhase[] = ['starting', 'clone', 'discovery', 'files', 'cross-file', 'project', 'history', 'saving', 'ai'];

/**
 * Etapas que se enseñan mientras se analiza: la descarga solo en proyectos de
 * GitHub y la IA solo cuando ya está en marcha (no se sabe antes si se pedirá).
 */
export function scanSteps(kind: ProjectKind, phase: JobPhase): ScanStep[] {
  const current = phase === 'finished' ? ORDER.length : ORDER.indexOf(phase);
  return ORDER.flatMap((p, i): ScanStep[] => {
    if (p === 'clone' && kind !== 'github') return [];
    if (p === 'ai' && phase !== 'ai') return [];
    const state: StepState = i < current ? 'done' : i === current ? 'current' : 'pending';
    return [{ phase: p, label: phaseLabel(p), state }];
  });
}
