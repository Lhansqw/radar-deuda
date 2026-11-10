// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AiFixProposal, Finding } from '@radar/engine';
import type { FixPreviewInfo, StoredFixProposal } from '../../src/shared/model.js';
import { FixProposal } from '../../src/renderer/views/FixProposal.js';
import { mockRadar, type RadarOverrides } from './radar.js';

const FINDING: Finding = {
  id: 'h1',
  ruleId: 'complexity/function',
  category: 'complexity',
  severity: 'high',
  confidence: 'high',
  title: 'Función difícil de mantener: procesarPedido',
  message: 'Supera los umbrales.',
  locations: [{ file: 'src/pedidos.ts', startLine: 14, endLine: 32 }],
  evidence: [],
  impact: 'Cuesta mantenerlo.',
  effort: { minutes: 90, rationale: 'Prueba.' },
};

const PROPOSAL: AiFixProposal = {
  findingId: 'h1',
  applicable: true,
  summary: 'Extraer el descuento de la electrónica.',
  hunks: [
    {
      file: 'src/pedidos.ts',
      oldStart: 14,
      oldLines: 2,
      newStart: 14,
      newLines: 1,
      lines: [
        { kind: 'removed', text: 'if (a) {', oldLine: 14, newLine: null },
        { kind: 'removed', text: '  total += x;', oldLine: 15, newLine: null },
        { kind: 'added', text: 'total += descuento(x);', oldLine: null, newLine: 14 },
      ],
    },
  ],
  patch: '--- a/src/pedidos.ts\n+++ b/src/pedidos.ts\n',
  risks: ['Falta definir descuento.'],
  verification: ['Ejecuta las pruebas de pedidos.'],
  validationNotes: [],
  baseHashes: {},
  privacy: 'fragmentos',
  provider: 'openrouter',
  model: 'qwen/qwen3-coder:free',
  fromCache: false,
  usage: { requests: 1, cacheHits: 0, inputTokens: 10, outputTokens: 10, costUsd: 0, latencyMsTotal: 900, latencyMsMax: 900 },
  createdAt: '2026-11-10T10:33:00.000Z',
};
const STORED: StoredFixProposal = { proposal: PROPOSAL, stale: false };
const PREVIEW: FixPreviewInfo = { text: 'if (a) {', snippets: [{ file: 'src/pedidos.ts', startLine: 14, endLine: 32 }], provider: 'OpenRouter', cloud: true, needsConsent: true, mayRetain: false };

function setup(ai: RadarOverrides['ai'] = {}, other: RadarOverrides = {}, finding: Finding = FINDING) {
  const onOpenSettings = vi.fn();
  mockRadar({ ...other, ai: { getFix: async () => null, ...ai } });
  const { container } = render(<FixProposal finding={finding} analysisId={7} onOpenSettings={onOpenSettings} />);
  return { container, onOpenSettings, user: userEvent.setup() };
}

describe('Propuesta de corrección', () => {
  it('con «solo metadatos», pide permiso enseñando qué se envía y solo envía al confirmar', async () => {
    const proposeFix = vi.fn(async () => STORED);
    const { user } = setup({ fixPreview: async () => PREVIEW, proposeFix });
    await user.click(await screen.findByRole('button', { name: 'Proponer una corrección' }));
    expect(screen.getByRole('dialog', { name: '¿Enviar este fragmento de código a OpenRouter?' })).toBeInTheDocument();
    expect(proposeFix).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Enviar el fragmento y proponer' }));
    expect(proposeFix).toHaveBeenCalledWith(7, 'h1', true);
    expect(await screen.findByText('Extraer el descuento de la electrónica.')).toBeInTheDocument();
    expect(screen.getByText('2 líneas eliminadas y 1 añadida.')).toBeInTheDocument();
    expect(screen.getByText('Falta definir descuento.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cancelar el permiso no envía nada', async () => {
    const proposeFix = vi.fn(async () => STORED);
    const { user } = setup({ fixPreview: async () => PREVIEW, proposeFix });
    await user.click(await screen.findByRole('button', { name: 'Proponer una corrección' }));
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(proposeFix).not.toHaveBeenCalled();
  });

  it('si la privacidad ya permite enviar el fragmento, no pregunta', async () => {
    const proposeFix = vi.fn(async () => STORED);
    const { user } = setup({ fixPreview: async () => ({ ...PREVIEW, needsConsent: false }), proposeFix });
    await user.click(await screen.findByRole('button', { name: 'Proponer una corrección' }));
    expect(proposeFix).toHaveBeenCalledWith(7, 'h1', false);
    expect(await screen.findByText('Extraer el descuento de la electrónica.')).toBeInTheDocument();
  });

  it('un error se muestra con reintentar y acceso a Configuración', async () => {
    const { user, onOpenSettings } = setup({ fixPreview: async () => Promise.reject(new Error('Elige un modelo en Configuración.')) });
    await user.click(await screen.findByRole('button', { name: 'Proponer una corrección' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Elige un modelo en Configuración.');
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Configuración' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('una propuesta guardada se ve al abrir; el parche se copia o se guarda, nunca se aplica', async () => {
    const copyText = vi.fn(async () => null);
    const savePatch = vi.fn(async () => 'C:/Descargas/cambio.patch');
    const { user } = setup({ getFix: async () => ({ ...STORED, stale: true }) }, { app: { copyText }, files: { savePatch } });
    expect(await screen.findByText(/El archivo cambió después de la propuesta/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copiar el parche' }));
    expect(copyText).toHaveBeenCalledWith(PROPOSAL.patch);
    expect(await screen.findByText('Parche copiado al portapapeles.')).toHaveAttribute('role', 'status');
    await user.click(screen.getByRole('button', { name: 'Guardar el parche…' }));
    expect(savePatch).toHaveBeenCalledWith(7, 'h1');
    expect(await screen.findByText('Parche guardado en C:/Descargas/cambio.patch.')).toBeInTheDocument();
  });

  it('para un posible secreto no ofrece la IA: da el consejo fijo', () => {
    setup({}, {}, { ...FINDING, category: 'security', ruleId: 'security/secret/aws' });
    expect(screen.getByText(/retirarlo del código, revocarlo/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Proponer una corrección' })).toBeNull();
  });

  it('un hallazgo del proyecto entero no tiene líneas que corregir', () => {
    const { container } = setup({}, {}, { ...FINDING, locations: [{ file: '.', startLine: 1, endLine: 1 }] });
    expect(container).toBeEmptyDOMElement();
  });
});
