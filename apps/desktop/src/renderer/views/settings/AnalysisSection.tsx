import { MEMORY_LIMIT_RANGE, type AppSettings } from '../../../shared/settings.js';
import { CheckField, SettingsSection } from './SettingsSection.js';
import { tr } from '../../i18n.js';

type AnalysisSettings = AppSettings['analysis'];

/** Opciones del análisis: historial de Git, memoria y consultas de dependencias. */
export function AnalysisSection({ value, onChange }: { value: AnalysisSettings; onChange: (patch: Partial<AnalysisSettings>) => void }) {
  return (
    <SettingsSection id="s-analisis" title={tr('Análisis', 'Analysis')} intro={tr('Se aplica a los análisis que hagas a partir de ahora.', 'It applies to the analyses you run from now on.')}>
      <CheckField
        checked={value.history}
        onChange={(history) => onChange({ history })}
        label={tr('Puntos críticos con el historial de Git', 'Hotspots with the Git history')}
        hint={tr('Cruza la deuda con la frecuencia de cambio de cada archivo.', 'Crosses the debt with how often each file changes.')}
      />
      <div className="field field-inline">
        <label htmlFor="meses">{tr('Meses de historial', 'Months of history')}</label>
        <input
          id="meses"
          className="input input-num"
          type="number"
          min={1}
          max={120}
          value={value.historyMonths}
          disabled={!value.history}
          onChange={(e) => onChange({ historyMonths: Number(e.target.value) })}
        />
      </div>
      <div className="field">
        <label htmlFor="memoria">{tr('Memoria máxima del análisis', 'Maximum analysis memory')}</label>
        <div className="field-unit">
          <input
            id="memoria"
            className="input input-num"
            type="number"
            min={MEMORY_LIMIT_RANGE.min}
            max={MEMORY_LIMIT_RANGE.max}
            step={512}
            value={value.memoryLimitMb}
            onChange={(e) => onChange({ memoryLimitMb: Number(e.target.value) })}
          />
          <span className="muted small">MB</span>
        </div>
        <span className="hint">
          {tr(
            `Entre ${MEMORY_LIMIT_RANGE.min} y ${MEMORY_LIMIT_RANGE.max} MB. El análisis se detiene con un aviso antes de superarla. Si el proyecto tiene mucho código generado, mejor excluirlo con un archivo .radarignore.`,
            `Between ${MEMORY_LIMIT_RANGE.min} and ${MEMORY_LIMIT_RANGE.max} MB. The analysis stops with a warning before exceeding it. If the project has a lot of generated code, better exclude it with a .radarignore file.`,
          )}
        </span>
      </div>
      <CheckField
        checked={value.online}
        onChange={(online) => onChange({ online })}
        label={tr('Vulnerabilidades y versiones de las dependencias', 'Dependency vulnerabilities and versions')}
        hint={tr('Envía solo nombres y versiones de paquetes a api.osv.dev y registry.npmjs.org; nunca código.', 'Sends only package names and versions to api.osv.dev and registry.npmjs.org; never code.')}
      />
    </SettingsSection>
  );
}
