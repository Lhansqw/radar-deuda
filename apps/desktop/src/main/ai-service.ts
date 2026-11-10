import { compareReports, defaultCacheDir, repoReader, sha1, type AnalysisReport } from '@radar/engine';
import { fetchOpenRouterModels, IncludedAiProvider, OpenRouterProvider, type OpenRouterModel } from '@radar/ai';
import type { FetchLike } from '@radar/sources';
import { askStep, previewFix, proposeFixStep, runAiStep, type AiOptions, type ApiKeys } from '@radar/pipeline';
import { errorMessage } from '../shared/errors.js';
import type { CatalogModel, ChatMessage, FixPreviewInfo, IncludedQuota, OpenRouterKeyCheck, StoredFixProposal } from '../shared/model.js';
import type { AppSettings } from '../shared/settings.js';
import { mergeAiSection } from './ai-merge.js';
import type { CredentialStore } from './credentials.js';
import { aiKeysFrom, aiOptionsFrom, includedProblem, type IncludedAccess } from './jobs.js';
import type { Store } from './store.js';
import { currentLocale, tr } from './i18n.js';

export interface AiServiceDeps {
  store: Store;
  credentials: CredentialStore;
  settings: () => AppSettings;
  /** Para pruebas. */
  fetch?: FetchLike;
  cacheBase?: string | null;
  /** IA incluida: la función «ia» y el token de la sesión (null sin sesión). */
  includedAi?: () => IncludedAccess | null;
}

const CATALOG_TTL_MS = 10 * 60_000;

export class AiServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiServiceError';
  }
}

function toCatalogModel(m: OpenRouterModel): CatalogModel {
  const r = m.reasoning;
  return {
    id: m.id,
    name: m.name,
    free: m.free,
    inputPerMTok: m.price?.inputPerMTok ?? null,
    outputPerMTok: m.price?.outputPerMTok ?? null,
    contextLength: m.contextLength,
    structuredOutputs: m.structuredOutputs,
    reasoning: !r ? 'no' : !m.supportedParameters.includes('reasoning') ? 'no ajustable' : r.mandatory ? 'obligatorio' : 'desactivable',
  };
}

/** IA desde la aplicación: catálogo de modelos, comprobación de la clave y explicaciones bajo demanda. */
export class AiService {
  private catalog: { at: number; models: CatalogModel[] } | null = null;
  private readonly inFlight = new Map<string, Promise<AnalysisReport>>();
  private readonly fixesInFlight = new Map<string, Promise<StoredFixProposal>>();
  private readonly asking = new Set<number>();

  constructor(private readonly d: AiServiceDeps) {}

  /** Catálogo de OpenRouter (en caché unos minutos). No necesita clave. */
  async openRouterModels(): Promise<CatalogModel[]> {
    if (this.catalog && Date.now() - this.catalog.at < CATALOG_TTL_MS) return this.catalog.models;
    const key = this.d.credentials.get('openrouter');
    const list = await fetchOpenRouterModels({
      headers: { 'user-agent': 'radar-deuda', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      ...(this.d.fetch ? { fetch: this.d.fetch } : {}),
    }).catch((err: unknown) => {
      throw new AiServiceError(tr(`No se pudo obtener la lista de modelos de OpenRouter: ${errorMessage(err)}`, `Could not get the list of OpenRouter models: ${errorMessage(err)}`));
    });
    const models = list.map(toCatalogModel).sort((a, b) => (a.outputPerMTok ?? Infinity) - (b.outputPerMTok ?? Infinity) || a.id.localeCompare(b.id));
    this.catalog = { at: Date.now(), models };
    return models;
  }

  async checkOpenRouterKey(): Promise<OpenRouterKeyCheck> {
    const key = this.d.credentials.get('openrouter');
    if (!key) throw new AiServiceError(tr('No hay ninguna clave de OpenRouter guardada.', 'No OpenRouter key is saved.'));
    const provider = new OpenRouterProvider({ apiKey: key, ...(this.d.fetch ? { fetch: this.d.fetch } : {}) });
    return provider.keyStatus();
  }

  /** Consultas de IA incluida que quedan hoy a la cuenta. */
  async includedQuota(): Promise<IncludedQuota> {
    const included = this.d.includedAi?.() ?? null;
    if (!included) throw new AiServiceError(tr('Inicia sesión con conexión para ver tu cupo de IA incluida.', 'Sign in while online to see your included AI quota.'));
    const provider = new IncludedAiProvider({ baseUrl: included.url, sessionToken: included.token, ...(this.d.fetch ? { fetch: this.d.fetch } : {}) });
    const status = await provider.keyStatus();
    if (!status.freeDaily) throw new AiServiceError(tr('La función «ia» no devolvió el cupo.', 'The "ia" function did not return the quota.'));
    return status.freeDaily;
  }

  /** Explica un hallazgo con la IA configurada y guarda la explicación en el análisis. */
  explain(analysisId: number, findingId: string): Promise<AnalysisReport> {
    const k = `${analysisId}:${findingId}`;
    const running = this.inFlight.get(k);
    if (running) return running;
    const p = this.doExplain(analysisId, findingId).finally(() => this.inFlight.delete(k));
    this.inFlight.set(k, p);
    return p;
  }

  private get cacheBase(): string | null {
    return this.d.cacheBase === undefined ? defaultCacheDir() : this.d.cacheBase;
  }

  private report(analysisId: number, findingId?: string): AnalysisReport {
    const report = this.d.store.getReport(analysisId);
    if (!report) throw new AiServiceError(tr('Ese análisis ya no existe.', 'That analysis no longer exists.'));
    if (findingId !== undefined && !report.findings.some((f) => f.id === findingId)) throw new AiServiceError(tr('Ese hallazgo no está en el análisis.', 'That finding is not in the analysis.'));
    return report;
  }

  /** Ajustes de la IA, si permiten hacer una consulta. */
  private aiSettings(): AppSettings['ai'] {
    const s = this.d.settings().ai;
    if (s.provider === 'openrouter' && s.model === '') throw new AiServiceError(tr('Elige un modelo de OpenRouter en Configuración.', 'Choose an OpenRouter model in Settings.'));
    const problem = includedProblem(s, this.included());
    if (problem) throw new AiServiceError(problem);
    return s;
  }

  private included(): IncludedAccess | null {
    return this.d.includedAi?.() ?? null;
  }

  /** Opciones y claves de una consulta con los ajustes dados. */
  private request(s: AppSettings['ai']): { options: AiOptions; keys: ApiKeys } {
    const included = this.included();
    return { options: aiOptionsFrom(s, included, currentLocale()), keys: aiKeysFrom(this.d.credentials, s, included) };
  }

  private async doExplain(analysisId: number, findingId: string): Promise<AnalysisReport> {
    const report = this.report(analysisId, findingId);
    const req = this.request(this.aiSettings());
    const warnings: string[] = [];
    const cacheBase = this.cacheBase;
    const { section } = await runAiStep(
      report,
      { ...req.options, findingIds: [findingId] },
      req.keys,
      { info: () => undefined, warn: (m) => warnings.push(m) },
      new AbortController().signal,
      cacheBase,
    );
    if (section.explanations.length === 0) {
      throw new AiServiceError(section.errors[0]?.message ?? warnings[0] ?? tr('La IA no devolvió ninguna explicación.', 'The AI did not return any explanation.'));
    }
    report.ai = mergeAiSection(report.ai, section);
    this.d.store.updateReport(analysisId, report);
    return report;
  }

  // ── Propuestas de corrección ───────────────────────────────────────────

  /** Lo que se enviaría para proponer una corrección (sin enviar nada). */
  async fixPreview(analysisId: number, findingId: string): Promise<FixPreviewInfo> {
    const report = this.report(analysisId, findingId);
    const req = this.request(this.aiSettings());
    return previewFix(report, findingId, req.options, req.keys);
  }

  /** Pide una propuesta a la IA y la guarda (sustituye la anterior del mismo hallazgo). */
  proposeFix(analysisId: number, findingId: string, consent: boolean): Promise<StoredFixProposal> {
    const k = `${analysisId}:${findingId}`;
    const running = this.fixesInFlight.get(k);
    if (running) return running;
    const p = (async (): Promise<StoredFixProposal> => {
      const report = this.report(analysisId, findingId);
      // Si ya había una, se pide otra distinta: sin la caché de respuestas.
      const again = this.d.store.getFixProposal(analysisId, findingId) !== null;
      const req = this.request(this.aiSettings());
      const proposal = await proposeFixStep(report, findingId, req.options, req.keys, {
        consent,
        cacheBase: again ? null : this.cacheBase,
        signal: new AbortController().signal,
      });
      this.d.store.saveFixProposal(analysisId, proposal);
      return { proposal, stale: false };
    })().finally(() => this.fixesInFlight.delete(k));
    this.fixesInFlight.set(k, p);
    return p;
  }

  /** Propuesta guardada, indicando si los archivos cambiaron desde que se hizo. */
  async getFix(analysisId: number, findingId: string): Promise<StoredFixProposal | null> {
    const proposal = this.d.store.getFixProposal(analysisId, findingId);
    const report = this.d.store.getReport(analysisId);
    if (!proposal || !report) return null;
    const read = repoReader(report.root);
    let stale = false;
    for (const [file, hash] of Object.entries(proposal.baseHashes)) {
      const text = await read(file);
      if (text === null || sha1(text) !== hash) stale = true;
    }
    return { proposal, stale };
  }

  // ── Preguntas sobre el análisis ────────────────────────────────────────

  /** Pregunta sobre un análisis; guarda la pregunta y la respuesta solo si la IA responde. */
  async ask(analysisId: number, question: string): Promise<ChatMessage[]> {
    if (this.asking.has(analysisId)) throw new AiServiceError(tr('Espera a que termine la respuesta anterior.', 'Wait for the previous answer to finish.'));
    this.asking.add(analysisId);
    try {
      const report = this.report(analysisId);
      const req = this.request(this.aiSettings());
      const history = this.d.store.listChatMessages(analysisId).map((m) => ({ role: m.role, content: m.content }));
      const answer = await askStep(report, history, question, req.options, req.keys, {
        comparison: this.previousComparison(analysisId, report),
        signal: new AbortController().signal,
      });
      const user = this.d.store.addChatMessage(analysisId, { role: 'user', content: question.trim() });
      const reply = this.d.store.addChatMessage(analysisId, {
        role: 'assistant',
        content: answer.text,
        meta: { references: answer.references, unknownReferences: answer.unknownReferences, truncated: answer.truncated, model: answer.model, costUsd: answer.usage.costUsd },
      });
      return [user, reply];
    } finally {
      this.asking.delete(analysisId);
    }
  }

  /** Deuda nueva y resuelta respecto al análisis anterior del mismo proyecto, si lo hay. */
  private previousComparison(analysisId: number, report: AnalysisReport) {
    const summary = this.d.store.getAnalysis(analysisId);
    if (!summary) return null;
    const list = this.d.store.listAnalyses(summary.projectId);
    const previous = list[list.findIndex((a) => a.id === analysisId) + 1];
    const before = previous ? this.d.store.getReport(previous.id) : null;
    return before ? compareReports(before, report) : null;
  }
}
