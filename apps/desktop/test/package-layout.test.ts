import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { packageLayout, unpackedDir } from '../scripts/package-layout.js';

const release = path.resolve('release');

describe('packageLayout', () => {
  it('Windows y Linux: ejecutable y ASAR en la carpeta sin instalador', () => {
    expect(packageLayout(release, 'win32', 'x64')).toEqual({
      unpacked: path.join(release, 'win-unpacked'),
      exe: path.join(release, 'win-unpacked', 'radar-deuda.exe'),
      asar: path.join('resources', 'app.asar'),
    });
    expect(packageLayout(release, 'linux', 'x64').exe).toBe(path.join(release, 'linux-unpacked', 'radar-deuda'));
    expect(unpackedDir(release, 'linux', 'arm64')).toBe(path.join(release, 'linux-arm64-unpacked'));
  });

  it('macOS: busca el .app y su ejecutable (Apple Silicon en mac-arm64)', () => {
    const files: Record<string, string[]> = {
      [path.join(release, 'mac-arm64')]: ['Radar de Deuda Técnica.app'],
      [path.join(release, 'mac-arm64', 'Radar de Deuda Técnica.app', 'Contents', 'MacOS')]: ['Radar de Deuda Técnica'],
    };
    const layout = packageLayout(release, 'darwin', 'arm64', (dir) => files[dir] ?? []);
    expect(layout.unpacked).toBe(path.join(release, 'mac-arm64'));
    expect(layout.exe).toBe(path.join(release, 'mac-arm64', 'Radar de Deuda Técnica.app', 'Contents', 'MacOS', 'Radar de Deuda Técnica'));
    expect(layout.asar).toBe(path.join('Radar de Deuda Técnica.app', 'Contents', 'Resources', 'app.asar'));
    expect(unpackedDir(release, 'darwin', 'x64')).toBe(path.join(release, 'mac'));
  });

  it('macOS sin .app: error claro', () => {
    expect(() => packageLayout(release, 'darwin', 'arm64', () => [])).toThrow(/\.app/);
  });
});
