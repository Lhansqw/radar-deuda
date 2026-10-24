import { createHash } from 'node:crypto';
import type { AnalysisConfig, Thresholds } from './types.js';

export const ENGINE_VERSION = '0.1.0';

/** Directorios que nunca se recorren (se podan sin descender). */
export const ALWAYS_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  'jspm_packages',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'vendor',
]);

export const DEFAULT_THRESHOLDS: Thresholds = {
  cognitive: 15,
  cyclomatic: 10,
  functionLines: 60,
  parameters: 5,
  nesting: 4,
  fileLines: 500,
  duplicationMinTokens: 60,
  duplicationMinLines: 6,
  fanOut: 20,
};

export const DEFAULT_CONFIG: AnalysisConfig = {
  exclude: ['*.min.js', '*.min.css', '*.map', '*.d.ts', '*.snap'],
  respectGitignore: true,
  maxFileSizeBytes: 1024 * 1024,
  hardMaxFileSizeBytes: 20 * 1024 * 1024,
  concurrency: 8,
  thresholds: DEFAULT_THRESHOLDS,
};

export interface ConfigOverrides {
  exclude?: string[];
  respectGitignore?: boolean;
  maxFileSizeBytes?: number;
  hardMaxFileSizeBytes?: number;
  concurrency?: number;
  thresholds?: Partial<Thresholds>;
}

export function resolveConfig(overrides: ConfigOverrides = {}): AnalysisConfig {
  const config: AnalysisConfig = {
    exclude: [...DEFAULT_CONFIG.exclude, ...(overrides.exclude ?? [])],
    respectGitignore: overrides.respectGitignore ?? DEFAULT_CONFIG.respectGitignore,
    maxFileSizeBytes: overrides.maxFileSizeBytes ?? DEFAULT_CONFIG.maxFileSizeBytes,
    hardMaxFileSizeBytes: overrides.hardMaxFileSizeBytes ?? DEFAULT_CONFIG.hardMaxFileSizeBytes,
    concurrency: overrides.concurrency ?? DEFAULT_CONFIG.concurrency,
    thresholds: { ...DEFAULT_THRESHOLDS, ...(overrides.thresholds ?? {}) },
  };
  validateConfig(config);
  return config;
}

function validateConfig(config: AnalysisConfig): void {
  const positiveInt = (name: string, value: number): void => {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`Configuración inválida: ${name} debe ser un entero positivo (recibido ${value}).`);
    }
  };
  positiveInt('concurrency', config.concurrency);
  positiveInt('maxFileSizeBytes', config.maxFileSizeBytes);
  positiveInt('hardMaxFileSizeBytes', config.hardMaxFileSizeBytes);
  if (config.concurrency > 64) throw new RangeError('Configuración inválida: concurrency no puede superar 64.');
  if (config.maxFileSizeBytes > config.hardMaxFileSizeBytes) {
    throw new RangeError('Configuración inválida: maxFileSizeBytes no puede superar hardMaxFileSizeBytes.');
  }
  for (const [key, value] of Object.entries(config.thresholds)) positiveInt(`thresholds.${key}`, value);
}

/** Huella de la configuración que afecta a los resultados (invalida la caché si cambia). */
export function configHash(config: AnalysisConfig): string {
  const relevant = {
    exclude: config.exclude,
    respectGitignore: config.respectGitignore,
    maxFileSizeBytes: config.maxFileSizeBytes,
    thresholds: config.thresholds,
  };
  return createHash('sha1').update(JSON.stringify(relevant)).digest('hex').slice(0, 16);
}
