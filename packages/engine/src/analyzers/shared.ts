import type ts from 'typescript';
import { tsApi } from './ts-runtime.js';
import type { FileInput, FileMeta, Severity } from '../types.js';

/** Severidad según cuánto se supera el umbral: >1× media, ≥2× alta, ≥4× crítica. */
export function severityByRatio(value: number, threshold: number, maxSeverity: Severity = 'critical'): Severity {
  const ratio = value / threshold;
  const sev: Severity = ratio >= 4 ? 'critical' : ratio >= 2 ? 'high' : 'medium';
  const rank = { critical: 4, high: 3, medium: 2, low: 1, info: 0 } as const;
  return rank[sev] > rank[maxSeverity] ? maxSeverity : sev;
}

export function isJsLike(meta: FileMeta): boolean {
  return meta.language === 'typescript' || meta.language === 'javascript';
}

export function scriptKindFor(relPath: string): ts.ScriptKind {
  const ts = tsApi();
  const lower = relPath.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(lower)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function languageVariantFor(relPath: string): ts.LanguageVariant {
  const ts = tsApi();
  const kind = scriptKindFor(relPath);
  // Los .js también pueden contener JSX (convención de React/CRA).
  return kind === ts.ScriptKind.TS ? ts.LanguageVariant.Standard : ts.LanguageVariant.JSX;
}

/** AST compartido entre analizadores del mismo archivo (se construye una sola vez). */
export function getSourceFile(input: Pick<FileInput, 'memo' | 'text' | 'meta'>): ts.SourceFile {
  const ts = tsApi();
  return input.memo('ts:sourceFile', () =>
    ts.createSourceFile(input.meta.relPath, input.text, ts.ScriptTarget.Latest, true, scriptKindFor(input.meta.relPath)),
  );
}
