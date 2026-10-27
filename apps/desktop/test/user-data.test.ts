import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { adoptLegacyData, userDataDir } from '../src/main/user-data.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function dataDir(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'radar-usuarios-'));
  dirs.push(d);
  return d;
}

const ANA = '6f1c2a4e-9b3d-4c5e-8f70-112233445566';
const LUIS = '0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3';

describe('datos por usuario', () => {
  it('cada usuario tiene su carpeta; el identificador debe ser un UUID', async () => {
    const root = await dataDir();
    expect(userDataDir(root, ANA)).toBe(path.join(root, 'usuarios', ANA));
    for (const bad of ['..', '../otro', `${ANA}/..`, 'C:\\x', '']) expect(() => userDataDir(root, bad)).toThrow('Identificador de usuario no válido.');
  });

  it('la primera cuenta que entra se queda con los datos de antes de las cuentas', async () => {
    const root = await dataDir();
    writeFileSync(path.join(root, 'radar.db'), 'proyectos de antes');
    writeFileSync(path.join(root, 'radar.db-wal'), 'diario');
    const ana = userDataDir(root, ANA);
    expect(adoptLegacyData(root, ana)).toBe(true);
    expect(readFileSync(path.join(ana, 'radar.db'), 'utf8')).toBe('proyectos de antes');
    expect(readFileSync(path.join(ana, 'radar.db-wal'), 'utf8')).toBe('diario');
    expect(existsSync(path.join(root, 'radar.db'))).toBe(false);
    expect(adoptLegacyData(root, ana)).toBe(false);
  });

  it('si ya entró otra cuenta, los datos de antes no se mueven', async () => {
    const root = await dataDir();
    mkdirSync(userDataDir(root, LUIS), { recursive: true });
    writeFileSync(path.join(root, 'radar.db'), 'proyectos de antes');
    expect(adoptLegacyData(root, userDataDir(root, ANA))).toBe(false);
    expect(existsSync(path.join(root, 'radar.db'))).toBe(true);
  });

  it('sin datos de antes no hace nada', async () => {
    const root = await dataDir();
    expect(adoptLegacyData(root, userDataDir(root, ANA))).toBe(false);
    expect(existsSync(path.join(root, 'usuarios'))).toBe(false);
  });
});
