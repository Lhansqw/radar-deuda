import { useEffect, useState } from 'react';
import type { IncludedQuota } from '../../../shared/model.js';
import { LOCAL_PROVIDERS, type AiProviderName, type AiSettings, type PrivacySetting, type ReasoningLevel } from '../../../shared/settings.js';
import { dataCollectionChange, providerChange } from '../../lib/settings.js';
import { OpenRouterModels } from './OpenRouterModels.js';
import { CheckField, SettingsSection } from './SettingsSection.js';

type Patch = (patch: Partial<AiSettings>) => void;

const PROVIDERS: Array<{ value: AiProviderName; label: string; hint: string }> = [
  {
    value: 'incluida',
    label: 'IA incluida (gratuita)',
    hint: 'Sin claves: el modelo de la aplicación (gpt-oss-120b), con un número de consultas al día por cuenta. Con «solo metadatos» no se envía código.',
  },
  { value: 'openrouter', label: 'OpenRouter (tu clave)', hint: 'Muchos modelos con una sola clave, incluidos algunos gratuitos.' },
  { value: 'anthropic', label: 'Anthropic (Claude)', hint: 'Si no eliges modelo: claude-haiku-5-5 para explicar y claude-sonnet-5-5 para el plan.' },
  { value: 'openai', label: 'OpenAI', hint: 'Indica el modelo.' },
  { value: 'lmstudio', label: 'LM Studio (en este equipo)', hint: 'Nada sale del equipo. Usa el primer modelo cargado si no eliges otro.' },
  { value: 'ollama', label: 'Ollama (en este equipo)', hint: 'Nada sale del equipo. Usa el primer modelo cargado si no eliges otro.' },
];

const PRIVACY: Array<{ value: PrivacySetting; label: string; hint: string }> = [
  { value: 'auto', label: 'Automática', hint: 'Solo metadatos con proveedores en la nube; código con proveedores locales.' },
  { value: 'metadatos', label: 'Solo metadatos', hint: 'Reglas, métricas y rutas. Nunca código.' },
  { value: 'fragmentos', label: 'Fragmentos de código', hint: 'Unas líneas alrededor de cada hallazgo, con los secretos ocultos. Explicaciones más precisas.' },
  { value: 'local', label: 'Solo en este equipo', hint: 'Impide usar proveedores en la nube.' },
];

const REASONING: Array<{ value: ReasoningLevel; label: string }> = [
  { value: 'auto', label: 'Automático: desactivarlo si el modelo lo permite' },
  { value: 'none', label: 'Desactivado' },
  { value: 'minimal', label: 'Mínimo' },
  { value: 'low', label: 'Bajo' },
  { value: 'medium', label: 'Medio' },
  { value: 'high', label: 'Alto' },
];

/** Proveedor, modelo, privacidad, límites y opciones de OpenRouter. */
export function AiSection({ value: ai, onChange }: { value: AiSettings; onChange: Patch }) {
  const local = LOCAL_PROVIDERS.has(ai.provider);
  const included = ai.provider === 'incluida';
  return (
    <SettingsSection id="s-ia" title="Inteligencia artificial" intro="Opcional. Explica los hallazgos y propone un plan; la evidencia siempre viene de las herramientas del análisis.">
      <ProviderField ai={ai} onChange={onChange} />
      {included ? (
        <IncludedQuotaField />
      ) : ai.provider === 'openrouter' ? (
        <OpenRouterModels model={ai.model} fallback={ai.fallbackModels} onModel={(model) => onChange({ model })} onFallback={(fallbackModels) => onChange({ fallbackModels })} />
      ) : (
        <ModelField ai={ai} local={local} onChange={onChange} />
      )}
      {local ? <LocalUrlField ai={ai} onChange={onChange} /> : null}
      <PrivacyField ai={ai} local={local} onChange={onChange} />
      <LimitFields ai={ai} showBudget={!local && !included} onChange={onChange} />
      <CheckField checked={ai.plan} onChange={(plan) => onChange({ plan })} label="Proponer un plan de reducción de la deuda" />
      {ai.provider === 'openrouter' ? <OpenRouterOptions ai={ai} onChange={onChange} /> : null}
      <CheckField
        checked={ai.auto}
        onChange={(auto) => onChange({ auto })}
        label="Explicar automáticamente al terminar cada análisis"
        hint="Si no, puedes pedir la explicación de cada hallazgo desde su detalle."
      />
    </SettingsSection>
  );
}

function ProviderField({ ai, onChange }: { ai: AiSettings; onChange: Patch }) {
  const provider = PROVIDERS.find((p) => p.value === ai.provider);
  return (
    <div className="field">
      <label htmlFor="proveedor">Proveedor</label>
      <select id="proveedor" className="select" value={ai.provider} onChange={(e) => onChange(providerChange(ai, e.target.value as AiProviderName))}>
        {PROVIDERS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
      {provider ? <span className="hint">{provider.hint}</span> : null}
    </div>
  );
}

/** Consultas de IA incluida que quedan hoy (las cuenta el servidor). */
function IncludedQuotaField() {
  const [quota, setQuota] = useState<{ value: IncludedQuota | null; error: string | null }>({ value: null, error: null });
  useEffect(() => {
    let alive = true;
    window.radar.ai.includedQuota().then(
      (value) => alive && setQuota({ value, error: null }),
      (err: unknown) => alive && setQuota({ value: null, error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      alive = false;
    };
  }, []);
  const { value, error } = quota;
  return (
    <p className="hint" id="cupo-ia" role="status">
      {value
        ? `Te quedan ${value.remaining} de ${value.limit} consultas hoy. Se renuevan a las 00:00 UTC.`
        : error
          ? `No se pudo consultar tu cupo: ${error}`
          : 'Consultando tu cupo de hoy…'}
    </p>
  );
}

function ModelField({ ai, local, onChange }: { ai: AiSettings; local: boolean; onChange: Patch }) {
  const placeholder = ai.provider === 'anthropic' ? 'Predeterminado' : local ? 'El primero cargado' : 'Obligatorio';
  return (
    <div className="field">
      <label htmlFor="modelo">Modelo</label>
      <input id="modelo" className="input mono" value={ai.model} onChange={(e) => onChange({ model: e.target.value })} placeholder={placeholder} spellCheck={false} />
    </div>
  );
}

function LocalUrlField({ ai, onChange }: { ai: AiSettings; onChange: Patch }) {
  return (
    <div className="field">
      <label htmlFor="url-local">Dirección del servidor local</label>
      <input
        id="url-local"
        className="input mono"
        value={ai.localUrl}
        onChange={(e) => onChange({ localUrl: e.target.value })}
        placeholder={ai.provider === 'ollama' ? 'http://localhost:11434/v1' : 'http://localhost:1234/v1'}
        spellCheck={false}
      />
    </div>
  );
}

function PrivacyField({ ai, local, onChange }: { ai: AiSettings; local: boolean; onChange: Patch }) {
  // «Solo en este equipo» solo tiene sentido con un proveedor local.
  const options = PRIVACY.filter((p) => local || p.value !== 'local');
  return (
    <fieldset className="field">
      <legend className="label">Qué se envía al modelo</legend>
      <div className="radios">
        {options.map((p) => (
          <label key={p.value} className="check">
            <input type="radio" name="privacidad" checked={ai.privacy === p.value} onChange={() => onChange({ privacy: p.value })} />
            <span>
              {p.label}
              <span className="hint">{p.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function LimitFields({ ai, showBudget, onChange }: { ai: AiSettings; showBudget: boolean; onChange: Patch }) {
  return (
    <div className="field-row">
      <div className="field field-inline">
        <label htmlFor="limite">Hallazgos a explicar por análisis</label>
        <input id="limite" className="input input-num" type="number" min={1} max={50} value={ai.limit} onChange={(e) => onChange({ limit: Number(e.target.value) })} />
      </div>
      {!showBudget ? null : (
        <div className="field field-inline">
          <label htmlFor="presupuesto">Coste máximo por análisis (USD)</label>
          <input
            id="presupuesto"
            className="input input-num"
            type="number"
            min={0.01}
            max={50}
            step={0.05}
            value={ai.budgetUsd}
            onChange={(e) => onChange({ budgetUsd: Number(e.target.value) })}
          />
        </div>
      )}
    </div>
  );
}

/** Política de datos de los proveedores de OpenRouter y razonamiento. */
function OpenRouterOptions({ ai, onChange }: { ai: AiSettings; onChange: Patch }) {
  return (
    <>
      <CheckField
        checked={ai.allowDataCollection}
        onChange={(allow) => onChange(dataCollectionChange(allow))}
        label="Permitir proveedores que guardan o entrenan con los datos"
        hint="Necesario con muchos modelos gratuitos. Con la privacidad en «solo metadatos» no se envía código."
      />
      <CheckField
        checked={ai.zeroDataRetention}
        disabled={ai.allowDataCollection}
        onChange={(zeroDataRetention) => onChange({ zeroDataRetention })}
        label="Solo proveedores de retención cero"
        hint="Más restrictivo: algunos modelos no tendrán ningún proveedor disponible."
      />
      <div className="field">
        <label htmlFor="razonamiento">Razonamiento de los modelos que razonan</label>
        <select id="razonamiento" className="select" value={ai.reasoning} onChange={(e) => onChange({ reasoning: e.target.value as ReasoningLevel })}>
          {REASONING.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <span className="hint">El razonamiento consume parte de la respuesta; desactivado, las explicaciones llegan antes y no se cortan.</span>
      </div>
    </>
  );
}
