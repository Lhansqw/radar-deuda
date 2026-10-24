import { describe, expect, it } from 'vitest';
import { sizeAnalyzer } from '../src/analyzers/size.js';
import { severityByRatio } from '../src/analyzers/shared.js';
import { resolveConfig } from '../src/config.js';
import { fileInput } from './helpers/file-input.js';

const config = resolveConfig({ thresholds: { fileLines: 10 } });

describe('sizeAnalyzer', () => {
  it('cuenta solo líneas con contenido y no reporta por debajo del umbral', () => {
    const text = Array.from({ length: 10 }, (_, i) => `const v${i} = ${i};\n\n`).join('');
    const result = sizeAnalyzer.analyze(fileInput('a.ts', text), config);
    expect(result.artifact).toEqual({ codeLines: 10 });
    expect(result.findings).toEqual([]);
  });

  it('reporta archivos grandes con la métrica como evidencia y la ubicación completa', () => {
    const text = Array.from({ length: 25 }, (_, i) => `const v${i} = ${i};`).join('\n\n');
    const [f] = sizeAnalyzer.analyze(fileInput('src/grande.ts', text), config).findings;
    expect(f?.ruleId).toBe('size/large-file');
    expect(f?.severity).toBe('high'); // 25 / 10 = 2,5× el umbral
    expect(f?.evidence[0]?.metric).toMatchObject({ name: 'codeLines', value: 25, threshold: 10 });
    expect(f?.locations[0]).toEqual({ file: 'src/grande.ts', startLine: 1, endLine: 49 });
  });

  it('solo aplica a archivos de código', () => {
    expect(sizeAnalyzer.supports(fileInput('README.md', '').meta)).toBe(false);
    expect(sizeAnalyzer.supports(fileInput('main.py', '').meta)).toBe(true);
  });
});

describe('severityByRatio', () => {
  it.each([
    [11, 10, 'medium'],
    [20, 10, 'high'],
    [40, 10, 'critical'],
  ] as const)('%d sobre umbral %d → %s', (value, threshold, expected) => {
    expect(severityByRatio(value, threshold)).toBe(expected);
  });

  it('respeta la severidad máxima', () => {
    expect(severityByRatio(100, 10, 'high')).toBe('high');
  });
});
