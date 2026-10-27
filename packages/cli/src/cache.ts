import { parseArgs } from 'node:util';
import { defaultCacheDir } from '@radar/engine';
import { cacheUsage, clearCache, pruneCache } from '@radar/pipeline';

export const CACHE_HELP = `
Uso: npm run cache -- [--limpiar [días] | --vaciar]

Muestra cuánto ocupa la caché de Radar de Deuda Técnica (la comparten la CLI y la
aplicación) en ${defaultCacheDir()} (RADAR_CACHE_DIR la cambia).

  --limpiar [días]   Borra lo que no se ha usado en ese tiempo (por defecto 90 días)
  --vaciar           Borra toda la caché. El siguiente análisis de cada proyecto será completo
  -h, --help         Muestra esta ayuda

Los clones de GitHub no se tocan. Solo se borran archivos creados por la herramienta.
`;

export type CacheCommand = { kind: 'show' } | { kind: 'prune'; days: number } | { kind: 'clear' } | { kind: 'help' } | { kind: 'error'; message: string };

export function parseCacheArgs(argv: string[]): CacheCommand {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { limpiar: { type: 'boolean', default: false }, vaciar: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false } } });
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
  const { values: v, positionals } = parsed;
  if (v.help) return { kind: 'help' };
  if (v.limpiar && v.vaciar) return { kind: 'error', message: '--limpiar y --vaciar son incompatibles.' };
  if (v.vaciar) return positionals.length === 0 ? { kind: 'clear' } : { kind: 'error', message: '--vaciar no admite argumentos.' };
  if (v.limpiar) {
    const days = positionals[0] === undefined ? 90 : Number(positionals[0]);
    if (positionals.length > 1 || !Number.isInteger(days) || days < 1) return { kind: 'error', message: 'Indica los días como un entero positivo (p. ej. --limpiar 30).' };
    return { kind: 'prune', days };
  }
  return positionals.length === 0 ? { kind: 'show' } : { kind: 'error', message: `Argumento inesperado: ${positionals[0]}` };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

export async function runCache(cmd: Exclude<CacheCommand, { kind: 'help' | 'error' }>, cacheBase = defaultCacheDir()): Promise<string> {
  if (cmd.kind === 'clear') {
    const r = await clearCache(cacheBase);
    return `Caché vaciada: ${r.files} archivo(s), ${formatBytes(r.bytes)} liberados.`;
  }
  if (cmd.kind === 'prune') {
    const r = await pruneCache(cacheBase, cmd.days);
    return `Borrados ${r.files} archivo(s) sin usar en ${cmd.days} días: ${formatBytes(r.bytes)} liberados.`;
  }
  const u = await cacheUsage(cacheBase);
  const lines = [`Caché en ${cacheBase}: ${formatBytes(u.bytes)} en ${u.files} archivo(s).`];
  for (const p of u.parts) lines.push(`  ${p.label.padEnd(30)} ${formatBytes(p.bytes).padStart(10)}  (${p.files})`);
  return lines.join('\n');
}
