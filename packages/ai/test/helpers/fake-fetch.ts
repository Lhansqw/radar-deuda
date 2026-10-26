import type { FetchLike } from '@radar/sources';

export interface FakeCall {
  url: string;
  init: RequestInit | undefined;
}

type Responder = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

/** `fetch` simulado que registra las llamadas y responde según `responder`. */
export function fakeFetch(responder: Responder): FetchLike & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return responder(url, init);
  };
  return Object.assign(fn, { calls });
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const noSleep = async (): Promise<void> => {};
