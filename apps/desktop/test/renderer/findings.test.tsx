// @vitest-environment happy-dom
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Category, Finding, Severity } from '@radar/engine';
import { EMPTY_FILTER, type FindingFilter } from '../../src/renderer/lib/findings.js';
import { Findings } from '../../src/renderer/views/Findings.js';
import { report } from '../helpers/report.js';
import { mockRadar } from './radar.js';

interface Spec {
  id: string;
  severity: Severity;
  category: Category;
  title: string;
  file: string;
  minutes: number;
}

function finding({ id, severity, category, title, file, minutes }: Spec): Finding {
  return {
    id,
    ruleId: `${category}/regla`,
    category,
    severity,
    confidence: 'high',
    title,
    message: `Mensaje de ${title}.`,
    locations: [{ file, startLine: 10, endLine: 20 }],
    evidence: [],
    impact: 'Cuesta mantenerlo.',
    effort: { minutes, rationale: 'Prueba.' },
  };
}

const FINDINGS = [
  finding({ id: 'a', severity: 'medium', category: 'complexity', title: 'Función difícil de mantener: procesarPedido', file: 'src/pedidos/procesar.ts', minutes: 60 }),
  finding({ id: 'b', severity: 'high', category: 'security', title: 'Posible secreto en el código', file: 'src/config.ts', minutes: 15 }),
  finding({ id: 'c', severity: 'low', category: 'duplication', title: 'Código duplicado en 2 lugares', file: 'src/util/formato.ts', minutes: 120 }),
];

/** La vista es controlada: el filtro y la selección viven fuera, como en la aplicación. */
function Harness({ newIds, onSelect }: { newIds?: ReadonlySet<string>; onSelect?: (id: string | null) => void }) {
  const [filter, setFilter] = useState<FindingFilter>(EMPTY_FILTER);
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <Findings
      report={report(70, { findings: FINDINGS })}
      analysisId={1}
      filter={filter}
      onFilter={setFilter}
      selectedId={selected}
      onSelect={(id) => {
        setSelected(id);
        onSelect?.(id);
      }}
      onExplain={async () => undefined}
      onOpenSettings={() => undefined}
      newIds={newIds}
    />
  );
}

function setup(props: Parameters<typeof Harness>[0] = {}) {
  mockRadar();
  render(<Harness {...props} />);
  return userEvent.setup();
}

const rows = () => within(screen.getByRole('listbox', { name: 'Hallazgos' })).getAllByRole('option').map((o) => o.textContent ?? '');
const detailTitle = () => within(screen.getByRole('region', { name: 'Detalle del hallazgo' })).getByRole('heading', { level: 2 }).textContent;

describe('Hallazgos', () => {
  it('lista por severidad y abre el primero', () => {
    setup();
    expect(screen.getByText('3 hallazgos')).toBeInTheDocument();
    expect(rows().map((r) => r.slice(0, 12))).toEqual(['Posible secr', 'Función difí', 'Código dupli']);
    expect(detailTitle()).toBe('Posible secreto en el código');
  });

  it('los botones de severidad filtran y muestran cuántos hay', async () => {
    const user = setup();
    const high = screen.getByRole('button', { name: /Alta/ });
    expect(high).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Crítica/ })).toBeDisabled();
    await user.click(high);
    expect(high).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('2 de 3 hallazgos')).toBeInTheDocument();
    expect(detailTitle()).toBe('Función difícil de mantener: procesarPedido');
  });

  it('filtra por categoría, busca sin tildes y ordena por esfuerzo', async () => {
    const user = setup();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Categoría' }), 'Duplicación');
    expect(rows()).toHaveLength(1);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Categoría' }), 'Todas las categorías');
    await user.type(screen.getByRole('searchbox'), 'funcion procesar');
    expect(screen.getByText('1 de 3 hallazgos')).toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox'));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Orden' }), 'Por esfuerzo');
    expect(rows().map((r) => r.slice(0, 12))).toEqual(['Código dupli', 'Función difí', 'Posible secr']);
  });

  it('sin coincidencias lo dice en el detalle', async () => {
    const user = setup();
    await user.type(screen.getByRole('searchbox'), 'no existe');
    expect(screen.getByText('0 de 3 hallazgos')).toBeInTheDocument();
    expect(screen.getByText('Ningún hallazgo coincide con los filtros.')).toBeInTheDocument();
  });

  it('se recorre con las flechas y con un clic', async () => {
    const onSelect = vi.fn();
    const user = setup({ onSelect });
    screen.getByRole('listbox', { name: 'Hallazgos' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(onSelect).toHaveBeenLastCalledWith('a');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(onSelect).toHaveBeenLastCalledWith('c');
    await user.keyboard('{ArrowUp}');
    expect(detailTitle()).toBe('Función difícil de mantener: procesarPedido');
    await user.click(screen.getByText('Posible secreto en el código', { selector: '.row-title' }));
    expect(onSelect).toHaveBeenLastCalledWith('b');
  });

  it('«Solo nuevos» deja la deuda que no estaba en el análisis anterior', async () => {
    const user = setup({ newIds: new Set(['c']) });
    await user.click(screen.getByRole('button', { name: /Solo nuevos/ }));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('Nuevo');
  });
});
