import { useCallback, useState } from 'react';
import { errorMessage } from '../../shared/errors.js';

/**
 * Ejecuta una acción del usuario: marca «ocupado», borra el error anterior y,
 * si falla, guarda su mensaje. Se separa del hook para probarla sin React.
 */
export async function runAction(fn: () => Promise<unknown>, setBusy: (busy: boolean) => void, setError: (error: string | null) => void): Promise<void> {
  setBusy(true);
  setError(null);
  try {
    await fn();
  } catch (err) {
    setError(errorMessage(err));
  } finally {
    setBusy(false);
  }
}

/** Estado de una acción con botón: `busy` mientras se ejecuta y `error` si falló. */
export function useAction(): {
  busy: boolean;
  error: string | null;
  setError: (error: string | null) => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback((fn: () => Promise<unknown>) => runAction(fn, setBusy, setError), []);
  return { busy, error, setError, run };
}
