// @vitest-environment happy-dom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SecretsStatus } from '../../src/shared/secrets.js';
import { DEFAULT_SETTINGS, type AppSettings, type LanguageSetting, type Locale, type ThemeSetting } from '../../src/shared/settings.js';
import { LanguageRoot } from '../../src/renderer/language.js';
import { setLocale } from '../../src/renderer/i18n.js';
import { Settings } from '../../src/renderer/views/Settings.js';
import { APP_INFO, mockRadar, type RadarOverrides } from './radar.js';

const ACCOUNT = { status: 'signed-in', email: 'ana@ejemplo.com', offline: false } as const;
const SECRETS: SecretsStatus = {
  encryptionAvailable: true,
  secrets: { openrouter: { stored: false, fromEnv: false }, anthropic: { stored: false, fromEnv: false }, openai: { stored: false, fromEnv: false }, github: { stored: false, fromEnv: false } },
};

function setup(overrides: RadarOverrides = {}) {
  let stored: AppSettings = structuredClone(DEFAULT_SETTINGS);
  const set = vi.fn(async (s: AppSettings) => (stored = structuredClone(s)));
  const setTheme = vi.fn(async (t: ThemeSetting) => t);
  const setLanguage = vi.fn(async (l: LanguageSetting) => (l === 'en' ? 'en' : 'es') as Locale);
  mockRadar({
    ...overrides,
    settings: { get: async () => structuredClone(stored), set, ...overrides.settings },
    secrets: { status: async () => SECRETS },
    app: { info: async () => APP_INFO, theme: async () => 'dark', setTheme, setLanguage, ...overrides.app },
  });
  render(<LanguageRoot render={() => <Settings account={ACCOUNT} />} />);
  return { set, setTheme, setLanguage, user: userEvent.setup() };
}

const historyBox = () => screen.findByRole('checkbox', { name: /Puntos críticos con el historial de Git/ });

afterEach(() => setLocale('es'));

describe('Configuración', () => {
  it('el idioma se aplica al elegirlo, sin pasar por el borrador', async () => {
    const { set, setLanguage, user } = setup();
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Idioma de la aplicación' }), 'en');
    expect(setLanguage).toHaveBeenCalledWith('en');
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(await screen.findByRole('checkbox', { name: /Hotspots with the Git history/ })).toBeChecked();
    expect(set).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Save changes' })).toBeNull();
  });

  it('sin cambios no muestra la barra de guardar', async () => {
    setup();
    expect(await historyBox()).toBeChecked();
    expect(screen.queryByRole('region', { name: 'Guardar cambios' })).toBeNull();
  });

  it('un cambio aparece como borrador y se puede descartar', async () => {
    const { set, user } = setup();
    await user.click(await historyBox());
    expect(screen.getByText('Tienes cambios sin guardar.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(await historyBox()).toBeChecked();
    expect(screen.queryByRole('region', { name: 'Guardar cambios' })).toBeNull();
    expect(set).not.toHaveBeenCalled();
  });

  it('guarda todo el borrador de una vez y lo confirma', async () => {
    const { set, user } = setup();
    await user.click(await historyBox());
    await user.click(screen.getByRole('checkbox', { name: /Vulnerabilidades y versiones de las dependencias/ }));
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]?.[0].analysis).toMatchObject({ history: false, online: true });
    expect(await screen.findByText('Cambios guardados.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Guardar cambios' })).toBeNull();
  });

  it('si no se puede guardar, muestra el error y conserva el borrador', async () => {
    const { user } = setup({ settings: { set: async () => Promise.reject(new Error('Meses de historial: fuera de rango.')) } });
    await user.click(await historyBox());
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(await screen.findByText('Meses de historial: fuera de rango.')).toBeInTheDocument();
    expect(await historyBox()).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Guardar cambios' })).toBeInTheDocument();
  });

  it('el tema se aplica al elegirlo, sin pasar por el borrador', async () => {
    const { setTheme, user } = setup();
    const dark = await screen.findByRole('radio', { name: 'Oscuro' });
    expect(dark).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'Claro' }));
    expect(setTheme).toHaveBeenCalledWith('light');
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Claro' })).toBeChecked());
    expect(screen.queryByRole('region', { name: 'Guardar cambios' })).toBeNull();
  });

  it('si el tema no se puede cambiar, lo dice y deja el anterior', async () => {
    const { user } = setup({ app: { setTheme: async () => Promise.reject(new Error('Disco lleno.')) } });
    await user.click(await screen.findByRole('radio', { name: 'Claro' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo cambiar el tema: Disco lleno.');
    expect(screen.getByRole('radio', { name: 'Oscuro' })).toBeChecked();
  });
});
