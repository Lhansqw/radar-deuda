import { useEffect, useRef, useState } from 'react';

const reducedMotion = (): boolean => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Lleva un número desde su valor anterior (o cero, al montar) hasta `target`
 * en `ms` milisegundos, con salida suave. Con movimiento reducido devuelve el
 * valor final directamente.
 */
export function useCountUp(target: number, ms = 600): number {
  const [value, setValue] = useState(() => (reducedMotion() ? target : 0));
  const from = useRef(value);

  useEffect(() => {
    if (reducedMotion() || typeof requestAnimationFrame !== 'function') {
      from.current = target;
      setValue(target);
      return;
    }
    const start = from.current;
    let t0: number | null = null;
    let frame = requestAnimationFrame(function step(now) {
      t0 ??= now;
      const p = Math.min(1, (now - t0) / ms);
      const eased = 1 - (1 - p) ** 3;
      const v = Math.round(start + (target - start) * eased);
      from.current = v;
      setValue(v);
      if (p < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);

  return value;
}
