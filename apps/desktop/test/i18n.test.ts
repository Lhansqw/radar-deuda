import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { currentLocale, initLanguage, languageSetting, LANGUAGE_FILE, setLanguage, tr } from '../src/main/i18n.js';
import { createFormat } from './helpers/format.js';
import { resolveLocale, validateSettings } from '../src/shared/settings.js';
import { emailProblem } from '../src/shared/account.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('idioma', () => {
  it('«auto» sigue al sistema: español si es es-*, inglés en cualquier otro caso', () => {
    expect(resolveLocale('auto', 'es-MX')).toBe('es');
    expect(resolveLocale('auto', 'es')).toBe('es');
    expect(resolveLocale('auto', 'en-US')).toBe('en');
    expect(resolveLocale('auto', 'fr-FR')).toBe('en');
    expect(resolveLocale('es', 'en-US')).toBe('es');
    expect(resolveLocale('en', 'es-ES')).toBe('en');
  });

  it('el proceso principal guarda la preferencia en la carpeta de datos y la lee al abrir', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'radar-idioma-'));
    dirs.push(dir);
    initLanguage(dir, 'es-ES');
    expect(languageSetting()).toBe('auto');
    expect(currentLocale()).toBe('es');
    expect(setLanguage('en')).toBe('en');
    expect(tr('Hola', 'Hello')).toBe('Hello');
    expect(JSON.parse(await readFile(path.join(dir, LANGUAGE_FILE), 'utf8'))).toEqual({ language: 'en' });

    initLanguage(dir, 'es-ES');
    expect(currentLocale()).toBe('en');
    setLanguage('auto');
    expect(currentLocale()).toBe('es');
  });

  it('los errores de los ajustes y del correo, en el idioma pedido', () => {
    const r = validateSettings(null, 'en');
    expect(r.ok ? [] : r.errors).toEqual(['Invalid settings format.']);
    expect(emailProblem('', (_es, en) => en)).toBe('Enter your email.');
    expect(emailProblem('')).toBe('Escribe tu correo.');
  });

  it('formatos de la interfaz en los dos idiomas', () => {
    const now = new Date('2026-10-26T12:00:00Z');
    const en = createFormat('en');
    expect(en.formatEffort(150)).toBe('2.5 h');
    expect(en.formatRelative('2026-10-26T11:55:00Z', now)).toBe('5 min ago');
    expect(en.formatRelative('2026-10-25T10:00:00Z', now)).toBe('yesterday');
    const es = createFormat('es');
    expect(es.formatEffort(150)).toBe('2,5 h');
    expect(es.formatRelative('2026-10-26T11:55:00Z', now)).toBe('hace 5 min');
  });
});
