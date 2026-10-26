import { describe, expect, it } from 'vitest';

describe('ejecución normal de las pruebas', () => {
  it('anula las variables que activan las pruebas que usan la red o modelos reales', () => {
    // Si alguien deja $env:RADAR_LIVE_LLM definido en la terminal, npm run check no debe salir a la red.
    expect(process.env['RADAR_LIVE']).toBe('');
    expect(process.env['RADAR_LIVE_LLM']).toBe('');
  });
});
