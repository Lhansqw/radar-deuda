/**
 * Datos que viajan entre el proceso principal y la interfaz. Son objetos
 * planos (se copian por IPC con el algoritmo de clonado estructurado).
 */
import type { AiFixProposal, Severity } from '@radar/engine';

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

/** Modelo del catálogo de OpenRouter, para elegirlo en la configuración. */
export interface CatalogModel {
  id: string;
  name: string;
  free: boolean;
  /** USD por millón de tokens; null si no se publica. */
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  contextLength: number | null;
  structuredOutputs: boolean;
  reasoning: 'no' | 'desactivable' | 'obligatorio' | 'no ajustable';
}

/** Lo que se enviaría para proponer una corrección (se muestra antes de enviarlo). */
export interface FixPreviewInfo {
  text: string;
  snippets: Array<{ file: string; startLine: number; endLine: number }>;
  provider: string;
  cloud: boolean;
  /** Hay que confirmar el envío (la privacidad configurada no permite enviar código). */
  needsConsent: boolean;
  /** OpenRouter puede enviarlo a proveedores que guardan o entrenan con los datos. */
  mayRetain: boolean;
}

/** Propuesta guardada y si los archivos cambiaron desde entonces (el parche puede no aplicarse). */
export interface StoredFixProposal {
  proposal: AiFixProposal;
  stale: boolean;
}

/** Datos de una respuesta de la IA en la conversación. */
export interface ChatMeta {
  references: Array<{ alias: string; findingId: string }>;
  unknownReferences: string[];
  truncated: boolean;
  model: string;
  costUsd: number | null;
}

export interface ChatMessage {
  id: number;
  analysisId: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  /** Solo en las respuestas de la IA. */
  meta: ChatMeta | null;
}

/** Estado de la clave de OpenRouter según el propio servicio. */
export interface OpenRouterKeyCheck {
  limitRemaining: number | null;
  usage: number | null;
  freeDaily: { used: number; limit: number; remaining: number } | null;
}
