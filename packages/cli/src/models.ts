/**
 * `npm run models`: lista los modelos de OpenRouter que sirven para la capa de
 * IA, para elegir --ai-model y --ai-fallback sin salir de la terminal.
 */
import { parseArgs } from 'node:util';
import { fetchOpenRouterModels, type OpenRouterModel } from '@radar/ai';
import type { FetchLike } from '@radar/sources';

export const MODELS_HELP = `
Uso: npm run models -- [opciones]

Lista los modelos de OpenRouter compatibles con el análisis con IA
(salida estructurada), del más barato al más caro.

  --gratis                Solo modelos gratuitos (:free o precio cero)
  --sin-razonamiento      Excluye los modelos que no permiten desactivar el razonamiento
  --buscar <texto>        Filtra por id o nombre (p. ej. --buscar qwen)
  --todos                 Incluye también los que no admiten salida estructurada
  --max <n>               Cuántos mostrar (por defecto 25)
  -h, --help              Muestra esta ayuda

No necesita clave. Si RADAR_OPENROUTER_API_KEY está definida, se usa.
`;

export interface ModelsOptions {
  free: boolean;
  noMandatoryReasoning: boolean;
  search?: string;
  all: boolean;
  max: number;
}

export function parseModelsArgs(argv: string[]): { kind: 'run'; options: ModelsOptions } | { kind: 'help' } | { kind: 'error'; message: string } {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        gratis: { type: 'boolean', default: false },
        'sin-razonamiento': { type: 'boolean', default: false },
        buscar: { type: 'string' },
        todos: { type: 'boolean', default: false },
        max: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
  const v = parsed.values;
  if (v.help) return { kind: 'help' };
  const max = v.max !== undefined ? Number(v.max) : 25;
  if (!Number.isInteger(max) || max < 1 || max > 500) return { kind: 'error', message: '--max debe ser un entero entre 1 y 500.' };
  return {
    kind: 'run',
    options: {
      free: v.gratis,
      noMandatoryReasoning: v['sin-razonamiento'],
      all: v.todos,
      max,
      ...(v.buscar ? { search: v.buscar.toLowerCase() } : {}),
    },
  };
}

/** Filtra y ordena: del más barato (salida, luego entrada) al más caro; a igual precio, mayor contexto primero. */
export function selectModels(models: readonly OpenRouterModel[], o: ModelsOptions): OpenRouterModel[] {
  return models
    .filter((m) => o.all || m.structuredOutputs)
    .filter((m) => !o.free || m.free)
    .filter((m) => !o.noMandatoryReasoning || !m.reasoning?.mandatory)
    .filter((m) => !o.search || m.id.toLowerCase().includes(o.search) || m.name.toLowerCase().includes(o.search))
    .sort(
      (a, b) =>
        (a.price?.outputPerMTok ?? Infinity) - (b.price?.outputPerMTok ?? Infinity) ||
        (a.price?.inputPerMTok ?? Infinity) - (b.price?.inputPerMTok ?? Infinity) ||
        (b.contextLength ?? 0) - (a.contextLength ?? 0) ||
        a.id.localeCompare(b.id),
    );
}

function priceText(m: OpenRouterModel): string {
  if (m.free) return 'gratis';
  if (!m.price) return '?';
  const f = (n: number): string => (n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n.toFixed(2));
  return `${f(m.price.inputPerMTok)} / ${f(m.price.outputPerMTok)}`;
}

function reasoningText(m: OpenRouterModel): string {
  if (!m.reasoning) return 'no';
  if (!m.supportedParameters.includes('reasoning')) return 'sí, no ajustable';
  return m.reasoning.mandatory ? 'obligatorio' : 'desactivable';
}

function contextText(n: number | null): string {
  if (n === null) return '?';
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M` : `${Math.round(n / 1000)}k`;
}

export function formatModels(selected: readonly OpenRouterModel[], total: number, o: ModelsOptions): string {
  if (selected.length === 0) return 'Ningún modelo cumple esos filtros. Prueba sin --gratis o sin --sin-razonamiento.';
  const shown = selected.slice(0, o.max);
  const rows = shown.map((m) => [m.id, priceText(m), contextText(m.contextLength), reasoningText(m), ...(o.all ? [m.structuredOutputs ? 'sí' : 'no'] : [])]);
  const header = ['Modelo', 'USD/M entrada / salida', 'Contexto', 'Razonamiento', ...(o.all ? ['Salida estruct.'] : [])];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  const out = [line(header), widths.map((w) => '─'.repeat(w)).join('  '), ...rows.map(line)];
  out.push('', `${shown.length} de ${selected.length} modelo(s) que cumplen los filtros (${total} en el catálogo).`);
  // Sugerencia: el primero que no obliga a razonar, con dos respaldos del mismo tipo (gratis con gratis).
  const usable = selected.filter((m) => m.structuredOutputs && !m.reasoning?.mandatory);
  const main = usable[0];
  if (main) {
    const backups = usable.filter((m) => m !== main && m.free === main.free).slice(0, 2);
    out.push('', 'Para usarlo en el análisis:', `  npm run analyze -- <carpeta> --ai openrouter --ai-model ${main.id}${backups.length > 0 ? ` --ai-fallback ${backups.map((m) => m.id).join(',')}` : ''}${main.free ? ' --ai-allow-data-collection' : ''}`);
    if (main.free) out.push('  Los modelos gratuitos suelen requerir --ai-allow-data-collection (solo se envían metadatos) y tienen un límite de peticiones diarias.');
  }
  return out.join('\n');
}

export async function runModels(o: ModelsOptions, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal, fetch?: FetchLike): Promise<string> {
  const key = (env['RADAR_OPENROUTER_API_KEY'] ?? '').trim();
  const models = await fetchOpenRouterModels({
    headers: { 'user-agent': 'radar-deuda', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    ...(signal ? { signal } : {}),
    ...(fetch ? { fetch } : {}),
  });
  return formatModels(selectModels(models, o), models.length, o);
}
