import type { CompletionRequest, CompletionResult, LlmProvider, Locality } from '../../src/provider.js';

type Reply = (req: CompletionRequest) => Partial<CompletionResult> & { text: string };

/** Proveedor simulado que registra todas las peticiones (para comprobar qué sale del equipo). */
export function fakeProvider(reply: Reply, locality: Locality = 'local', id = 'falso'): LlmProvider & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  return {
    id,
    label: `Proveedor ${id}`,
    locality,
    calls,
    async complete(req) {
      calls.push(req);
      const r = reply(req);
      return { model: 'modelo-falso', finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 50 }, latencyMs: 5, ...r };
    },
  };
}

/** Respuesta válida y prudente para el hallazgo cuyo id aparece en la petición. */
export function goodExplanation(req: CompletionRequest): { text: string } {
  const all = req.messages.map((m) => m.content).join('\n');
  const id = /El id del hallazgo es "([^"]+)"/.exec(all)?.[1] ?? '';
  return {
    text: JSON.stringify({
      id_hallazgo: id,
      resumen: 'El problema dificulta el mantenimiento.',
      causa_raiz: 'Probablemente creció sin refactorizar.',
      recomendacion: 'Dividir en funciones más pequeñas con pruebas.',
      afirmaciones: [{ tipo: 'recomendacion', texto: 'Añadir pruebas antes de refactorizar.', archivo: '', linea_inicio: 0, linea_fin: 0 }],
      confianza: 'media',
      informacion_insuficiente: false,
    }),
  };
}

/** Plan que agrupa todos los ids recibidos en un paso. */
export function goodPlan(req: CompletionRequest): { text: string } {
  const ids = [...(req.messages[0]?.content ?? '').matchAll(/id=(\S+)/g)].map((m) => m[1]);
  return { text: JSON.stringify({ pasos: [{ hallazgos: ids, horizonte: 'corto', titulo: 'Reducir la deuda principal', justificacion: 'Mayor impacto primero.' }], notas: [] }) };
}
