/**
 * Texto de una respuesta de la IA → bloques para mostrarlo sin interpretar
 * HTML: párrafos, listas con guiones o numeradas, **negrita** y referencias
 * a hallazgos ([H3] o [H3, H5]).
 */
export type Inline = { kind: 'text'; text: string } | { kind: 'strong'; text: string } | { kind: 'ref'; alias: string };
export type Block = { kind: 'p'; lines: Inline[][] } | { kind: 'ul' | 'ol'; items: Inline[][] };

const ITEM = /^\s*([-*•]|\d+[.)])\s+/;

export function parseInline(line: string): Inline[] {
  const out: Inline[] = [];
  for (const part of line.split(/(\[[^\]\n]{1,60}\]|\*\*[^*\n]+\*\*)/)) {
    if (part === '') continue;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      out.push({ kind: 'strong', text: part.slice(2, -2) });
      continue;
    }
    const aliases = part.startsWith('[') ? [...part.matchAll(/\bH\d{1,4}\b/g)].map((m) => m[0]) : [];
    if (aliases.length === 0) out.push({ kind: 'text', text: part });
    else for (const alias of aliases) out.push({ kind: 'ref', alias });
  }
  return out;
}

export function parseAnswer(text: string): Block[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.split('\n').filter((l) => l.trim() !== ''))
    .filter((lines) => lines.length > 0)
    .map((lines): Block => {
      if (lines.every((l) => ITEM.test(l))) {
        return { kind: /^\s*\d/.test(lines[0] ?? '') ? 'ol' : 'ul', items: lines.map((l) => parseInline(l.replace(ITEM, ''))) };
      }
      return { kind: 'p', lines: lines.map(parseInline) };
    });
}
