import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { LanguageSetting, Locale } from '../shared/settings.js';
import { setLocale } from './i18n.js';

/** Idioma de los textos, del atributo lang y del título de la ventana. */
function applyLocale(locale: Locale): void {
  setLocale(locale);
  document.documentElement.lang = locale;
  document.title = locale === 'en' ? 'Technical Debt Radar' : 'Radar de Deuda Técnica';
}

interface LanguageState {
  /** Lo elegido («auto»: el del sistema). */
  language: LanguageSetting;
  /** El que se usa. */
  locale: Locale;
  setLanguage: (language: LanguageSetting) => Promise<void>;
}

const LanguageContext = createContext<LanguageState | null>(null);

export function useLanguage(): LanguageState {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage fuera de LanguageRoot');
  return ctx;
}

/** Lee el idioma antes de pintar nada y vuelve a pintar `render()` cuando cambia. */
export function LanguageRoot({ render }: { render: () => ReactNode }) {
  const [state, setState] = useState<{ language: LanguageSetting; locale: Locale } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.radar.app
      .info()
      .then((info) => ({ language: info.language, locale: info.locale }))
      .catch(() => ({ language: 'auto' as const, locale: (navigator.language.toLowerCase().startsWith('es') ? 'es' : 'en') as Locale }))
      .then((s) => {
        if (cancelled) return;
        applyLocale(s.locale);
        setState(s);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!state) return <div className="access" />;
  const setLanguage = async (language: LanguageSetting): Promise<void> => {
    const locale = await window.radar.app.setLanguage(language);
    applyLocale(locale);
    setState({ language, locale });
  };
  // render() crea los elementos de nuevo en cada cambio: toda la interfaz se vuelve a pintar.
  return <LanguageContext.Provider value={{ ...state, setLanguage }}>{render()}</LanguageContext.Provider>;
}
