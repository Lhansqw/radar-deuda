/**
 * Datos que viajan entre el proceso principal y la interfaz. Son objetos
 * planos (se copian por IPC con el algoritmo de clonado estructurado).
 */
import type { Severity } from '@radar/engine';

export type ProjectKind = 'local' | 'github';

export interface Project {
  id: number;
  name: string;
  kind: ProjectKind;
  /** Carpeta absoluta (local) u owner/repo (GitHub). */
  location: string;
  /** Rama a analizar en GitHub (null: la principal). */
  branch: string | null;
  createdAt: string;
  lastAnalysis: AnalysisSummary | null;
}

/** Lo necesario para listar análisis y dibujar la evolución sin abrir el informe completo. */
export interface AnalysisSummary {
  id: number;
  projectId: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  score: number;
  rating: 'A' | 'B' | 'C' | 'D' | 'E';
  debtRatio: number;
  effortMinutes: number;
  findings: number;
  bySeverity: Record<Severity, number>;
  head: string | null;
  branch: string | null;
  withAi: boolean;
}

/** Líneas de un archivo del proyecto, para el detalle de un hallazgo. */
export interface CodeSnippet {
  file: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  lines: string[];
  /** Líneas en las que se ocultó un posible secreto. */
  redactedLines: number[];
  /** El archivo cambió después del análisis: las líneas pueden no coincidir. */
  changedSinceAnalysis: boolean;
}
