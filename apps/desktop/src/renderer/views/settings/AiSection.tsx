import { useEffect, useState } from 'react';
import { errorMessage } from '../../../shared/errors.js';
import type { IncludedQuota } from '../../../shared/model.js';
import { LOCAL_PROVIDERS, type AiProviderName, type AiSettings, type PrivacySetting, type ReasoningLevel } from '../../../shared/settings.js';
import { dataCollectionChange, providerChange } from '../../lib/settings.js';
import { OpenRouterModels } from './OpenRouterModels.js';
import { CheckField, SettingsSection } from './SettingsSection.js';
import { tr } from '../../i18n.js';

type Patch = (patch: Partial<AiSettings>) => void;

/** Se leen en el idioma actual (funciones, no constantes). */
const providers = (): Array<{ value: AiProviderName; label: string; hint: string }> => {
  const local = tr('Nada sale del equipo. Usa el primer modelo cargado si no eliges otro.', 'Nothing leaves the computer. It uses the first loaded model if you do not choose another.');
  return [
    {
      value: 'incluida',
      label: tr('IA incluida (gratuita)', 'Included AI (free)'),
      hint: tr(
        'Sin claves: el modelo de la aplicación (gpt-oss-120b), con un número de consultas al día por cuenta. Con «solo metadatos» no se envía código.',
        "No keys: the app's model (gpt-oss-120b), with a number of requests per day per account. With \"metadata only\" no code is sent.",
      ),
    },
    { value: 'openrouter', label: tr('OpenRouter (tu clave)', 'OpenRouter (your key)'), hint: tr('Muchos modelos con una sola clave, incluidos algunos gratuitos.', 'Many models with a single key, including some free ones.') },
    {
      value: 'anthropic',
      label: 'Anthropic (Claude)',
      hint: tr('Si no eliges modelo: claude-haiku-5-5 para explicar y claude-sonnet-5-5 para el plan.', 'If you do not choose a model: claude-haiku-5-5 to explain and claude-sonnet-5-5 for the plan.'),
    },
    { value: 'openai', label: 'OpenAI', hint: tr('Indica el modelo.', 'Enter the model.') },
    { value: 'lmstudio', label: tr('LM Studio (en este equipo)', 'LM Studio (on this computer)'), hint: local },
    { value: 'ollama', label: tr('Ollama (en este equipo)', 'Ollama (on this computer)'), hint: local },
  ];
};

const privacyOptions = (): Array<{ value: PrivacySetting; label: string; hint: string }> => [
  { value: 'auto', label: tr('Automática', 'Automatic'), hint: tr('Solo metadatos con proveedores en la nube; código con proveedores locales.', 'Metadata only with cloud providers; code with local providers.') },
  { value: 'metadatos', label: tr('Solo metadatos', 'Metadata only'), hint: tr('Reglas, métricas y rutas. Nunca código.', 'Rules, metrics and paths. Never code.') },
  {
    value: 'fragmentos',
    label: tr('Fragmentos de código', 'Code snippets'),
    hint: tr('Unas líneas alrededor de cada hallazgo, con los secretos ocultos. Explicaciones más precisas.', 'A few lines around each finding, with secrets hidden. More precise explanations.'),
  },
  { value: 'local', label: tr('Solo en este equipo', 'Only on this computer'), hint: tr('Impide usar proveedores en la nube.', 'Prevents using cloud providers.') },
];

const reasoningOptions = (): Array<{ value: ReasoningLevel; label: string }> => [
  { value: 'auto', label: tr('Automático: desactivarlo si el modelo lo permite', 'Automatic: turn it off if the model allows it') },
  { value: 'none', label: tr('Desactivado', 'Off') },
  { value: 'minimal', label: tr('Mínimo', 'Minimal') },
  { value: 'low', label: tr('Bajo', 'Low') },
  { value: 'medium', label: tr('Medio', 'Medium') },
  { value: 'high', label: tr('Alto', 'High') },
];

/** Proveedor, modelo, privacidad, límites y opciones de OpenRouter. */
export function AiSection({ value: ai, onChange }: { value: AiSettings; onChange: Patch }) {
  const local = LOCAL_PROVIDERS.has(ai.provider);
  const included = ai.provider === 'incluida';
  return (
    <SettingsSection
      id="s-ia"
      title={tr('Inteligencia artificial', 'Artificial intelligence')}
      intro={tr(
        'Opcional. Explica los hallazgos y propone un plan; la evidencia siempre viene de las herramientas del análisis.',
        'Optional. It explains the findings and proposes a plan; the evidence always comes from the analysis tools.',
      )}
    >
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
      <CheckField checked={ai.plan} onChange={(plan) => onChange({ plan })} label={tr('Proponer un plan de reducción de la deuda', 'Propose a debt reduction plan')} />
      {ai.provider === 'openrouter' ? <OpenRouterOptions ai={ai} onChange={onChange} /> : null}
      <CheckField
        checked={ai.auto}
        onChange={(auto) => onChange({ auto })}
        label={tr('Explicar automáticamente al terminar cada análisis', 'Explain automatically after each analysis')}
        hint={tr('Si no, puedes pedir la explicación de cada hallazgo desde su detalle.', 'Otherwise, you can ask for the explanation of each finding from its detail.')}
      />
    </SettingsSection>
  );
}

function ProviderField({ ai, onChange }: { ai: AiSettings; onChange: Patch }) {
  const list = providers();
  const provider = list.find((p) => p.value === ai.provider);
  return (
    <div className="field">
      <label htmlFor="proveedor">{tr('Proveedor', 'Provider')}</label>
      <select id="proveedor" className="select" value={ai.provider} onChange={(e) => onChange(providerChange(ai, e.target.value as AiProviderName))}>
        {list.map((p) => (
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
      (err: unknown) => alive && setQuota({ value: null, error: errorMessage(err) }),
    );
    return () => {
      alive = false;
    };
  }, []);
  const { value, error } = quota;
  return (
    <p className="hint" id="cupo-ia" role="status">
      {value
        ? tr(`Te quedan ${value.remaining} de ${value.limit} consultas hoy. Se renuevan a las 00:00 UTC.`, `You have ${value.remaining} of ${value.limit} requests left today. They reset at 00:00 UTC.`)
        : error
          ? tr(`No se pudo consultar tu cupo: ${error}`, `Could not check your quota: ${error}`)
          : tr('Consultando tu cupo de hoy…', "Checking today's quota…")}
    </p>
  );
}

function ModelField({ ai, local, onChange }: { ai: AiSettings; local: boolean; onChange: Patch }) {
  const placeholder = ai.provider === 'anthropic' ? tr('Predeterminado', 'Default') : local ? tr('El primero cargado', 'The first loaded one') : tr('Obligatorio', 'Required');
  return (
    <div className="field">
      <label htmlFor="modelo">{tr('Modelo', 'Model')}</label>
      <input id="modelo" className="input mono" value={ai.model} onChange={(e) => onChange({ model: e.target.value })} placeholder={placeholder} spellCheck={false} />
    </div>
  );
}

function LocalUrlField({ ai, onChange }: { ai: AiSettings; onChange: Patch }) {
  return (
    <div className="field">
      <label htmlFor="url-local">{tr('Dirección del servidor local', 'Local server address')}</label>
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
  const options = privacyOptions().filter((p) => local || p.value !== 'local');
  return (
    <fieldset className="field">
      <legend className="label">{tr('Qué se envía al modelo', 'What is sent to the model')}</legend>
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
        <label htmlFor="limite">{tr('Hallazgos a explicar por análisis', 'Findings to explain per analysis')}</label>
        <input id="limite" className="input input-num" type="number" min={1} max={50} value={ai.limit} onChange={(e) => onChange({ limit: Number(e.target.value) })} />
      </div>
      {!showBudget ? null : (
        <div className="field field-inline">
          <label htmlFor="presupuesto">{tr('Coste máximo por análisis (USD)', 'Maximum cost per analysis (USD)')}</label>
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
        label={tr('Permitir proveedores que guardan o entrenan con los datos', 'Allow providers that store or train on the data')}
        hint={tr('Necesario con muchos modelos gratuitos. Con la privacidad en «solo metadatos» no se envía código.', 'Needed with many free models. With privacy set to "metadata only" no code is sent.')}
      />
      <CheckField
        checked={ai.zeroDataRetention}
        disabled={ai.allowDataCollection}
        onChange={(zeroDataRetention) => onChange({ zeroDataRetention })}
        label={tr('Solo proveedores de retención cero', 'Only zero-retention providers')}
        hint={tr('Más restrictivo: algunos modelos no tendrán ningún proveedor disponible.', 'More restrictive: some models will have no provider available.')}
      />
      <div className="field">
        <label htmlFor="razonamiento">{tr('Razonamiento de los modelos que razonan', 'Reasoning of reasoning models')}</label>
        <select id="razonamiento" className="select" value={ai.reasoning} onChange={(e) => onChange({ reasoning: e.target.value as ReasoningLevel })}>
          {reasoningOptions().map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <span className="hint">
          {tr(
            'El razonamiento consume parte de la respuesta; desactivado, las explicaciones llegan antes y no se cortan.',
            'Reasoning uses up part of the answer; turned off, explanations arrive sooner and are not cut off.',
          )}
        </span>
      </div>
    </>
  );
}
