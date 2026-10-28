import { HttpError } from '@radar/sources';
import { ProviderError, type PreflightPlan } from '../provider.js';
import { OpenRouterProvider, type OpenRouterKeyStatus, type OpenRouterOptions } from './openrouter.js';

/**
 * IA incluida (fase 14): modelos gratuitos de OpenRouter sin que el usuario
 * configure ninguna clave. La aplicación no lleva la clave (se podría sacar
 * del instalador): la guarda el proyecto de Supabase, y su función «ia»
 * (supabase/functions/ia) reenvía las consultas a OpenRouter tras comprobar la
 * sesión del usuario, que solo pide modelos gratuitos y que no pasa de su cupo
 * diario. Habla la misma API que OpenRouter, así que este proveedor es el de
 * OpenRouter apuntando a la función, con el token de la sesión como credencial.
 */

/** Modelo que elige el servidor (los gratuitos que configuró el dueño del proyecto). */
export const INCLUDED_DEFAULT_MODEL = 'radar/predeterminado';

export interface IncludedAiOptions extends Omit<OpenRouterOptions, 'apiKey' | 'baseUrl' | 'id' | 'label' | 'validateKey' | 'allowDataCollection' | 'zeroDataRetention'> {
  /** https://<proyecto>.supabase.co/functions/v1/ia */
  baseUrl: string;
  /** Token de acceso de la sesión del usuario en Supabase. */
  sessionToken: string;
}

export class IncludedAiProvider extends OpenRouterProvider {
  constructor(options: IncludedAiOptions) {
    const { sessionToken, ...rest } = options;
    if (!sessionToken) throw new ProviderError('Inicia sesión para usar la IA incluida.', 'auth', 'incluida');
    // Los proveedores de los modelos gratuitos suelen guardar lo que reciben: hay que permitirlo
    // (la privacidad «solo metadatos», la de la nube por defecto, no envía código).
    super({ ...rest, apiKey: sessionToken, id: 'incluida', label: 'IA incluida', validateKey: false, allowDataCollection: true });
  }

  /** Cupo de hoy (la función responde como la API /key de OpenRouter). */
  override async keyStatus(signal?: AbortSignal): Promise<OpenRouterKeyStatus> {
    try {
      return await super.keyStatus(signal);
    } catch (err) {
      throw this.explain(err instanceof ProviderError && err.cause ? err.cause : err);
    }
  }

  /** Antes de un análisis: si ya no queda cupo, se dice; si no alcanza, se avisa. */
  override async preflight(plan: PreflightPlan, signal?: AbortSignal): Promise<string[]> {
    let status: OpenRouterKeyStatus;
    try {
      status = await this.keyStatus(signal);
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'auth') throw err;
      if (signal?.aborted) throw err;
      return []; // Si no responde, las consultas informarán del problema.
    }
    const daily = status.freeDaily;
    if (!daily) return [];
    if (daily.remaining <= 0) throw new ProviderError(quotaMessage(daily.limit), 'rate-limit', this.id);
    return daily.remaining < plan.requests ? [`Te quedan ${daily.remaining} consultas de IA incluida hoy y este análisis prevé ${plan.requests}: puede quedar incompleto.`] : [];
  }

  protected override explain(err: unknown): ProviderError {
    if (err instanceof HttpError) {
      if (err.status === 401) return new ProviderError('La sesión caducó: vuelve a iniciar sesión para usar la IA incluida.', 'auth', this.id, { cause: err });
      // La función explica sus propios rechazos (cupo agotado, modelo no gratuito) en español.
      const own = serverMessage(err.body);
      if (own && (err.status === 429 || err.status === 400 || err.status === 503)) return new ProviderError(own, err.status === 429 ? 'rate-limit' : err.status === 503 ? 'unavailable' : 'invalid-request', this.id, { cause: err });
      if (err.status === 404 && /functions|not found/i.test(err.body) && !/endpoint|provider/i.test(err.body)) {
        return new ProviderError('La IA incluida no está instalada en el proyecto de Supabase (falta la función «ia»; ver docs/IA-INCLUIDA.md).', 'unavailable', this.id, { cause: err });
      }
    }
    return super.explain(err);
  }
}

/** Mensaje cuando se agotó el cupo diario. */
export function quotaMessage(limit: number): string {
  return `Usaste las ${limit} consultas de IA incluida de hoy. Se renuevan a las 00:00 UTC (las 7 de la tarde en Colombia). Si necesitas más, puedes usar tu propia clave en Configuración → Inteligencia artificial.`;
}

/** Mensaje de error de la función ({ error: { message } }), si lo hay. */
function serverMessage(body: string): string | null {
  try {
    const m = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
    return typeof m === 'string' && m.trim() !== '' ? m.slice(0, 500) : null;
  } catch {
    return null;
  }
}
