import { defaultCacheDir, type AnalysisReport } from '@radar/engine';
import { fetchOpenRouterModels, OpenRouterProvider, type OpenRouterModel } from '@radar/ai';
import type { FetchLike } from '@radar/sources';
import { runAiStep } from '@radar/pipeline';
import type { CatalogModel, OpenRouterKeyCheck } from '../shared/model.js';
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

  private async doExplain(analysisId: number, findingId: string): Promise<AnalysisReport> {
    const report = this.d.store.getReport(analysisId);
    if (!report) throw new AiServiceError('Ese análisis ya no existe.');
    if (!report.findings.some((f) => f.id === findingId)) throw new AiServiceError('Ese hallazgo no está en el análisis.');
    const s = this.d.settings().ai;
    if (s.provider === 'openrouter' && s.model === '') throw new AiServiceError('Elige un modelo de OpenRouter en Configuración.');
    const warnings: string[] = [];
    const cacheBase = this.d.cacheBase === undefined ? defaultCacheDir() : this.d.cacheBase;
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
}
