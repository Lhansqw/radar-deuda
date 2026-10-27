import type { FinalizeStore } from '../types.js';
import { sha1 } from '../util.js';
import { K, W, tokenSequence, type DuplicationArtifact, type TokenSeq } from './duplication-tokens.js';
import { loadTypeScript } from './ts-runtime.js';

/**
 * Emparejamiento de huellas entre archivos (candidatos aproximados) y su
 * verificación token a token, que da las líneas exactas de cada clon.
 */

/** Huellas repetidas en más lugares que esto son código repetitivo (boilerplate), no clones útiles. */
const MAX_OCCURRENCES = 30;

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

/** Una aparición de una huella: [archivo, posición, líneaIni, líneaFin]. */
type Occurrence = [number, number, number, number];

export function findCandidates(artifacts: ReadonlyMap<string, DuplicationArtifact>): { files: string[]; candidates: Candidate[] } {
  const files = [...artifacts.keys()].sort();
  const groups = groupMatches(fingerprintIndex(files, artifacts));
  const candidates: Candidate[] = [];
  for (const [key, matches] of groups) {
    const [fa, fb, delta] = key.split('|').map(Number) as [number, number, number];
    matches.sort((x, y) => x.pA - y.pA);
    for (const run of consecutiveRuns(matches)) candidates.push(toCandidate(run, fa, fb, delta));
  }
  return { files, candidates };
}

/** Huella → dónde aparece. */
function fingerprintIndex(files: readonly string[], artifacts: ReadonlyMap<string, DuplicationArtifact>): Map<number, Occurrence[]> {
  const index = new Map<number, Occurrence[]>();
  files.forEach((file, fi) => {
    for (const [hash, pos, s, e] of artifacts.get(file)?.fps ?? []) {
      let list = index.get(hash);
      if (!list) index.set(hash, (list = []));
      list.push([fi, pos, s, e]);
    }
  });
  return index;
}

/**
 * Cada par de apariciones de una misma huella, agrupado por (archivoA,
 * archivoB, desplazamiento) para poder fusionar después huellas consecutivas.
 * Las huellas demasiado frecuentes (código repetitivo sin interés) se ignoran.
 */
function groupMatches(index: ReadonlyMap<number, Occurrence[]>): Map<string, Match[]> {
  const groups = new Map<string, Match[]>();
  for (const occ of index.values()) {
    if (occ.length < 2 || occ.length > MAX_OCCURRENCES) continue;
    for (let i = 0; i < occ.length; i++) {
      for (let j = i + 1; j < occ.length; j++) {
        const [a, b] = ordered(occ[i] as Occurrence, occ[j] as Occurrence);
        if (a[0] === b[0] && b[1] - a[1] < K) continue; // solapamiento dentro del mismo archivo
        const key = `${a[0]}|${b[0]}|${b[1] - a[1]}`;
        let g = groups.get(key);
        if (!g) groups.set(key, (g = []));
        g.push({ pA: a[1], sA: a[2], eA: a[3], sB: b[2], eB: b[3] });
      }
    }
  }
  return groups;
}

/** Primero la del archivo menor y, en el mismo archivo, la de posición menor. */
const ordered = (a: Occurrence, b: Occurrence): [Occurrence, Occurrence] => (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]) ? [b, a] : [a, b]);

/** Coincidencias (ya ordenadas por posición) separadas por no más de W tokens. */
function consecutiveRuns(matches: readonly Match[]): Match[][] {
  const runs: Match[][] = [];
  let run: Match[] = [];
  for (const m of matches) {
    const prev = run[run.length - 1];
    if (prev && m.pA - prev.pA > W) {
      runs.push(run);
      run = [];
    }
    run.push(m);
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

function toCandidate(run: readonly Match[], fa: number, fb: number, delta: number): Candidate {
  const first = run[0] as Match;
  const last = run[run.length - 1] as Match;
  let sA = Infinity;
  let eA = 0;
  let sB = Infinity;
  let eB = 0;
  for (const m of run) {
    sA = Math.min(sA, m.sA);
    eA = Math.max(eA, m.eA);
    sB = Math.min(sB, m.sB);
    eB = Math.max(eB, m.eB);
  }
  return { fa, fb, pA: first.pA, pB: first.pA + delta, tokens: last.pA + K - first.pA, approxA: [sA, eA], approxB: [sB, eB] };
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
  const seqs = new SequenceCache(files, readText, options.tokenBudget ?? 4_000_000);
  candidates.sort((x, y) => x.fa - y.fa || x.fb - y.fb || x.pA - y.pA || x.pB - y.pB);
  const out = new PairCollector(files);
  for (const group of byFilePair(candidates)) {
    const { fa, fb } = group[0] as Candidate;
    out.add(fa, fb, await refinePair(group, seqs, options));
  }
  return out.pairs;
}

/** Candidatos consecutivos del mismo par de archivos (la lista ya está ordenada). */
function byFilePair(candidates: readonly Candidate[]): Candidate[][] {
  const groups: Candidate[][] = [];
  let current: Candidate[] = [];
  for (const c of candidates) {
    const first = current[0];
    if (first && (first.fa !== c.fa || first.fb !== c.fb)) {
      groups.push(current);
      current = [];
    }
    current.push(c);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** Regiones verificadas de un par de archivos; del almacén si ni los archivos ni los candidatos cambiaron. */
async function refinePair(group: readonly Candidate[], seqs: SequenceCache, { hashes, store }: RefineOptions): Promise<PairRegion[]> {
  const { fa, fb } = group[0] as Candidate;
  const hA = hashes?.[fa];
  const hB = hashes?.[fb];
  const storeKey = store && hA && hB ? sha1(`${hA}|${hB}|${group.map((c) => `${c.pA},${c.pB}`).join(';')}`) : undefined;
  if (store && storeKey) {
    const cached = store.get(storeKey);
    if (isPairRegions(cached)) return cached;
  }
  const a = await seqs.get(fa);
  const b = fa === fb ? a : await seqs.get(fb);
  if (!a || !b) return [];
  const regions: PairRegion[] = [];
  for (const c of group) {
    const r = verify(c, a, b);
    if (r) regions.push(r);
  }
  // Solo se guarda si el contenido leído es el mismo que se huelló (sin carreras con ediciones).
  if (store && storeKey && seqs.readHashes.get(fa) === hA && seqs.readHashes.get(fb) === hB) store.set(storeKey, regions);
  return regions;
}

/** Pares de regiones sin repetir, en el orden en que aparecen. */
class PairCollector {
  readonly pairs: Array<[Region, Region]> = [];
  private readonly seen = new Set<string>();

  constructor(private readonly files: readonly string[]) {}

  add(fa: number, fb: number, regions: readonly PairRegion[]): void {
    for (const r of regions) {
      const key = `${fa}|${fb}|${r.join(',')}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.pairs.push([
        { file: this.files[fa] as string, startLine: r[0], endLine: r[1], tokens: r[4] },
        { file: this.files[fb] as string, startLine: r[2], endLine: r[3], tokens: r[4] },
      ]);
    }
  }
}
