import { stat } from 'node:fs/promises';
import path from 'node:path';
import { compareReports, type AnalysisReport } from '@radar/engine';
import type { AppInfo, ArgsOf, Channel, ResultOf } from '../shared/ipc.js';
import { normalizeSettings, type AppSettings } from '../shared/settings.js';
import type { AiService } from './ai-service.js';
import type { CredentialStore } from './credentials.js';
import type { JobManager } from './jobs.js';
import { readSnippet, resolveReportFile } from './snippets.js';
import type { Store } from './store.js';

/** Lo que los manejadores necesitan del exterior; se inyecta para probarlos sin Electron. */
export interface HandlerDeps {
  store: Store;
  credentials: CredentialStore;
  jobs: Pick<JobManager, 'start' | 'cancel' | 'list'>;
  ai: Pick<AiService, 'explain' | 'openRouterModels' | 'checkOpenRouterKey' | 'fixPreview' | 'proposeFix' | 'getFix' | 'ask'>;
  info: () => AppInfo;
  /** Selector de carpetas del sistema. */
  chooseFolder: () => Promise<string | null>;
  openExternal: (url: string) => Promise<boolean>;
  /** Muestra un archivo en el explorador del sistema. */
  reveal: (absPath: string) => void;
  copyText: (text: string) => void;
  /** Diálogo para guardar un parche; devuelve la ruta elegida o null si se cancela. */
  savePatch: (defaultName: string, content: string) => Promise<string | null>;
}

export type Handlers = { [C in Channel]: (...args: ArgsOf<C>) => Promise<ResultOf<C>> | ResultOf<C> };

export const SETTINGS_KEY = 'settings';

export function loadSettings(store: Store): AppSettings {
  return normalizeSettings(store.getSetting(SETTINGS_KEY));
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

function report(d: HandlerDeps, analysisId: number): AnalysisReport {
  const r = d.store.getReport(analysisId);
  if (!r) throw new NotFoundError('Ese análisis ya no existe.');
  return r;
}

export function createHandlers(d: HandlerDeps): Handlers {
  return {
    'app:info': () => d.info(),
    'app:openExternal': (url) => d.openExternal(url),
    'app:copyText': (text) => {
      d.copyText(text);
      return null;
    },

    'projects:list': () => d.store.listProjects(),
    'projects:addFolder': async () => {
      const folder = await d.chooseFolder();
      if (!folder) return null;
      const abs = path.resolve(folder);
      const s = await stat(abs).catch(() => null);
      if (!s?.isDirectory()) throw new NotFoundError(`No existe la carpeta ${abs}.`);
      return d.store.addProject({ name: path.basename(abs) || abs, kind: 'local', location: abs });
    },
    'projects:addGithub': (repo, branch) => d.store.addProject({ name: repo.split('/')[1] ?? repo, kind: 'github', location: repo, branch }),
    'projects:remove': (id) => {
      d.store.removeProject(id);
      return null;
    },

    'analyses:list': (projectId) => d.store.listAnalyses(projectId),
    'analyses:report': (analysisId) => report(d, analysisId),
    'analyses:compare': (beforeId, afterId) => {
      const [a, b] = [d.store.getAnalysis(beforeId), d.store.getAnalysis(afterId)];
      if (!a || !b) throw new NotFoundError('Ese análisis ya no existe.');
      if (a.projectId !== b.projectId) throw new NotFoundError('Solo se pueden comparar análisis del mismo proyecto.');
      return compareReports(report(d, beforeId), report(d, afterId));
    },

    'settings:get': () => loadSettings(d.store),
    'settings:set': (settings) => {
      d.store.setSetting(SETTINGS_KEY, settings);
      return loadSettings(d.store);
    },

    'secrets:status': () => d.credentials.status(),
    'secrets:set': (name, value) => {
      d.credentials.set(name, value);
      return d.credentials.status();
    },
    'secrets:delete': (name) => {
      d.credentials.delete(name);
      return d.credentials.status();
    },

    'jobs:start': (projectId) => d.jobs.start(projectId),
    'jobs:cancel': (jobId) => {
      d.jobs.cancel(jobId);
      return null;
    },
    'jobs:list': () => d.jobs.list(),

    'files:snippet': (analysisId, file, start, end) => readSnippet(report(d, analysisId), file, start, end),
    'files:reveal': async (analysisId, file) => {
      d.reveal(await resolveReportFile(report(d, analysisId), file));
      return null;
    },

    'files:savePatch': async (analysisId, findingId) => {
      const proposal = d.store.getFixProposal(analysisId, findingId);
      if (!proposal || proposal.patch === '') throw new NotFoundError('No hay ningún parche que guardar.');
      const project = d.store.getProject(d.store.getAnalysis(analysisId)?.projectId ?? 0);
      const base = (project?.name ?? 'propuesta').replace(/[^\w.-]+/g, '-');
      return d.savePatch(`${base}-${findingId.slice(0, 8)}.patch`, proposal.patch);
    },

    'ai:explain': (analysisId, findingId) => d.ai.explain(analysisId, findingId),
    'ai:models': () => d.ai.openRouterModels(),
    'ai:checkKey': () => d.ai.checkOpenRouterKey(),
    'ai:fixPreview': (analysisId, findingId) => d.ai.fixPreview(analysisId, findingId),
    'ai:proposeFix': (analysisId, findingId, consent) => d.ai.proposeFix(analysisId, findingId, consent),
    'ai:getFix': (analysisId, findingId) => d.ai.getFix(analysisId, findingId),

    'chat:list': (analysisId) => d.store.listChatMessages(analysisId),
    'chat:ask': (analysisId, question) => d.ai.ask(analysisId, question),
    'chat:clear': (analysisId) => {
      d.store.clearChat(analysisId);
      return null;
    },
  };
}
