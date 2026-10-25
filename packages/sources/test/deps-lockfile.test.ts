import { describe, expect, it } from 'vitest';
import { cvss3BaseScore, roundUp, severityFromScore } from '../src/deps/cvss.js';
import { lockfileLine, nameFromPath, parseNpmLockfile } from '../src/deps/lockfile.js';

describe('parseNpmLockfile', () => {
  it('lee v3: directas, transitivas, desarrollo, anidadas y workspaces', () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'app', dependencies: { lodash: '^4.17.0' }, devDependencies: { vitest: '^5.0.0' } },
        'node_modules/lodash': { version: '4.17.20' },
        'node_modules/vitest': { version: '5.0.5', dev: true },
        'node_modules/tinyspy': { version: '4.0.0', dev: true },
        'node_modules/@scope/util': { version: '1.2.3' },
        'node_modules/a/node_modules/lodash': { version: '3.10.1' },
        'packages/web': { name: 'web', dependencies: { '@scope/util': '^1.0.0' } },
        'node_modules/web': { resolved: 'packages/web', link: true },
        'node_modules/desde-git': { version: 'git+https://github.com/x/y.git#abc' },
      },
    };
    const inv = parseNpmLockfile(JSON.stringify(lock));
    expect(inv.lockfileVersion).toBe(3);
    expect(inv.skipped).toBe(1);
    expect(inv.packages.map((p) => [p.name, p.version, p.direct, p.dev])).toEqual([
      ['@scope/util', '1.2.3', true, false], // directa de un workspace
      ['lodash', '3.10.1', false, false],
      ['lodash', '4.17.20', true, false],
      ['tinyspy', '4.0.0', false, true],
      ['vitest', '5.0.5', true, true],
    ]);
  });

  it('lee v1 (árbol anidado)', () => {
    const lock = {
      lockfileVersion: 1,
      dependencies: {
        express: { version: '4.17.1', dependencies: { qs: { version: '6.7.0' } } },
        jest: { version: '26.0.0', dev: true },
      },
    };
    const inv = parseNpmLockfile(JSON.stringify(lock));
    expect(inv.packages.map((p) => [p.name, p.version, p.direct, p.dev, p.paths[0]])).toEqual([
      ['express', '4.17.1', true, false, 'node_modules/express'],
      ['jest', '26.0.0', true, true, 'node_modules/jest'],
      ['qs', '6.7.0', false, false, 'node_modules/express/node_modules/qs'],
    ]);
  });

  it('una copia de producción prevalece sobre una de desarrollo', () => {
    const lock = { lockfileVersion: 3, packages: { '': {}, 'node_modules/x': { version: '1.0.0', dev: true }, 'node_modules/y/node_modules/x': { version: '1.0.0' } } };
    expect(parseNpmLockfile(JSON.stringify(lock)).packages[0]).toMatchObject({ name: 'x', dev: false, paths: ['node_modules/x', 'node_modules/y/node_modules/x'] });
  });

  it('rechaza JSON inválido con un mensaje claro', () => {
    expect(() => parseNpmLockfile('{')).toThrow(/no es JSON válido/);
  });

  it('nameFromPath y lockfileLine', () => {
    expect(nameFromPath('node_modules/a/node_modules/@s/b')).toBe('@s/b');
    expect(nameFromPath('packages/web')).toBeNull();
    expect(lockfileLine(['{', '  "packages": {', '    "node_modules/lodash": {'], 'node_modules/lodash', 'lodash')).toBe(3);
  });
});

describe('CVSS v3', () => {
  it.each([
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 9.8, 'critical'],
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N', 6.1, 'medium'],
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H', 10, 'critical'],
    ['CVSS:3.0/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N', 5.5, 'medium'],
    ['CVSS:3.1/AV:N/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N', 2, 'low'],
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N', 0, 'info'],
  ] as const)('%s → %d (%s)', (vector, score, severity) => {
    expect(cvss3BaseScore(vector)).toBe(score);
    expect(severityFromScore(score)).toBe(severity);
  });

  it('rechaza vectores incompletos o de otra versión', () => {
    expect(cvss3BaseScore('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N')).toBeNull();
    expect(cvss3BaseScore('CVSS:3.1/AV:N/AC:L')).toBeNull();
  });

  it('roundUp sigue el Apéndice A (evita errores de coma flotante)', () => {
    expect(roundUp(4.02)).toBe(4.1);
    expect(roundUp(4.0)).toBe(4);
    expect(roundUp(4.000_000_1)).toBe(4);
  });
});
