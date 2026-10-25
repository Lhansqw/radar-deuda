/**
 * Cliente HTTP mínimo y prudente para las APIs públicas que usa la
 * aplicación. Tiempo límite por intento, reintentos solo para errores
 * transitorios (red, 429, 5xx) con espera exponencial y respeto de
 * Retry-After, y límite de tamaño de la respuesta.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  retries?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  /** Espera entre reintentos; inyectable para pruebas. */
  sleep?: (ms: number) => Promise<void>;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly headers: Headers,
    readonly body: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function retryDelay(attempt: number, headers?: Headers): number {
  const retryAfter = headers?.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 60_000);
  }
  return Math.min(500 * 2 ** attempt, 8_000);
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new Error(`Respuesta demasiado grande (${declared} bytes; límite ${maxBytes}).`);
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Respuesta demasiado grande (más de ${maxBytes} bytes).`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function requestText(url: string, init: RequestInit = {}, options: HttpOptions = {}): Promise<{ status: number; headers: Headers; text: string }> {
  const { fetch: doFetch = globalThis.fetch, timeoutMs = 20_000, retries = 3, maxBytes = 20 * 1024 * 1024, signal, sleep = defaultSleep } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await doFetch(url, { ...init, signal: combined, redirect: 'follow' });
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
      if (attempt < retries) {
        await sleep(retryDelay(attempt));
        continue;
      }
      break;
    }
    const text = await readLimited(res, maxBytes);
    const transient = res.status === 429 || (res.status >= 500 && res.status <= 599);
    if (transient && attempt < retries) {
      lastError = new HttpError(`HTTP ${res.status}`, res.status, res.headers, text);
      await sleep(retryDelay(attempt, res.headers));
      continue;
    }
    if (!res.ok) throw new HttpError(`HTTP ${res.status} en ${new URL(url).host}`, res.status, res.headers, text.slice(0, 2000));
    return { status: res.status, headers: res.headers, text };
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`No se pudo contactar con ${new URL(url).host}: ${reason}`, { cause: lastError });
}

export async function requestJson<T>(url: string, init: RequestInit = {}, options: HttpOptions = {}): Promise<{ data: T; headers: Headers }> {
  const { text, headers } = await requestText(url, init, options);
  try {
    return { data: JSON.parse(text) as T, headers };
  } catch (err) {
    throw new Error(`Respuesta no válida de ${new URL(url).host}: no es JSON.`, { cause: err });
  }
}
