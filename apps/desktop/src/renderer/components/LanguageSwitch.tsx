import type { Locale } from '../../shared/settings.js';
import { tr } from '../i18n.js';
import { useLanguage } from '../language.js';

const NAMES: Record<Locale, string> = { es: 'Español', en: 'English' };

/** Cambio rápido de idioma (pantalla de acceso). En Configuración está también «Automático». */
export function LanguageSwitch() {
  const { locale, setLanguage } = useLanguage();
  return (
    <div className="language-switch" role="group" aria-label={tr('Idioma', 'Language')}>
      {(['es', 'en'] as const).map((l) => (
        <button key={l} type="button" className="chip" lang={l} aria-pressed={locale === l} onClick={() => void setLanguage(l)}>
          {NAMES[l]}
        </button>
      ))}
    </div>
  );
}
