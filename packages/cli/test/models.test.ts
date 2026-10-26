import { describe, expect, it } from 'vitest';
import { formatModels, parseModelsArgs, runModels, selectModels, type ModelsOptions } from '../src/models.js';

const catalog = {
  data: [
    { id: 'caro/grande', name: 'Grande', context_length: 1_000_000, pricing: { prompt: '0.000003', completion: '0.000015' }, supported_parameters: ['structured_outputs'] },
    { id: 'barato/rapido', name: 'Rápido', context_length: 128_000, pricing: { prompt: '0.0000001', completion: '0.0000004' }, supported_parameters: ['structured_outputs', 'reasoning'], reasoning: { mandatory: false } },
    { id: 'libre/a:free', name: 'Libre A', context_length: 32_000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['structured_outputs'] },
    { id: 'libre/b:free', name: 'Libre B', context_length: 64_000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['structured_outputs', 'reasoning'], reasoning: { mandatory: true } },
    { id: 'libre/c:free', name: 'Libre C', context_length: 16_000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['structured_outputs'] },
    { id: 'sin/estructura', name: 'Texto', context_length: 8_000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['temperature'] },
  ],
};
const opts = (o: Partial<ModelsOptions> = {}): ModelsOptions => ({ free: false, noMandatoryReasoning: false, all: false, max: 25, ...o });

describe('npm run models', () => {
  it('interpreta las opciones', () => {
    expect(parseModelsArgs(['--gratis', '--buscar', 'Qwen', '--max', '5'])).toEqual({ kind: 'run', options: { free: true, noMandatoryReasoning: false, all: false, max: 5, search: 'qwen' } });
    expect(parseModelsArgs(['--max', '0'])).toMatchObject({ kind: 'error' });
    expect(parseModelsArgs(['--desconocida'])).toMatchObject({ kind: 'error' });
    expect(parseModelsArgs(['-h'])).toEqual({ kind: 'help' });
  });

  it('lista solo los compatibles, del más barato al más caro, y sugiere cómo usarlos', async () => {
    const urls: string[] = [];
    const headers: Array<Record<string, string>> = [];
    const fetch = async (url: string, init?: RequestInit) => {
      urls.push(url);
      headers.push(init?.headers as Record<string, string>);
      return Response.json(catalog);
    };
    const text = await runModels(opts({ free: true }), {}, undefined, fetch);
    expect(urls).toEqual(['https://openrouter.ai/api/v1/models']);
    expect(headers[0]?.['authorization']).toBeUndefined(); // sin clave también funciona
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^Modelo\s+USD\/M entrada \/ salida\s+Contexto\s+Razonamiento$/);
    expect(lines.slice(2, 5).map((l) => l.split(/\s+/)[0])).toEqual(['libre/b:free', 'libre/a:free', 'libre/c:free']); // a igual precio, más contexto primero
    expect(text).not.toContain('sin/estructura');
    expect(text).toContain('obligatorio');
    // La sugerencia evita el modelo que obliga a razonar y usa respaldos gratuitos.
    expect(text).toContain('--ai-model libre/a:free --ai-fallback libre/c:free --ai-allow-data-collection');
  });

  it('usa la clave si está definida', async () => {
    let auth: string | undefined;
    await runModels(opts(), { RADAR_OPENROUTER_API_KEY: ' sk-or-algo \n' }, undefined, async (_url, init) => {
      auth = (init?.headers as Record<string, string>)['authorization'];
      return Response.json(catalog);
    });
    expect(auth).toBe('Bearer sk-or-algo');
  });

  it('filtra por texto y por razonamiento, y con --todos muestra también los no compatibles', async () => {
    const models = await runModels(opts({ all: true }), {}, undefined, async () => Response.json(catalog));
    expect(models).toContain('sin/estructura');
    expect(models).toMatch(/Salida estruct\./);
    const { fetchOpenRouterModels } = await import('@radar/ai');
    const list = await fetchOpenRouterModels({ fetch: async () => Response.json(catalog) });
    expect(selectModels(list, opts({ search: 'rápido' })).map((m) => m.id)).toEqual(['barato/rapido']);
    expect(selectModels(list, opts({ free: true, noMandatoryReasoning: true })).map((m) => m.id)).toEqual(['libre/a:free', 'libre/c:free']);
    expect(selectModels(list, opts()).map((m) => m.id)).toEqual(['libre/b:free', 'libre/a:free', 'libre/c:free', 'barato/rapido', 'caro/grande']);
    expect(formatModels(selectModels(list, opts()), list.length, opts())).toMatch(/0\.10 \/ 0\.40\s+128k\s+desactivable/);
    expect(formatModels(selectModels(list, opts()), list.length, opts())).toMatch(/3\.0 \/ 15\s+1M\s+no/);
    expect(formatModels([], 6, opts())).toMatch(/Ningún modelo/);
  });
});
