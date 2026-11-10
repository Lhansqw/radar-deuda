import { describe, expect, it } from 'vitest';
import { CHAT_SYSTEM, EXPLAIN_SYSTEM, localizedSystem } from '../src/prompts.js';

describe('instrucciones según el idioma', () => {
  it('en español no cambian (las respuestas ya cacheadas siguen valiendo)', () => {
    expect(localizedSystem(EXPLAIN_SYSTEM, 'es')).toBe(EXPLAIN_SYSTEM);
    expect(localizedSystem(EXPLAIN_SYSTEM)).toBe(EXPLAIN_SYSTEM);
  });

  it('en inglés piden los textos en inglés, pero las claves y los valores enumerados igual', () => {
    const en = localizedSystem(EXPLAIN_SYSTEM, 'en');
    expect(en).not.toContain('Responde en español');
    expect(en).toContain('Responde en inglés');
    expect(en).toContain('in English');
    expect(en).toContain('"evidencia"');
    expect(localizedSystem(CHAT_SYSTEM, 'en')).toContain('in English');
  });
});
