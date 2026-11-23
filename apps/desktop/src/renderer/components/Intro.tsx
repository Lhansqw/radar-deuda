import { useCallback, useEffect, useRef, useState } from 'react';
import { tr } from '../i18n.js';

/** Si el video no termina (no carga, se queda parado), la intro se quita igual. */
const MAX_MS = 12_000;
const FADE_MS = 400;

/**
 * Video de introducción al abrir la aplicación, en el tema claro u oscuro. Va
 * encima de la interfaz, que sigue cargando debajo, y se salta con un clic,
 * Esc o Enter. Sin sonido; con movimiento reducido no se muestra.
 */
export function Intro({ onDone }: { onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  const done = useRef(false);
  const [src] = useState(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? './intro/intro-dark.mp4' : './intro/intro-light.mp4',
  );

  const finish = useCallback((): void => {
    if (done.current) return;
    done.current = true;
    setLeaving(true);
  }, []);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onDone();
      return;
    }
    const timer = window.setTimeout(finish, MAX_MS);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || e.key === 'Enter') finish();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, [onDone, finish]);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(onDone, FADE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, onDone]);

  return (
    <div className={leaving ? 'intro intro--saliendo' : 'intro'} onClick={finish}>
      <video src={src} autoPlay muted playsInline aria-label={tr('Introducción', 'Intro')} onEnded={finish} onError={finish} />
    </div>
  );
}
