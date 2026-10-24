import type { FinalizeStore } from '../../src/types.js';

/** Almacén en memoria que cuenta lecturas y escrituras. */
export function memoryStore(): FinalizeStore & { data: Map<string, unknown>; hits: number; writes: number } {
  const data = new Map<string, unknown>();
  const store = {
    data,
    hits: 0,
    writes: 0,
    get(key: string): unknown {
      if (data.has(key)) store.hits++;
      return data.get(key);
    },
    set(key: string, value: unknown): void {
      store.writes++;
      data.set(key, value);
    },
  };
  return store;
}
