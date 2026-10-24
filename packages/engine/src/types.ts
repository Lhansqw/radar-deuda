/**
 * Contrato de datos del motor. Todo lo que produce el motor es determinista y
 * verificable: la capa de IA (fase 7) añade anotaciones en un tipo aparte y
 * nunca modifica `evidence`.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Confidence = 'high' | 'medium' | 'low';
export type Category =
  | 'complexity'
  | 'size'
  | 'duplication'
  | 'security'
  | 'dependencies'
  | 'testing'
  | 'maintainability';

export type Language = 'typescript' | 'javascript' | 'other';

export const SEVERITY_ORDER: Readonly<Record<Severity, number>> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

/** Ubicación exacta. Rutas relativas a la raíz del repositorio, siempre con `/`. */
export interface Location {
  file: string;
  startLine: number;
  endLine: number;
  symbol?: string;
}

/** Evidencia obtenida por una herramienta. Nunca la genera un modelo de IA. */
export interface Evidence {
  kind: 'metric' | 'match' | 'clone' | 'fact';
  /** `analizador@versión` que la produjo. */
  tool: string;
  description: string;
  metric?: { name: string; value: number; threshold: number; unit?: string };
  /** Fragmento de código; se redacta si puede contener secretos. */
  snippet?: string;
}

export interface EffortEstimate {
  minutes: number;
  /** Fórmula o razonamiento usado, para que la estimación sea auditable. */
  rationale: string;
}

export interface Finding {
  /** Huella estable entre ejecuciones (regla + archivo + ancla). */
  id: string;
  ruleId: string;
  category: Category;
  severity: Severity;
  confidence: Confidence;
  title: string;
  message: string;
  /** La primera es la ubicación principal. */
  locations: Location[];
  evidence: Evidence[];
  impact: string;
  effort: EffortEstimate;
}

export interface Thresholds {
  cognitive: number;
  cyclomatic: number;
  functionLines: number;
  parameters: number;
  nesting: number;
  fileLines: number;
  duplicationMinTokens: number;
  duplicationMinLines: number;
  fanOut: number;
}

export interface AnalysisConfig {
  /** Patrones estilo .gitignore adicionales a excluir. */
  exclude: string[];
  respectGitignore: boolean;
  /** Por encima de este tamaño solo se mide (líneas), no se analiza en profundidad. */
  maxFileSizeBytes: number;
  /** Por encima de este tamaño el archivo se ignora por completo. */
  hardMaxFileSizeBytes: number;
  concurrency: number;
  thresholds: Thresholds;
}

/** Metadatos de un archivo descubierto (sin contenido). */
export interface FileMeta {
  absPath: string;
  relPath: string;
  size: number;
  mtimeMs: number;
  language: Language;
  isCode: boolean;
  isTest: boolean;
}

export type SkipReason = 'binary' | 'too-large' | 'unreadable' | 'minified';

export interface SkippedFile {
  relPath: string;
  reason: SkipReason;
}

/** Entrada que reciben los analizadores por archivo. */
export interface FileInput {
  meta: FileMeta;
  text: string;
  lines: string[];
  /**
   * Memoiza un valor derivado del archivo (p. ej. el AST) para que varios
   * analizadores lo compartan sin volver a calcularlo.
   */
  memo<T>(key: string, create: () => T): T;
}

export interface FileAnalysisResult<A = unknown> {
  findings: Finding[];
  artifact?: A;
}

export interface FileAnalyzer<A = unknown> {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  supports(meta: FileMeta): boolean;
  analyze(input: FileInput, config: AnalysisConfig): FileAnalysisResult<A>;
  /** Para análisis entre archivos (p. ej. duplicación). Recibe artefactos, cacheados o no. */
  finalize?(artifacts: ReadonlyMap<string, A>, config: AnalysisConfig, ctx: FinalizeContext): Finding[] | Promise<Finding[]>;
}

export interface FinalizeContext {
  /** Relee un archivo concreto (solo los implicados; nunca el repositorio entero). */
  readText(relPath: string): Promise<string | null>;
}

export interface ProjectContext {
  root: string;
  files: readonly FileMeta[];
  config: AnalysisConfig;
  readText(relPath: string): Promise<string | null>;
  /** Existencia de un archivo aunque no se haya descubierto (p. ej. lockfiles excluidos). */
  exists(relPath: string): Promise<boolean>;
}

export interface ProjectAnalyzer {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  analyzeProject(ctx: ProjectContext): Promise<Finding[]>;
}

export interface ProgressEvent {
  phase: 'discovery' | 'files' | 'cross-file' | 'project' | 'done';
  done: number;
  total: number;
  file?: string;
}

export interface CoverageNote {
  area: string;
  status: 'analyzed' | 'partial' | 'not-analyzed';
  detail: string;
}

export interface ScoreResult {
  /** 0–100, derivado linealmente del ratio de deuda (ver docs/METODOLOGIA.md). */
  score: number;
  rating: 'A' | 'B' | 'C' | 'D' | 'E';
  debtRatio: number;
  remediationMinutes: number;
  developmentMinutes: number;
  codeLines: number;
}

export interface RunStats {
  durationMs: number;
  filesDiscovered: number;
  filesAnalyzed: number;
  cacheHits: number;
  skipped: SkippedFile[];
  cpuUserMs: number;
  cpuSystemMs: number;
  peakRssMb: number;
}

export interface AnalysisReport {
  schemaVersion: 1;
  engineVersion: string;
  root: string;
  generatedAt: string;
  config: AnalysisConfig;
  score: ScoreResult;
  findings: Finding[];
  summary: {
    bySeverity: Record<Severity, number>;
    byCategory: Partial<Record<Category, number>>;
  };
  coverage: CoverageNote[];
  /** Fallos aislados de un analizador: no detienen el análisis, pero se declaran. */
  errors: AnalyzerError[];
  stats: RunStats;
}

export interface AnalyzerError {
  analyzer: string;
  file?: string;
  message: string;
}
