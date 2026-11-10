import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTheme, windowBackground, writeTheme } from '../src/main/appearance.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function appearanceFile(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'radar-apariencia-'));
  dirs.push(d);
  return path.join(d, 'datos', 'apariencia.json');
}

describe('tema de la interfaz', () => {
  it('sin archivo, el tema es el oscuro', async () => {
    expect(readTheme(await appearanceFile())).toBe('dark');
  });

  it('un archivo dañado o con un valor desconocido vale el oscuro', async () => {
    const file = await appearanceFile();
    writeTheme(file, 'light');
    for (const content of ['{no es json', '"light"', 'null', '[]', JSON.stringify({ theme: 'azul' }), JSON.stringify({ theme: 1 })]) {
      writeFileSync(file, content);
      expect(readTheme(file)).toBe('dark');
    }
  });

  it('guarda el tema elegido (creando la carpeta) y lo lee igual', async () => {
    const file = await appearanceFile();
    for (const theme of ['light', 'system', 'dark'] as const) {
      writeTheme(file, theme);
      expect(readTheme(file)).toBe(theme);
    }
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it('el fondo de la ventana coincide con el tema', () => {
    expect(windowBackground(true)).toBe('#131b26');
    expect(windowBackground(false)).toBe('#e9eef4');
  });
});
