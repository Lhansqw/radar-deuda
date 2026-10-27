import type ts from 'typescript';
import type { AnalysisConfig, FileAnalyzer, FinalizeStore, Finding, Location } from '../types.js';
import { computeLineStarts, findingId, lineAt, sha1 } from '../util.js';
import { isJsLike, languageVariantFor } from './shared.js';
import { lazy, loadTypeScript, tsApi } from './ts-runtime.js';

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

export const K = 25;
export const W = 20;
/** Huellas repetidas en más lugares que esto son código repetitivo (boilerplate), no clones útiles. */
const MAX_OCCURRENCES = 30;

const P1 = 50331653;
const P2 = 25165843;
const B1 = 257;
const B2 = 263;

/** [hash, posiciónDeToken, líneaInicio, líneaFin] */
export type Fingerprint = [number, number, number, number];

export interface DuplicationArtifact {
  tokens: number;
  fps: Fingerprint[];
  /** Hash del contenido del archivo; habilita la caché de verificación por par. */
  hash?: string;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function powMod(base: number, exp: number, mod: number): number {
  let r = 1;
  for (let i = 0; i < exp; i++) r = (r * base) % mod;
  return r;
}
const BK1 = powMod(B1, K - 1, P1);
const BK2 = powMod(B2, K - 1, P2);

/** Tokens tras los que un `/` inicia una expresión regular y no una división. */
const regexContext = lazy((ts) => new Set<ts.SyntaxKind>([
  ts.SyntaxKind.OpenParenToken, ts.SyntaxKind.OpenBracketToken, ts.SyntaxKind.OpenBraceToken, ts.SyntaxKind.CloseBraceToken,
  ts.SyntaxKind.CommaToken, ts.SyntaxKind.SemicolonToken, ts.SyntaxKind.ColonToken, ts.SyntaxKind.QuestionToken,
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationToken,
  ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.EqualsGreaterThanToken,
  ts.SyntaxKind.ReturnKeyword, ts.SyntaxKind.TypeOfKeyword, ts.SyntaxKind.CaseKeyword, ts.SyntaxKind.DoKeyword,
  ts.SyntaxKind.ElseKeyword, ts.SyntaxKind.InKeyword, ts.SyntaxKind.ThrowKeyword, ts.SyntaxKind.YieldKeyword,
  ts.SyntaxKind.AwaitKeyword, ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle,
]));

/**
 * Recorre los tokens sin construir el AST. El escáner de TypeScript necesita
 * ayuda en dos casos que dependen del contexto sintáctico: el cierre `}` de una
 * sustitución en plantillas (`${…}`) y la distinción entre `/` y una regex.
 */
export function forEachToken(scanner: ts.Scanner, cb: (kind: ts.SyntaxKind, text: string, start: number, end: number) => void): void {
  const ts = tsApi();
  const REGEX_CONTEXT = regexContext();
  const templateDepths: number[] = [];
  let braceDepth = 0;
  let prev: ts.SyntaxKind | undefined;
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.OpenBraceToken) braceDepth++;
    else if (kind === ts.SyntaxKind.CloseBraceToken) {
      if (templateDepths.length > 0 && templateDepths[templateDepths.length - 1] === braceDepth) {
        kind = scanner.reScanTemplateToken(false);
        if (kind === ts.SyntaxKind.TemplateTail) templateDepths.pop();
      } else braceDepth--;
    } else if (kind === ts.SyntaxKind.TemplateHead) {
      templateDepths.push(braceDepth);
    } else if ((kind === ts.SyntaxKind.SlashToken || kind === ts.SyntaxKind.SlashEqualsToken) && (prev === undefined || REGEX_CONTEXT.has(prev))) {
      kind = scanner.reScanSlashToken();
    }
    cb(kind, scanner.getTokenText(), scanner.getTokenStart(), scanner.getTokenEnd());
    prev = kind;
  }
}

export function fingerprintSource(text: string, relPath: string): DuplicationArtifact {
  const ts = tsApi();
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, languageVariantFor(relPath), text);
  const lineStarts = computeLineStarts(text);
  const lineOf = (pos: number): number => lineAt(lineStarts, pos);

  const hashes1: number[] = [];
  const hashes2: number[] = [];
  const startLines: number[] = [];
  const endLines: number[] = [];

  forEachToken(scanner, (kind, tokenText, start, end) => {
    const th = fnv1a(`${kind}:${tokenText}`);
    hashes1.push(th % P1);
    hashes2.push(th % P2);
    startLines.push(lineOf(start));
    endLines.push(lineOf(Math.max(end - 1, start)));
  });

  const n = hashes1.length;
  if (n < K) return { tokens: n, fps: [] };

  // Hashes rodantes de cada k-grama.
  const grams: number[] = new Array<number>(n - K + 1);
  let h1 = 0;
  let h2 = 0;
  for (let i = 0; i < K; i++) {
    h1 = (h1 * B1 + (hashes1[i] as number)) % P1;
    h2 = (h2 * B2 + (hashes2[i] as number)) % P2;
  }
  grams[0] = h1 * P2 + h2;
  for (let i = 1; i <= n - K; i++) {
    h1 = ((h1 - ((hashes1[i - 1] as number) * BK1) % P1 + P1) % P1 * B1 + (hashes1[i + K - 1] as number)) % P1;
    h2 = ((h2 - ((hashes2[i - 1] as number) * BK2) % P2 + P2) % P2 * B2 + (hashes2[i + K - 1] as number)) % P2;
    grams[i] = h1 * P2 + h2;
  }

  // Winnowing: mínimo de cada ventana (el más a la derecha en caso de empate).
  const fps: Fingerprint[] = [];
  let last = -1;
  const windows = Math.max(grams.length - W + 1, 1);
  for (let start = 0; start < windows; start++) {
    let minPos = start;
    const end = Math.min(start + W, grams.length);
    for (let j = start; j < end; j++) if ((grams[j] as number) <= (grams[minPos] as number)) minPos = j;
    if (minPos !== last) {
      fps.push([grams[minPos] as number, minPos, startLines[minPos] as number, endLines[minPos + K - 1] as number]);
      last = minPos;
    }
  }
  return { tokens: n, fps };
}

export interface Region {
  file: string;
  startLine: number;
  endLine: number;
  tokens: number;
}

interface Match {
  pA: number;
  sA: number;
  eA: number;
  sB: number;
  eB: number;
}

/** Coincidencia aproximada (límites al nivel de huella), antes de refinarla con los tokens reales. */
export interface Candidate {
  fa: number;
  fb: number;
  pA: number;
  pB: number;
  tokens: number;
  approxA: [number, number];
  approxB: [number, number];
}

export function findCandidates(artifacts: ReadonlyMap<string, DuplicationArtifact>): { files: string[]; candidates: Candidate[] } {
  const files = [...artifacts.keys()].sort();
  const index = new Map<number, Array<[number, number, number, number]>>(); // hash -> [archivo, pos, líneaIni, líneaFin]
  files.forEach((file, fi) => {
    for (const [hash, pos, s, e] of artifacts.get(file)?.fps ?? []) {
      let list = index.get(hash);
      if (!list) index.set(hash, (list = []));
      list.push([fi, pos, s, e]);
    }
  });

  // Agrupar por (archivoA, archivoB, desplazamiento) para fusionar huellas consecutivas.
  const groups = new Map<string, Match[]>();
  for (const occ of index.values()) {
    if (occ.length < 2 || occ.length > MAX_OCCURRENCES) continue;
    for (let i = 0; i < occ.length; i++) {
      for (let j = i + 1; j < occ.length; j++) {
        let a = occ[i] as [number, number, number, number];
        let b = occ[j] as [number, number, number, number];
        if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) [a, b] = [b, a];
        if (a[0] === b[0] && b[1] - a[1] < K) continue; // solapamiento dentro del mismo archivo
        const key = `${a[0]}|${b[0]}|${b[1] - a[1]}`;
        let g = groups.get(key);
        if (!g) groups.set(key, (g = []));
        g.push({ pA: a[1], sA: a[2], eA: a[3], sB: b[2], eB: b[3] });
      }
    }
  }

  const candidates: Candidate[] = [];
  for (const [key, matches] of groups) {
    const [fa, fb, delta] = key.split('|').map(Number) as [number, number, number];
    matches.sort((x, y) => x.pA - y.pA);
    let run: Match[] = [];
    const flush = (): void => {
      if (run.length === 0) return;
      const first = run[0] as Match;
      const last = run[run.length - 1] as Match;
      let sA = Infinity, eA = 0, sB = Infinity, eB = 0;
      for (const m of run) {
        sA = Math.min(sA, m.sA); eA = Math.max(eA, m.eA);
        sB = Math.min(sB, m.sB); eB = Math.max(eB, m.eB);
      }
      candidates.push({ fa, fb, pA: first.pA, pB: first.pA + delta, tokens: last.pA + K - first.pA, approxA: [sA, eA], approxB: [sB, eB] });
      run = [];
    };
    for (const m of matches) {
      const prev = run[run.length - 1];
      if (prev && m.pA - prev.pA > W) flush();
      run.push(m);
    }
    flush();
  }
  return { files, candidates };
}

interface TokenSeq {
  ids: Uint32Array;
  startLines: Uint32Array;
  endLines: Uint32Array;
  /** 1 = separador que no debe iniciar una región (`;` `,` `)` `]` `}`). */
  leading: Uint8Array;
  /** 1 = apertura que no debe terminar una región (`(` `[` `{` `,` `.`). */
  trailing: Uint8Array;
}

const noLeading = lazy((ts) => new Set<ts.SyntaxKind>([
  ts.SyntaxKind.SemicolonToken, ts.SyntaxKind.CommaToken, ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.CloseBracketToken, ts.SyntaxKind.CloseBraceToken,
]));
const noTrailing = lazy((ts) => new Set<ts.SyntaxKind>([
  ts.SyntaxKind.OpenParenToken, ts.SyntaxKind.OpenBracketToken, ts.SyntaxKind.OpenBraceToken,
  ts.SyntaxKind.CommaToken, ts.SyntaxKind.DotToken,
]));

export function tokenSequence(text: string, relPath: string): TokenSeq {
  const ts = tsApi();
  const NO_LEADING = noLeading();
  const NO_TRAILING = noTrailing();
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, languageVariantFor(relPath), text);
  const lineStarts = computeLineStarts(text);
  const ids: number[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const leading: number[] = [];
  const trailing: number[] = [];
  forEachToken(scanner, (kind, tokenText, start, end) => {
    ids.push(fnv1a(`${kind}:${tokenText}`));
    starts.push(lineAt(lineStarts, start));
    ends.push(lineAt(lineStarts, Math.max(end - 1, start)));
    leading.push(NO_LEADING.has(kind) ? 1 : 0);
    trailing.push(NO_TRAILING.has(kind) ? 1 : 0);
  });
  return {
    ids: Uint32Array.from(ids),
    startLines: Uint32Array.from(starts),
    endLines: Uint32Array.from(ends),
    leading: Uint8Array.from(leading),
    trailing: Uint8Array.from(trailing),
  };
}

/** Región verificada de un par: [líneaIniA, líneaFinA, líneaIniB, líneaFinB, tokens]. */
type PairRegion = [number, number, number, number, number];

function isPairRegions(v: unknown): v is PairRegion[] {
  return Array.isArray(v) && v.every((r) => Array.isArray(r) && r.length === 5 && r.every((n) => typeof n === 'number'));
}

export interface RefineOptions {
  /** Hash del contenido de cada archivo (mismo orden que `files`). */
  hashes?: ReadonlyArray<string | undefined>;
  /** Almacén persistente para reutilizar verificaciones entre ejecuciones. */
  store?: FinalizeStore;
  /** Tokens que pueden mantenerse en memoria a la vez (≈14 bytes por token). */
  tokenBudget?: number;
}

/** Secuencias de tokens con desalojo LRU acotado por número total de tokens. */
class SequenceCache {
  private readonly entries = new Map<number, TokenSeq | null>();
  private tokens = 0;
  /** Hash del texto leído de cada entrada, para comprobar que coincide con el huellado. */
  readonly readHashes = new Map<number, string>();
  reads = 0;

  constructor(
    private readonly files: readonly string[],
    private readonly readText: (rel: string) => Promise<string | null>,
    private readonly budget: number,
  ) {}

  async get(fi: number): Promise<TokenSeq | null> {
    if (this.entries.has(fi)) {
      const hit = this.entries.get(fi) ?? null;
      this.entries.delete(fi);
      this.entries.set(fi, hit);
      return hit;
    }
    const file = this.files[fi] as string;
    const raw = await this.readText(file);
    this.reads++;
    // Solo aquí (un par nuevo que verificar) hace falta el compilador si todo salió de la caché.
    await loadTypeScript();
    const text = raw !== null && raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const seq = text === null ? null : tokenSequence(text, file);
    if (raw !== null) this.readHashes.set(fi, sha1(raw));
    this.entries.set(fi, seq);
    this.tokens += seq?.ids.length ?? 0;
    for (const [key, value] of this.entries) {
      if (this.tokens <= this.budget || this.entries.size <= 2) break;
      this.entries.delete(key);
      this.readHashes.delete(key);
      this.tokens -= value?.ids.length ?? 0;
    }
    return seq;
  }
}

/** Verifica un candidato token a token y lo extiende; null si no se confirma. */
function verify(c: Candidate, a: TokenSeq, b: TokenSeq): PairRegion | null {
  let i = c.pA;
  let j = c.pB;
  let len = 0;
  while (i + len < a.ids.length && j + len < b.ids.length && a.ids[i + len] === b.ids[j + len] && (c.fa !== c.fb || i + len < j)) len++;
  if (len < K) return null; // no se confirma: colisión de hash o archivo modificado
  while (i > 0 && j > 0 && a.ids[i - 1] === b.ids[j - 1]) {
    i--;
    j--;
    len++;
  }
  if (c.fa === c.fb && i + len > j) len = j - i; // sin solapamiento dentro del mismo archivo
  // Bordes limpios: la extensión puede arrastrar un `;` o `}` de la sentencia anterior.
  while (len > 0 && a.leading[i] === 1) {
    i++;
    j++;
    len--;
  }
  while (len > 0 && a.trailing[i + len - 1] === 1) len--;
  if (len < K) return null;
  return [a.startLines[i] as number, a.endLines[i + len - 1] as number, b.startLines[j] as number, b.endLines[j + len - 1] as number, len];
}

/**
 * Refina cada candidato comparando los tokens reales: verifica la coincidencia
 * (descarta colisiones de hash o archivos cambiados) y la extiende a izquierda y
 * derecha hasta el primer token distinto. Así las líneas reportadas son exactas.
 *
 * Los candidatos se procesan por par de archivos. Si hay almacén, el resultado
 * de cada par se guarda con una clave que depende del contenido de ambos
 * archivos y de sus candidatos, de modo que solo se recalcula si algo cambió.
 */
export async function refineCandidates(
  files: readonly string[],
  candidates: Candidate[],
  readText: (rel: string) => Promise<string | null>,
  options: RefineOptions = {},
): Promise<Array<[Region, Region]>> {
  const { hashes, store, tokenBudget = 4_000_000 } = options;
  const seqs = new SequenceCache(files, readText, tokenBudget);
  candidates.sort((x, y) => x.fa - y.fa || x.fb - y.fb || x.pA - y.pA || x.pB - y.pB);

  const out: Array<[Region, Region]> = [];
  const seen = new Set<string>();
  const emit = (fa: number, fb: number, r: PairRegion): void => {
    const key = `${fa}|${fb}|${r.join(',')}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push([
      { file: files[fa] as string, startLine: r[0], endLine: r[1], tokens: r[4] },
      { file: files[fb] as string, startLine: r[2], endLine: r[3], tokens: r[4] },
    ]);
  };

  for (let start = 0; start < candidates.length; ) {
    const first = candidates[start] as Candidate;
    let end = start;
    while (end < candidates.length && (candidates[end] as Candidate).fa === first.fa && (candidates[end] as Candidate).fb === first.fb) end++;
    const group = candidates.slice(start, end);
    start = end;

    const hA = hashes?.[first.fa];
    const hB = hashes?.[first.fb];
    const storeKey = store && hA && hB ? sha1(`${hA}|${hB}|${group.map((c) => `${c.pA},${c.pB}`).join(';')}`) : undefined;
    if (storeKey && store) {
      const cached = store.get(storeKey);
      if (isPairRegions(cached)) {
        for (const r of cached) emit(first.fa, first.fb, r);
        continue;
      }
    }

    const a = await seqs.get(first.fa);
    const b = first.fa === first.fb ? a : await seqs.get(first.fb);
    if (!a || !b) continue;
    const regions: PairRegion[] = [];
    for (const c of group) {
      const r = verify(c, a, b);
      if (r) regions.push(r);
    }
    for (const r of regions) emit(first.fa, first.fb, r);

    // Solo se guarda si el contenido leído es el mismo que se huelló (sin carreras con ediciones).
    if (storeKey && store) {
      if (seqs.readHashes.get(first.fa) === hA && seqs.readHashes.get(first.fb) === hB) store.set(storeKey, regions);
    }
  }
  return out;
}

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
