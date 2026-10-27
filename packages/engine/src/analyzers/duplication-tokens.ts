import type ts from 'typescript';
import { computeLineStarts, lineAt } from '../util.js';
import { languageVariantFor } from './shared.js';
import { lazy, tsApi } from './ts-runtime.js';

/**
 * Tokens y huellas para la detección de duplicados: k-gramas de tokens del
 * escáner de TypeScript (sin espacios ni comentarios) con hash rodante, y
 * *winnowing* para quedarse con pocas huellas por archivo.
 */

export const K = 25;
export const W = 20;

const P1 = 50331653;
const P2 = 25165843;
const B1 = 257;
const B2 = 263;

/** Una huella: [hash, posiciónDeToken, líneaInicio, líneaFin]. */
export type Fingerprint = [number, number, number, number];

/** Números por huella en `DuplicationArtifact.fps`. */
export const FP_STRIDE = 4;

export interface DuplicationArtifact {
  tokens: number;
  /**
   * Huellas seguidas en un solo arreglo: hash, posición, línea de inicio y
   * línea de fin de cada una (FP_STRIDE números por huella). Un arreglo plano
   * ocupa en memoria y en la caché bastante menos que un arreglo por huella.
   */
  fps: number[];
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
  const fps: number[] = [];
  let last = -1;
  const windows = Math.max(grams.length - W + 1, 1);
  for (let start = 0; start < windows; start++) {
    let minPos = start;
    const end = Math.min(start + W, grams.length);
    for (let j = start; j < end; j++) if ((grams[j] as number) <= (grams[minPos] as number)) minPos = j;
    if (minPos !== last) {
      fps.push(grams[minPos] as number, minPos, startLines[minPos] as number, endLines[minPos + K - 1] as number);
      last = minPos;
    }
  }
  return { tokens: n, fps };
}

/** Las huellas de un artefacto, una a una. */
export function* fingerprints(art: DuplicationArtifact | undefined): Generator<Fingerprint> {
  const fps = art?.fps ?? [];
  for (let i = 0; i + FP_STRIDE <= fps.length; i += FP_STRIDE) {
    yield [fps[i] as number, fps[i + 1] as number, fps[i + 2] as number, fps[i + 3] as number];
  }
}

export interface TokenSeq {
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
