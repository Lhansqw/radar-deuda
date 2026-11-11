import { useState } from 'react';
import { errorMessage } from '../../../shared/errors.js';
import type { LanguageSetting } from '../../../shared/settings.js';
import { tr } from '../../i18n.js';
import { useLanguage } from '../../language.js';
import { FormError, SettingsSection } from './SettingsSection.js';

/** Idioma de la aplicación. Se aplica y se guarda al elegirlo (no espera a «Guardar cambios»). */
export function LanguageSection() {
  const { language, setLanguage } = useLanguage();
  const [error, setError] = useState<string | null>(null);
  const choose = (value: LanguageSetting): void => {
    setError(null);
    setLanguage(value).catch((err: unknown) => setError(errorMessage(err)));
  };
  return (
    <SettingsSection
      id="s-idioma"
      title={tr('Idioma', 'Language')}
      intro={tr(
        'Idioma de la interfaz, de los textos de los hallazgos y de las respuestas de la IA. Se aplica al momento.',
        'Language of the interface, of the finding texts and of the AI answers. It applies right away.',
      )}
    >
      <div className="field">
        <label htmlFor="idioma">{tr('Idioma de la aplicación', 'App language')}</label>
        <select id="idioma" className="select" value={language} onChange={(e) => choose(e.target.value as LanguageSetting)}>
          <option value="auto">{tr('Automático (el del sistema)', 'Automatic (system language)')}</option>
          <option value="es" lang="es">
            Español
          </option>
          <option value="en" lang="en">
            English
          </option>
        </select>
        <span className="hint">
          {tr(
            'Los análisis ya guardados conservan el idioma con el que se hicieron; al volver a analizar, los hallazgos salen en el idioma nuevo.',
            'Saved analyses keep the language they were made in; when you analyze again, the findings come out in the new language.',
          )}
        </span>
      </div>
      <FormError error={error} />
    </SettingsSection>
  );
}
