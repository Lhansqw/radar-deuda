import { classify, isTestPath } from '../../src/discovery.js';
import type { FileInput, FileMeta } from '../../src/types.js';
import { sha1, splitLines } from '../../src/util.js';

/** Construye la entrada de un analizador a partir de un texto en memoria. */
export function fileInput(relPath: string, text: string): FileInput {
  const cls = classify(relPath);
  const meta: FileMeta = {
    absPath: `/virtual/${relPath}`,
    relPath,
    size: Buffer.byteLength(text),
    mtimeMs: 0,
    language: cls.language,
    isCode: cls.isCode,
    isTest: isTestPath(relPath),
  };
  const memo = new Map<string, unknown>();
  return {
    meta,
    contentHash: sha1(text),
    text,
    lines: splitLines(text),
    memo<T>(key: string, create: () => T): T {
      if (!memo.has(key)) memo.set(key, create());
      return memo.get(key) as T;
    },
  };
}
