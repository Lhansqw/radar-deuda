import { useCallback, useEffect, useState } from 'react';
import type { AccountState } from '../shared/account.js';
import { App } from './App.js';
import { Intro } from './components/Intro.js';
import { Access } from './views/Access.js';
import { CloudMissing } from './views/CloudMissing.js';

/**
 * Raíz de la interfaz: sin sesión, el acceso; con sesión, la aplicación.
 *
 * Al cerrarse la sesión (por el usuario o porque caducó) se recarga la
 * página: así no queda en memoria nada del usuario anterior.
 */
export function Root() {
  const [state, setState] = useState<AccountState | null>(null);
  const [introDone, setIntroDone] = useState(false);
  const endIntro = useCallback(() => setIntroDone(true), []);

  useEffect(() => {
    let signedIn = false;
    const apply = (s: AccountState): void => {
      if (signedIn && s.status !== 'signed-in') {
        window.location.reload();
        return;
      }
      signedIn = s.status === 'signed-in';
      setState(s);
    };
    const stop = window.radar.account.onChange(apply);
    void window.radar.account.state().then(apply);
    return stop;
  }, []);

  return (
    <>
      {screen(state)}
      {!introDone && <Intro onDone={endIntro} />}
    </>
  );
}

function screen(state: AccountState | null) {
  if (!state) return <div className="access" />;
  if (state.status === 'signed-in') return <App account={state} />;
  if (state.status === 'unconfigured') return <CloudMissing message={state.message} />;
  return <Access state={state} />;
}
