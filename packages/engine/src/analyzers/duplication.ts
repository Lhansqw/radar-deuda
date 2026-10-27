import type { AnalysisConfig, FileAnalyzer, FinalizeStore, Finding, Location } from '../types.js';
import { findingId } from '../util.js';
import { findCandidates, refineCandidates, type Region } from './duplication-pairs.js';
import { fingerprintSource, K, W, type DuplicationArtifact } from './duplication-tokens.js';
import { isJsLike } from './shared.js';
import { loadTypeScript } from './ts-runtime.js';

export { findCandidates, refineCandidates, type Candidate, type RefineOptions, type Region } from './duplication-pairs.js';
export { fingerprintSource, forEachToken, K, tokenSequence, W, type DuplicationArtifact, type Fingerprint } from './duplication-tokens.js';

/**
 * Detección de código duplicado (clones de tipo 1: idénticos salvo espacios y
 * comentarios) mediante k-gramas de tokens y *winnowing* (Schleimer et al., 2003).
 *
 * - Cada archivo se tokeniza con el escáner de TypeScript (ignora comentarios).
 * - Se calculan hashes rodantes de K tokens y se conserva el mínimo de cada
 *   ventana de W hashes. Garantía: toda coincidencia de ≥ K + W − 1 tokens se detecta.
 * - Las huellas (pocas por archivo) son cacheables por archivo.
 * - La verificación de cada par de archivos se guarda con una clave derivada
 *   del contenido de ambos y de sus candidatos: en un reanálisis solo se
 *   retokenizan los pares en los que algo cambió.
 */
const ID = 'duplication';
const VERSION = '1.3.0';
const TOOL = `${ID}@${VERSION}`;

/** Agrupa pares en clases de clones (union-find sobre regiones idénticas). */
export function groupClones(pairs: ReadonlyArray<[Region, Region]>, config: AnalysisConfig): Region[][] {
  const { duplicationMinTokens, duplicationMinLines } = config.thresholds;
  const keyOf = (r: Region): string => `${r.file}:${r.startLine}-${r.endLine}`;
  const parent = new Map<string, string>();
  const regions = new Map<string, Region>();
  const find = (x: string): string => {
    let root = x;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root) as string;
    parent.set(x, root);
    return root;
  };
  for (const [a, b] of pairs) {
    const lines = Math.min(a.endLine - a.startLine, b.endLine - b.startLine) + 1;
    if (a.tokens < duplicationMinTokens || lines < duplicationMinLines) continue;
    const ka = keyOf(a);
    const kb = keyOf(b);
    regions.set(ka, a);
    regions.set(kb, b);
    const ra = find(ka);
    const rb = find(kb);
    if (ra !== rb) parent.set(ra, rb);
  }
  const classes = new Map<string, Region[]>();
  for (const [k, r] of regions) {
    const root = find(k);
    let c = classes.get(root);
    if (!c) classes.set(root, (c = []));
    c.push(r);
  }
  return [...classes.values()].map((c) => c.sort((x, y) => x.file.localeCompare(y.file) || x.startLine - y.startLine));
}

export async function findClones(
  artifacts: ReadonlyMap<string, DuplicationArtifact>,
  config: AnalysisConfig,
  readText: (rel: string) => Promise<string | null>,
  store?: FinalizeStore,
): Promise<Region[][]> {
  const { files, candidates } = findCandidates(artifacts);
  const hashes = files.map((f) => artifacts.get(f)?.hash);
  const pairs = await refineCandidates(files, candidates, readText, store ? { hashes, store } : { hashes });
  return groupClones(pairs, config);
}

export function cloneFinding(regions: Region[]): Finding {
  const first = regions[0] as Region;
  const lines = Math.min(...regions.map((r) => r.endLine - r.startLine + 1));
  const copies = regions.length;
  const severity = lines >= 50 ? 'high' : lines >= 15 ? 'medium' : 'low';
  const locations: Location[] = regions.map((r) => ({ file: r.file, startLine: r.startLine, endLine: r.endLine }));
  const minutes = Math.min(480, Math.round(20 + lines * 0.5 * (copies - 1)));
  return {
    id: findingId('duplication/clone', first.file, regions.map((r) => r.file).join('|') + `#${first.tokens}`),
    ruleId: 'duplication/clone',
    category: 'duplication',
    severity,
    confidence: 'high',
    title: `Código duplicado en ${copies} lugares (~${lines} líneas)`,
    message: `Se encontró un bloque de unos ${first.tokens} tokens repetido de forma idéntica en ${copies} ubicaciones.`,
    locations,
    evidence: [
      {
        kind: 'clone',
        tool: TOOL,
        description: `Coincidencia exacta de tokens (sin espacios ni comentarios), verificada token a token. Huellas: k=${K}, ventana=${W}.`,
        metric: { name: 'duplicatedTokens', value: first.tokens, threshold: 0, unit: 'tokens' },
      },
    ],
    impact: 'Cada corrección o cambio debe replicarse en todas las copias; es fácil que diverjan y aparezcan defectos inconsistentes.',
    effort: { minutes, rationale: '20 min base + 0,5 min por línea duplicada por cada copia adicional (máx. 8 h).' },
  };
}

export const duplicationAnalyzer: FileAnalyzer<DuplicationArtifact> = {
  id: ID,
  version: VERSION,
  description: 'Clones de código entre archivos y dentro del mismo archivo (tokens + winnowing).',
  supports: (meta) => isJsLike(meta),
  prepare: async () => {
    await loadTypeScript();
  },
  analyze(input) {
    return { findings: [], artifact: { ...fingerprintSource(input.text, input.meta.relPath), hash: input.contentHash } };
  },
  async finalize(artifacts, config, ctx) {
    return (await findClones(artifacts, config, ctx.readText, ctx.store)).map(cloneFinding);
  },
};
