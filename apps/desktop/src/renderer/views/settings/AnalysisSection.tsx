import { MEMORY_LIMIT_RANGE, type AppSettings } from '../../../shared/settings.js';
import { CheckField, SettingsSection } from './SettingsSection.js';

type AnalysisSettings = AppSettings['analysis'];

/** Opciones del análisis: historial de Git, memoria y consultas de dependencias. */
export function AnalysisSection({ value, onChange }: { value: AnalysisSettings; onChange: (patch: Partial<AnalysisSettings>) => void }) {
  return (
    <SettingsSection id="s-analisis" title="Análisis" intro="Se aplica a los análisis que hagas a partir de ahora.">
      <CheckField
        checked={value.history}
        onChange={(history) => onChange({ history })}
        label="Puntos críticos con el historial de Git"
        hint="Cruza la deuda con la frecuencia de cambio de cada archivo."
      />
      <div className="field field-inline">
        <label htmlFor="meses">Meses de historial</label>
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
        <label htmlFor="memoria">Memoria máxima del análisis</label>
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
          Entre {MEMORY_LIMIT_RANGE.min} y {MEMORY_LIMIT_RANGE.max} MB. El análisis se detiene con un aviso antes de superarla. Si el proyecto tiene mucho código generado,
          mejor excluirlo con un archivo .radarignore.
        </span>
      </div>
      <CheckField
        checked={value.online}
        onChange={(online) => onChange({ online })}
        label="Vulnerabilidades y versiones de las dependencias"
        hint="Envía solo nombres y versiones de paquetes a api.osv.dev y registry.npmjs.org; nunca código."
      />
    </SettingsSection>
  );
}
