/**
 * Contrato de comunicación entre la interfaz y el proceso principal. Cada
 * canal declara sus argumentos y su resultado; el proceso principal valida
 * los argumentos en tiempo de ejecución (main/ipc-validation.ts) porque la
 * interfaz se trata como no confiable.
 */
import type { AnalysisReport, ReportComparison } from '@radar/engine';
import type { JobState } from './jobs.js';
import type { AnalysisSummary, CatalogModel, CodeSnippet, OpenRouterKeyCheck, Project } from './model.js';
import type { SecretName, SecretsStatus } from './secrets.js';
import type { AppSettings } from './settings.js';

export interface AppInfo {
  versions: { app: string; electron: string; chrome: string; node: string };
  /** Carpeta de datos de la aplicación: proyectos, historial, ajustes y credenciales cifradas. */
  dataDir: string;
  /** Caché del análisis, de la IA y de las consultas en línea (compartida con la CLI). */
  cacheDir: string;
  /** Clones de los repositorios de GitHub. */
  reposDir: string;
}

export interface IpcContract {
  'app:info': { args: []; result: AppInfo };
  'app:openExternal': { args: [url: string]; result: boolean };
  'projects:list': { args: []; result: Project[] };
  /** Abre el selector de carpetas del sistema; null si se cancela. */
  'projects:addFolder': { args: []; result: Project | null };
  'projects:addGithub': { args: [repo: string, branch: string | null]; result: Project };
  'projects:remove': { args: [projectId: number]; result: null };
  'analyses:list': { args: [projectId: number]; result: AnalysisSummary[] };
  'analyses:report': { args: [analysisId: number]; result: AnalysisReport };
  /** Deuda nueva, resuelta y con otra severidad entre dos análisis del mismo proyecto. */
  'analyses:compare': { args: [beforeId: number, afterId: number]; result: ReportComparison };
  'settings:get': { args: []; result: AppSettings };
  'settings:set': { args: [settings: AppSettings]; result: AppSettings };
  'secrets:status': { args: []; result: SecretsStatus };
  'secrets:set': { args: [name: SecretName, value: string]; result: SecretsStatus };
  'secrets:delete': { args: [name: SecretName]; result: SecretsStatus };
  /** Inicia un análisis del proyecto con los ajustes actuales. */
  'jobs:start': { args: [projectId: number]; result: JobState };
  'jobs:cancel': { args: [jobId: string]; result: null };
  /** El análisis en curso (si hay) y los recientes. */
  'jobs:list': { args: []; result: JobState[] };
  /** Líneas de un archivo citado por un hallazgo del análisis (con los secretos ocultos). */
  'files:snippet': { args: [analysisId: number, file: string, startLine: number, endLine: number]; result: CodeSnippet };
  /** Muestra el archivo en el explorador de archivos del sistema (sin abrirlo ni ejecutarlo). */
  'files:reveal': { args: [analysisId: number, file: string]; result: null };
  /** Explica un hallazgo con la IA configurada; devuelve el informe con la explicación añadida. */
  'ai:explain': { args: [analysisId: number, findingId: string]; result: AnalysisReport };
  /** Catálogo de modelos de OpenRouter. */
  'ai:models': { args: []; result: CatalogModel[] };
  /** Comprueba la clave de OpenRouter guardada (validez, crédito y cuota gratuita). */
  'ai:checkKey': { args: []; result: OpenRouterKeyCheck };
}

/** Canal de avisos del proceso principal a la interfaz (estado de los análisis). */
export const JOB_EVENT_CHANNEL = 'jobs:event';

export type Channel = keyof IpcContract;
export type ArgsOf<C extends Channel> = IpcContract[C]['args'];
export type ResultOf<C extends Channel> = IpcContract[C]['result'];

export const CHANNELS = [
  'app:info',
  'app:openExternal',
  'projects:list',
  'projects:addFolder',
  'projects:addGithub',
  'projects:remove',
  'analyses:list',
  'analyses:report',
  'analyses:compare',
  'settings:get',
  'settings:set',
  'secrets:status',
  'secrets:set',
  'secrets:delete',
  'jobs:start',
  'jobs:cancel',
  'jobs:list',
  'files:snippet',
  'files:reveal',
  'ai:explain',
  'ai:models',
  'ai:checkKey',
] as const satisfies readonly Channel[];

/**
 * Respuesta de cada canal. Los errores viajan como texto para que la
 * interfaz muestre el mensaje tal cual (Electron añadiría "Error invoking
 * remote method…" a una excepción).
 */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string };
