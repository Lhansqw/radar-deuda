// @vitest-environment happy-dom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { describeError, reportErrors } from '../../src/renderer/lib/report-errors.js';
import { Diagnostics } from '../../src/renderer/views/settings/Diagnostics.js';
import { mockRadar, type RadarOverrides } from './radar.js';

const TEXT = 'Radar de Deuda Técnica 0.1.0\n\nErrores recientes (1):\n2026-11-10T10:00:00.000Z [interfaz] Fallo';

function setup(app: RadarOverrides['app'] = {}) {
  const diagnostics = vi.fn(async () => TEXT);
  const copyText = vi.fn(async () => null);
  const clearErrors = vi.fn(async () => null);
  mockRadar({ app: { diagnostics, copyText, clearErrors, ...app } });
  render(<Diagnostics />);
  return { diagnostics, copyText, clearErrors, user: userEvent.setup() };
}

describe('Diagnóstico', () => {
  it('copia el diagnóstico y enseña qué se copió', async () => {
    const { copyText, user } = setup();
    expect(screen.queryByLabelText('Diagnóstico')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Copiar diagnóstico' }));
    expect(copyText).toHaveBeenCalledWith(TEXT);
    expect(await screen.findByRole('status')).toHaveTextContent('Diagnóstico copiado.');
    expect(screen.getByLabelText('Diagnóstico')).toHaveTextContent('[interfaz] Fallo');
  });

  it('se puede ver antes de copiar, sin copiar nada', async () => {
    const { copyText, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Ver qué se copia' }));
    expect(await screen.findByLabelText('Diagnóstico')).toHaveTextContent('Radar de Deuda Técnica 0.1.0');
    expect(copyText).not.toHaveBeenCalled();
  });

  it('borrar el registro vuelve a leer lo que se ve', async () => {
    const { diagnostics, clearErrors, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Ver qué se copia' }));
    await screen.findByLabelText('Diagnóstico');
    diagnostics.mockResolvedValueOnce('Radar de Deuda Técnica 0.1.0\n\nSin errores registrados.');
    await user.click(screen.getByRole('button', { name: 'Borrar el registro' }));
    expect(clearErrors).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Registro de errores borrado.')).toBeInTheDocument();
    expect(screen.getByLabelText('Diagnóstico')).toHaveTextContent('Sin errores registrados.');
  });

  it('si no se puede copiar, lo dice', async () => {
    const { user } = setup({ copyText: async () => Promise.reject(new Error('Portapapeles no disponible.')) });
    await user.click(screen.getByRole('button', { name: 'Copiar diagnóstico' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Portapapeles no disponible.');
  });
});

describe('errores sin capturar de la interfaz', () => {
  it('describe errores, textos y objetos', () => {
    const err = new TypeError('x no es una función');
    expect(describeError(err)).toEqual({ message: 'TypeError: x no es una función', stack: err.stack });
    expect(describeError('texto')).toEqual({ message: 'texto', stack: null });
    expect(describeError(new Error('')).message).toBe('Error sin mensaje');
    expect(describeError('x'.repeat(9000)).message).toHaveLength(5000);
  });

  it('envía los errores y las promesas rechazadas sin capturar; si el envío falla, no pasa nada', async () => {
    const reportError = vi.fn(async (_message: string, _stack: string | null): Promise<null> => Promise.reject(new Error('sin conexión con el proceso principal')));
    const target = new EventTarget() as Window;
    reportErrors(target, { reportError });
    target.dispatchEvent(Object.assign(new Event('error'), { error: new RangeError('fuera de rango'), message: 'fuera de rango' }));
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'promesa rota' }));
    await waitFor(() => expect(reportError).toHaveBeenCalledTimes(2));
    expect(reportError.mock.calls[0]?.[0]).toBe('RangeError: fuera de rango');
    expect(reportError.mock.calls[0]?.[1]).toContain('RangeError: fuera de rango');
    expect(reportError.mock.calls[1]).toEqual(['promesa rota', null]);
  });
});
