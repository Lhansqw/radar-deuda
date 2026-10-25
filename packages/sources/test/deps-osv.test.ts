import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeRepository } from '@radar/engine';
import { fixedVersions, OsvClient, recordSeverity, type OsvRecord } from '../src/deps/osv.js';
import { recommendedVersion, vulnerabilityAnalyzer } from '../src/deps/vulnerabilities.js';
import { fakeFetch, json, noSleep } from './helpers/fake-fetch.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'radar-osv-'));
  dirs.push(d);
  return d;
}

/** Registro con la forma de OSV, modelado sobre el aviso real de inyección de comandos en lodash < 4.17.21. */
const LODASH: OsvRecord = {
  id: 'GHSA-35jh-r3h4-6jhm',
  modified: '2024-01-01T00:00:00Z',
  aliases: ['CVE-2021-23337'],
  summary: 'Command Injection in lodash',
  database_specific: { severity: 'HIGH' },
  severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H' }],
  affected: [{ package: { ecosystem: 'npm', name: 'lodash' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }],
};
const NO_FIX: OsvRecord = {
  id: 'GHSA-xxxx-yyyy-zzzz',
  modified: '2024-02-01T00:00:00Z',
  summary: 'Prototype pollution sin corrección',
  severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
  affected: [{ package: { ecosystem: 'npm', name: 'lodash' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }] }] }],
};

/** Servidor OSV simulado: lodash@4.17.20 tiene vulnerabilidades; el resto, ninguna. */
function osvServer(records: OsvRecord[] = [LODASH]) {
  return fakeFetch(async (url, init) => {
    if (url.endsWith('/v1/querybatch')) {
      const body = JSON.parse(String(init?.body)) as { queries: Array<{ package: { name: string }; version: string }> };
      return json({
        results: body.queries.map((q) =>
          q.package.name === 'lodash' && q.version === '4.17.20' ? { vulns: records.map((r) => ({ id: r.id, modified: r.modified })) } : {},
        ),
      });
    }
    const id = decodeURIComponent(url.split('/').pop() ?? '');
    const rec = records.find((r) => r.id === id);
    return rec ? json(rec) : json({}, 404);
  });
}

describe('registros OSV', () => {
  it('usa la severidad de la base de datos y, si falta, calcula CVSS v3', () => {
    expect(recordSeverity(LODASH)).toEqual({ severity: 'high', source: 'database_specific.severity = HIGH' });
    expect(recordSeverity(NO_FIX).severity).toBe('critical');
    expect(recordSeverity({ id: 'X', modified: '' }).source).toMatch(/se asume media/);
  });

  it('calcula las versiones corregidas aplicables a la instalada', () => {
    expect(fixedVersions(LODASH, 'lodash', '4.17.20')).toEqual(['4.17.21']);
    expect(fixedVersions(LODASH, 'otro', '4.17.20')).toEqual([]);
    expect(fixedVersions(NO_FIX, 'lodash', '4.17.20')).toEqual([]);
  });
});

describe('OsvClient', () => {
  it('pagina con next_page_token repitiendo solo las consultas pendientes', async () => {
    let call = 0;
    const fetch = fakeFetch(async (_url, init) => {
      call++;
      const body = JSON.parse(String(init?.body)) as { queries: Array<{ page_token?: string }> };
      if (call === 1) return json({ results: [{ vulns: [{ id: 'A' }], next_page_token: 'p2' }, { vulns: [{ id: 'B' }] }] });
      expect(body.queries).toHaveLength(1);
      expect(body.queries[0]?.page_token).toBe('p2');
      return json({ results: [{ vulns: [{ id: 'C' }] }] });
    });
    const client = new OsvClient({ fetch });
    const ids = await client.queryBatch([{ name: 'a', version: '1.0.0' }, { name: 'b', version: '1.0.0' }]);
    expect(ids.map((l) => l.map((v) => v.id))).toEqual([['A', 'C'], ['B']]);
  });

  it('divide en lotes de 1 000 consultas', async () => {
    const sizes: number[] = [];
    const fetch = fakeFetch(async (_url, init) => {
      const n = (JSON.parse(String(init?.body)) as { queries: unknown[] }).queries.length;
      sizes.push(n);
      return json({ results: Array.from({ length: n }, () => ({})) });
    });
    await new OsvClient({ fetch }).queryBatch(Array.from({ length: 2500 }, (_, i) => ({ name: `p${i}`, version: '1.0.0' })));
    expect(sizes).toEqual([1000, 1000, 500]);
  });

  it('guarda los registros en disco y los reutiliza si no cambió la fecha de modificación', async () => {
    const cacheDir = await tmp();
    const q = [{ name: 'lodash', version: '4.17.20' }];
    const first = new OsvClient({ fetch: osvServer(), cacheDir });
    await first.vulnerabilities(q);
    expect(first.requests).toBe(2); // lote + detalle
    expect(await readdir(cacheDir)).toEqual(['GHSA-35jh-r3h4-6jhm.json']);
    const second = new OsvClient({ fetch: osvServer(), cacheDir });
    const [vulns] = await second.vulnerabilities(q);
    expect(second.requests).toBe(1); // solo el lote: el detalle sale de la caché
    expect(vulns?.[0]).toMatchObject({ id: 'GHSA-35jh-r3h4-6jhm', aliases: ['CVE-2021-23337'], severity: 'high', fixedIn: ['4.17.21'] });
  });

  it('descarta registros retirados y rechaza respuestas incoherentes', async () => {
    const withdrawn = { ...LODASH, withdrawn: '2024-05-01T00:00:00Z' };
    const [vulns] = await new OsvClient({ fetch: osvServer([withdrawn]) }).vulnerabilities([{ name: 'lodash', version: '4.17.20' }]);
    expect(vulns).toEqual([]);
    const bad = fakeFetch(async () => json({ results: [] }));
    await expect(new OsvClient({ fetch: bad, sleep: noSleep }).queryBatch([{ name: 'a', version: '1.0.0' }])).rejects.toThrow(/inesperado/);
  });
});

describe('vulnerabilityAnalyzer', () => {
  it('genera hallazgos con evidencia, ubicación y versión recomendada', async () => {
    const root = await tmp();
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { lodash: '^4.17.0' } }, null, 2));
    await writeFile(
      path.join(root, 'package-lock.json'),
      JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { lodash: '^4.17.0' } }, 'node_modules/lodash': { version: '4.17.20' }, 'node_modules/ms': { version: '2.1.3' } } }, null, 2),
    );
    const client = new OsvClient({ fetch: osvServer([LODASH, NO_FIX]) });
    const report = await analyzeRepository(root, { cacheDir: null, projectAnalyzers: [vulnerabilityAnalyzer(client)] });
    const vulns = report.findings.filter((f) => f.ruleId === 'dependencies/vulnerable');
    expect(vulns).toHaveLength(1);
    const f = vulns[0];
    expect(f).toMatchObject({ category: 'security', severity: 'critical', confidence: 'high', title: '2 vulnerabilidades conocidas en lodash@4.17.20' });
    expect(f?.locations.map((l) => l.file)).toEqual(['package-lock.json', 'package.json']);
    expect(f?.message).toMatch(/4\.17\.21 o superior/);
    expect(f?.message).toMatch(/GHSA-xxxx-yyyy-zzzz no tiene versión corregida/);
    expect(f?.evidence.map((e) => e.snippet)).toEqual(['https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm', 'https://osv.dev/vulnerability/GHSA-xxxx-yyyy-zzzz']);
    expect(report.coverage.find((c) => c.area === 'Dependencias')).toMatchObject({ status: 'analyzed' });
  });

  it('declara cobertura parcial si solo hay lockfiles no compatibles', async () => {
    const root = await tmp();
    await writeFile(path.join(root, 'package.json'), '{"dependencies":{"a":"1.0.0"}}');
    await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    const report = await analyzeRepository(root, { cacheDir: null, projectAnalyzers: [vulnerabilityAnalyzer(new OsvClient({ fetch: osvServer() }))] });
    expect(report.coverage.find((c) => c.area === 'Dependencias')).toMatchObject({ status: 'partial', detail: expect.stringContaining('pnpm-lock.yaml') });
  });

  it('recommendedVersion toma la mayor de las correcciones mínimas', () => {
    const v = (fixedIn: string[]) => ({ id: 'x', aliases: [], summary: '', severity: 'high' as const, severitySource: '', fixedIn, url: '' });
    expect(recommendedVersion([v(['1.2.0', '2.0.0']), v(['1.5.1'])])).toBe('1.5.1');
    expect(recommendedVersion([v([])])).toBeNull();
  });

  it.runIf(process.env['RADAR_LIVE'] === '1')('en vivo: OSV conoce la vulnerabilidad de lodash 4.17.20', async () => {
    const [vulns] = await new OsvClient().vulnerabilities([{ name: 'lodash', version: '4.17.20' }]);
    expect(vulns?.map((v) => v.id)).toContain('GHSA-35jh-r3h4-6jhm');
  });
});
