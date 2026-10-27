import { readFile } from 'node:fs/promises';
import { compareReports, defaultCacheDir, safeJoin, sha1, type AnalysisReport } from '@radar/engine';
import { fetchOpenRouterModels, OpenRouterProvider, type OpenRouterModel } from '@radar/ai';
import type { FetchLike } from '@radar/sources';
import { askStep, previewFix, proposeFixStep, runAiStep } from '@radar/pipeline';
import type { CatalogModel, ChatMessage, FixPreviewInfo, OpenRouterKeyCheck, StoredFixProposal } from '../shared/model.js';
import type { AppSettings } from '../shared/settings.js';
import { mergeAiSection } from './ai-merge.js';
import type { CredentialStore } from './credentials.js';
import { aiOptionsFrom } from './jobs.js';
import type { Store } from './store.js';

export interface AiServiceDeps {
  store: Store;
  credentials: CredentialStore;
  settings: () => AppSettings;
  /** Para pruebas. */
  fetch?: FetchLike;
  cacheBase?: string | null;
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
      throw new AiServiceError(`No se pudo obtener la lista de modelos de OpenRouter: ${err instanceof Error ? err.message : String(err)}`);
    });
    const models = list.map(toCatalogModel).sort((a, b) => (a.outputPerMTok ?? Infinity) - (b.outputPerMTok ?? Infinity) || a.id.localeCompare(b.id));
    this.catalog = { at: Date.now(), models };
    return models;
  }

  async checkOpenRouterKey(): Promise<OpenRouterKeyCheck> {
    const key = this.d.credentials.get('openrouter');
    if (!key) throw new AiServiceError('No hay ninguna clave de OpenRouter guardada.');
    const provider = new OpenRouterProvider({ apiKey: key, ...(this.d.fetch ? { fetch: this.d.fetch } : {}) });
    return provider.keyStatus();
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
    if (!report) throw new AiServiceError('Ese análisis ya no existe.');
    if (findingId !== undefined && !report.findings.some((f) => f.id === findingId)) throw new AiServiceError('Ese hallazgo no está en el análisis.');
    return report;
  }

  /** Ajustes de la IA, si permiten hacer una consulta. */
  private aiSettings(): AppSettings['ai'] {
    const s = this.d.settings().ai;
    if (s.provider === 'openrouter' && s.model === '') throw new AiServiceError('Elige un modelo de OpenRouter en Configuración.');
    return s;
  }

  private async doExplain(analysisId: number, findingId: string): Promise<AnalysisReport> {
    const report = this.report(analysisId, findingId);
    const s = this.aiSettings();
    const warnings: string[] = [];
    const cacheBase = this.cacheBase;
    const { section } = await runAiStep(
      report,
      { ...aiOptionsFrom(s), findingIds: [findingId] },
      this.d.credentials.apiKeys(),
      { info: () => undefined, warn: (m) => warnings.push(m) },
      new AbortController().signal,
      cacheBase,
    );
    if (section.explanations.length === 0) {
      throw new AiServiceError(section.errors[0]?.message ?? warnings[0] ?? 'La IA no devolvió ninguna explicación.');
    }
    report.ai = mergeAiSection(report.ai, section);
    this.d.store.updateReport(analysisId, report);
    return report;
  }

  // ── Propuestas de corrección ───────────────────────────────────────────

  /** Lo que se enviaría para proponer una corrección (sin enviar nada). */
  async fixPreview(analysisId: number, findingId: string): Promise<FixPreviewInfo> {
    const report = this.report(analysisId, findingId);
    return previewFix(report, findingId, aiOptionsFrom(this.aiSettings()), this.d.credentials.apiKeys());
  }

  /** Pide una propuesta a la IA y la guarda (sustituye la anterior del mismo hallazgo). */
  proposeFix(analysisId: number, findingId: string, consent: boolean): Promise<StoredFixProposal> {
    const k = `${analysisId}:${findingId}`;
    const running = this.fixesInFlight.get(k);
    if (running) return running;
    const p = (async (): Promise<StoredFixProposal> => {
      const report = this.report(analysisId, findingId);
      const proposal = await proposeFixStep(report, findingId, aiOptionsFrom(this.aiSettings()), this.d.credentials.apiKeys(), {
        consent,
        cacheBase: this.cacheBase,
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
    let stale = false;
    for (const [file, hash] of Object.entries(proposal.baseHashes)) {
      const abs = safeJoin(report.root, file);
      const text = abs ? await readFile(abs, 'utf8').catch(() => null) : null;
      if (text === null || sha1(text) !== hash) stale = true;
    }
    return { proposal, stale };
  }

  // ── Preguntas sobre el análisis ────────────────────────────────────────

  /** Pregunta sobre un análisis; guarda la pregunta y la respuesta solo si la IA responde. */
  async ask(analysisId: number, question: string): Promise<ChatMessage[]> {
    if (this.asking.has(analysisId)) throw new AiServiceError('Espera a que termine la respuesta anterior.');
    this.asking.add(analysisId);
    try {
      const report = this.report(analysisId);
      const s = this.aiSettings();
      const history = this.d.store.listChatMessages(analysisId).map((m) => ({ role: m.role, content: m.content }));
      const answer = await askStep(report, history, question, aiOptionsFrom(s), this.d.credentials.apiKeys(), {
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
