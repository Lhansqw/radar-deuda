/**
 * Benchmark del motor sobre repositorios sintéticos (pequeño, mediano, grande).
 *
 *   npm run bench                 # pequeño y mediano
 *   npm run bench -- --large      # incluye el grande (≈5 000 archivos)
 *
 * Cada medición se ejecuta en un proceso Node nuevo sobre el código compilado,
 * para que la RAM pico sea la del análisis y no la de tsx o de mediciones previas.
 * Sale con código 1 si no se cumple algún objetivo de docs/ARQUITECTURA.md §6.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineDir = path.join(here, '..');
const repoRoot = path.join(engineDir, '..', '..');

interface Scenario {
  name: string;
  files: number;
  /** Objetivos: tiempo en frío (ms), RAM pico (MB). */
  maxColdMs: number;
  maxRssMb: number;
}

const SCENARIOS: Scenario[] = [
  { name: 'pequeño', files: 100, maxColdMs: 1_000, maxRssMb: 256 },
  { name: 'mediano', files: 1_000, maxColdMs: 10_000, maxRssMb: 512 },
  { name: 'grande', files: 5_000, maxColdMs: 50_000, maxRssMb: 1_024 },
];
/** El reanálisis sin cambios debe costar como mucho esta fracción del análisis en frío. */
const MAX_WARM_RATIO = 0.25;

/** Generador pseudoaleatorio determinista (mulberry32): mismos repositorios en cada ejecución. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SHARED_BLOCK = `
  const resultado: string[] = [];
  for (const item of entrada) {
    if (item.activo && item.cantidad > 0) {
      resultado.push(\`\${item.codigo}:\${item.cantidad * item.precio}\`);
    } else if (item.cantidad === 0) {
      resultado.push(\`\${item.codigo}:agotado\`);
    }
  }
  return resultado.sort().join(';');`;

/** Archivo TypeScript de ~100 líneas con funciones, ramas, importaciones y algo de duplicación. */
function syntheticFile(i: number, total: number, rand: () => number): string {
  const lines: string[] = [];
  const imports = Math.floor(rand() * 4);
  for (let k = 0; k < imports; k++) {
    const target = Math.floor(rand() * total);
    if (target !== i) lines.push(`import { f${target}_0 } from '../m${Math.floor(target / 100)}/archivo${target}';`);
  }
  lines.push('', `export interface Item${i} { codigo: string; cantidad: number; precio: number; activo: boolean }`, '');
  const functions = 4 + Math.floor(rand() * 4);
  for (let f = 0; f < functions; f++) {
    lines.push(`/** Función ${f} del módulo ${i}. */`);
    lines.push(`export function f${i}_${f}(entrada: Item${i}[], umbral: number): string {`);
    if (rand() < 0.08) {
      lines.push(SHARED_BLOCK);
    } else {
      const depth = 1 + Math.floor(rand() * (rand() < 0.1 ? 6 : 3));
      lines.push('  let total = 0;');
      for (let d = 0; d < depth; d++) lines.push(`${'  '.repeat(d + 1)}for (const x${d} of entrada) {`, `${'  '.repeat(d + 2)}if (x${d}.cantidad > umbral + ${d}) {`);
      lines.push(`${'  '.repeat(depth + 2)}total += ${Math.floor(rand() * 100)};`);
      for (let d = depth - 1; d >= 0; d--) lines.push(`${'  '.repeat(d + 2)}}`, `${'  '.repeat(d + 1)}}`);
      lines.push(`  return total > ${Math.floor(rand() * 1000)} ? 'alto' : 'bajo';`);
    }
    lines.push('}', '');
  }
  if (rand() < 0.05) lines.push('// TODO: revisar esta lógica');
  return lines.join('\n');
}

async function generate(dir: string, files: number, seed: number): Promise<number> {
  const rand = rng(seed);
  let lines = 0;
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'sintetico', dependencies: { lodash: '^4.17.21' } }));
  for (let i = 0; i < files; i++) {
    const sub = path.join(dir, 'src', `m${Math.floor(i / 100)}`);
    await mkdir(sub, { recursive: true });
    const text = syntheticFile(i, files, rand);
    lines += text.split('\n').length;
    await writeFile(path.join(sub, `archivo${i}.ts`), text);
  }
  return lines;
}

interface RunResult {
  durationMs: number;
  cpuMs: number;
  peakRssMb: number;
  filesAnalyzed: number;
  cacheHits: number;
  findings: number;
  score: number;
}

function runOnce(root: string, cacheDir: string): RunResult {
  const runner = `
    const { analyzeRepository } = await import(${JSON.stringify(path.join(engineDir, 'dist', 'index.js').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'))});
    const r = await analyzeRepository(${JSON.stringify(root)}, { cacheDir: ${JSON.stringify(cacheDir)} });
    console.log(JSON.stringify({
      durationMs: r.stats.durationMs, cpuMs: r.stats.cpuUserMs + r.stats.cpuSystemMs, peakRssMb: r.stats.peakRssMb,
      filesAnalyzed: r.stats.filesAnalyzed, cacheHits: r.stats.cacheHits, findings: r.findings.length, score: r.score.score,
    }));`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', runner], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`El análisis falló:\n${res.stderr}`);
  return JSON.parse(res.stdout.trim().split('\n').pop() as string) as RunResult;
}

async function main(): Promise<number> {
  const includeLarge = process.argv.includes('--large');
  console.log('Compilando el motor…');
  execFileSync(process.execPath, [path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(engineDir, 'tsconfig.build.json')], { stdio: 'inherit' });

  const rows: Array<Record<string, string | number>> = [];
  let failed = false;
  for (const sc of SCENARIOS) {
    if (sc.name === 'grande' && !includeLarge) continue;
    const base = await mkdtemp(path.join(os.tmpdir(), 'radar-bench-'));
    const repo = path.join(base, 'repo');
    const cache = path.join(base, 'cache');
    await mkdir(repo);
    try {
      const lines = await generate(repo, sc.files, 42);
      const cold = runOnce(repo, cache);
      const warm = runOnce(repo, cache);
      const warmRatio = warm.durationMs / Math.max(cold.durationMs, 1);
      const ok = cold.durationMs <= sc.maxColdMs && cold.peakRssMb <= sc.maxRssMb && warmRatio <= MAX_WARM_RATIO && warm.cacheHits === sc.files + 1;
      failed ||= !ok;
      rows.push({
        escenario: sc.name,
        archivos: sc.files,
        líneas: lines,
        'frío ms': cold.durationMs,
        'CPU frío ms': cold.cpuMs,
        'RAM pico MB': cold.peakRssMb,
        'caliente ms': warm.durationMs,
        'caliente/frío': `${Math.round(warmRatio * 100)} %`,
        hallazgos: cold.findings,
        objetivo: ok ? 'cumplido' : `NO (≤ ${sc.maxColdMs} ms, ≤ ${sc.maxRssMb} MB, ≤ ${MAX_WARM_RATIO * 100} %)`,
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }

  console.table(rows);
  const outDir = path.join(repoRoot, 'bench-results');
  await mkdir(outDir, { recursive: true });
  const out = path.join(outDir, `bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(out, JSON.stringify({ node: process.version, platform: `${process.platform}-${process.arch}`, cpus: os.cpus().length, rows }, null, 2));
  console.log(`Resultados guardados en ${out}`);
  return failed ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err);
    process.exitCode = 2;
  },
);
