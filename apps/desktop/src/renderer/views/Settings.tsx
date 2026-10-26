import { useEffect, useMemo, useState } from 'react';
import type { AppInfo } from '../../shared/ipc.js';
import type { CatalogModel, OpenRouterKeyCheck } from '../../shared/model.js';
import { SECRET_LABELS, SECRET_NAMES, type SecretName, type SecretsStatus } from '../../shared/secrets.js';
import { LOCAL_PROVIDERS, type AiProviderName, type AppSettings, type PrivacySetting, type ReasoningLevel } from '../../shared/settings.js';
import { Icon } from '../components/Icon.js';
import { fold } from '../lib/format.js';

const PROVIDERS: Array<{ value: AiProviderName; label: string; hint: string }> = [
  { value: 'openrouter', label: 'OpenRouter', hint: 'Muchos modelos con una sola clave, incluidos algunos gratuitos.' },
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

const KEY_PAGES: Record<SecretName, string> = {
  openrouter: 'https://openrouter.ai/settings/keys',
  anthropic: 'https://platform.claude.com/',
  openai: 'https://platform.openai.com/api-keys',
  github: 'https://github.com/settings/personal-access-tokens/new',
};

const ENV_NAMES: Record<SecretName, string> = {
  openrouter: 'RADAR_OPENROUTER_API_KEY',
  anthropic: 'RADAR_ANTHROPIC_API_KEY',
  openai: 'RADAR_OPENAI_API_KEY',
  github: 'RADAR_GITHUB_TOKEN',
};

export function Settings() {
  const [saved, setSaved] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [errors, setErrors] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const [secrets, setSecrets] = useState<SecretsStatus | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    void window.radar.settings.get().then((s) => {
      setSaved(s);
      setDraft(s);
    });
    void window.radar.secrets.status().then(setSecrets);
    void window.radar.app.info().then(setInfo);
  }, []);

  if (!draft || !saved) return null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const ai = draft.ai;
  const setAi = (patch: Partial<AppSettings['ai']>): void => setDraft({ ...draft, ai: { ...ai, ...patch } });
  const setAnalysis = (patch: Partial<AppSettings['analysis']>): void => setDraft({ ...draft, analysis: { ...draft.analysis, ...patch } });

  async function save(): Promise<void> {
    if (!draft) return;
    setErrors(null);
    try {
      const s = await window.radar.settings.set(draft);
      setSaved(s);
      setDraft(s);
      setSavedOk(true);
    } catch (err) {
      setErrors(err instanceof Error ? err.message : String(err));
    }
  }

  const provider = PROVIDERS.find((p) => p.value === ai.provider);
  const local = LOCAL_PROVIDERS.has(ai.provider);
  return (
    <div className="settings">
      <header className="settings-head">
        <h1>Configuración</h1>
      </header>

      <section className="settings-section" aria-labelledby="s-analisis">
        <div className="settings-intro">
          <h2 id="s-analisis">Análisis</h2>
          <p>Se aplica a los análisis que hagas a partir de ahora.</p>
        </div>
        <div className="settings-fields">
          <label className="check">
            <input type="checkbox" checked={draft.analysis.history} onChange={(e) => setAnalysis({ history: e.target.checked })} />
            <span>
              Puntos críticos con el historial de Git
              <span className="hint">Cruza la deuda con la frecuencia de cambio de cada archivo.</span>
            </span>
          </label>
          <div className="field field-inline">
            <label htmlFor="meses">Meses de historial</label>
            <input
              id="meses"
              className="input input-num"
              type="number"
              min={1}
              max={120}
              value={draft.analysis.historyMonths}
              disabled={!draft.analysis.history}
              onChange={(e) => setAnalysis({ historyMonths: Number(e.target.value) })}
            />
          </div>
          <label className="check">
            <input type="checkbox" checked={draft.analysis.online} onChange={(e) => setAnalysis({ online: e.target.checked })} />
            <span>
              Vulnerabilidades y versiones de las dependencias
              <span className="hint">Envía solo nombres y versiones de paquetes a api.osv.dev y registry.npmjs.org; nunca código.</span>
            </span>
          </label>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="s-ia">
        <div className="settings-intro">
          <h2 id="s-ia">Inteligencia artificial</h2>
          <p>Opcional. Explica los hallazgos y propone un plan; la evidencia siempre viene de las herramientas del análisis.</p>
        </div>
        <div className="settings-fields">
          <div className="field">
            <label htmlFor="proveedor">Proveedor</label>
            <select
              id="proveedor"
              className="select"
              value={ai.provider}
              onChange={(e) => {
                const next = e.target.value as AiProviderName;
                // Cambiar de proveedor deja de tener sentido el modelo elegido; «solo en este equipo» exige uno local.
                setAi({ provider: next, model: '', fallbackModels: [], ...(ai.privacy === 'local' && !LOCAL_PROVIDERS.has(next) ? { privacy: 'auto' } : {}) });
              }}
            >
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            {provider ? <span className="hint">{provider.hint}</span> : null}
          </div>

          {ai.provider === 'openrouter' ? (
            <OpenRouterModels model={ai.model} fallback={ai.fallbackModels} onModel={(model) => setAi({ model })} onFallback={(fallbackModels) => setAi({ fallbackModels })} />
          ) : (
            <div className="field">
              <label htmlFor="modelo">Modelo</label>
              <input
                id="modelo"
                className="input mono"
                value={ai.model}
                onChange={(e) => setAi({ model: e.target.value })}
                placeholder={ai.provider === 'anthropic' ? 'Predeterminado' : local ? 'El primero cargado' : 'Obligatorio'}
                spellCheck={false}
              />
            </div>
          )}

          {local ? (
            <div className="field">
              <label htmlFor="url-local">Dirección del servidor local</label>
              <input
                id="url-local"
                className="input mono"
                value={ai.localUrl}
                onChange={(e) => setAi({ localUrl: e.target.value })}
                placeholder={ai.provider === 'ollama' ? 'http://localhost:11434/v1' : 'http://localhost:1234/v1'}
                spellCheck={false}
              />
            </div>
          ) : null}

          <fieldset className="field">
            <legend className="label">Qué se envía al modelo</legend>
            <div className="radios">
              {PRIVACY.filter((p) => !(p.value === 'local' && !local)).map((p) => (
                <label key={p.value} className="check">
                  <input type="radio" name="privacidad" checked={ai.privacy === p.value} onChange={() => setAi({ privacy: p.value })} />
                  <span>
                    {p.label}
                    <span className="hint">{p.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="field-row">
            <div className="field field-inline">
              <label htmlFor="limite">Hallazgos a explicar por análisis</label>
              <input id="limite" className="input input-num" type="number" min={1} max={50} value={ai.limit} onChange={(e) => setAi({ limit: Number(e.target.value) })} />
            </div>
            {local ? null : (
              <div className="field field-inline">
                <label htmlFor="presupuesto">Coste máximo por análisis (USD)</label>
                <input id="presupuesto" className="input input-num" type="number" min={0.01} max={50} step={0.05} value={ai.budgetUsd} onChange={(e) => setAi({ budgetUsd: Number(e.target.value) })} />
              </div>
            )}
          </div>
          <label className="check">
            <input type="checkbox" checked={ai.plan} onChange={(e) => setAi({ plan: e.target.checked })} />
            <span>Proponer un plan de reducción de la deuda</span>
          </label>

          {ai.provider === 'openrouter' ? (
            <>
              <label className="check">
                <input type="checkbox" checked={ai.allowDataCollection} onChange={(e) => setAi({ allowDataCollection: e.target.checked, ...(e.target.checked ? { zeroDataRetention: false } : {}) })} />
                <span>
                  Permitir proveedores que guardan o entrenan con los datos
                  <span className="hint">Necesario con muchos modelos gratuitos. Con la privacidad en «solo metadatos» no se envía código.</span>
                </span>
              </label>
              <label className="check">
                <input type="checkbox" checked={ai.zeroDataRetention} disabled={ai.allowDataCollection} onChange={(e) => setAi({ zeroDataRetention: e.target.checked })} />
                <span>
                  Solo proveedores de retención cero
                  <span className="hint">Más restrictivo: algunos modelos no tendrán ningún proveedor disponible.</span>
                </span>
              </label>
              <div className="field">
                <label htmlFor="razonamiento">Razonamiento de los modelos que razonan</label>
                <select id="razonamiento" className="select" value={ai.reasoning} onChange={(e) => setAi({ reasoning: e.target.value as ReasoningLevel })}>
                  {REASONING.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <span className="hint">El razonamiento consume parte de la respuesta; desactivado, las explicaciones llegan antes y no se cortan.</span>
              </div>
            </>
          ) : null}

          <label className="check">
            <input type="checkbox" checked={ai.auto} onChange={(e) => setAi({ auto: e.target.checked })} />
            <span>
              Explicar automáticamente al terminar cada análisis
              <span className="hint">Si no, puedes pedir la explicación de cada hallazgo desde su detalle.</span>
            </span>
          </label>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="s-claves">
        <div className="settings-intro">
          <h2 id="s-claves">Credenciales</h2>
          <p>Se guardan cifradas con el sistema (en Windows, DPAPI) y nunca vuelven a mostrarse. También se aceptan las variables de entorno de la línea de comandos.</p>
        </div>
        <div className="settings-fields">
          {secrets && !secrets.encryptionAvailable ? (
            <p className="form-error">Este equipo no ofrece un almacén cifrado: no se pueden guardar credenciales. Usa las variables de entorno indicadas.</p>
          ) : null}
          {secrets ? SECRET_NAMES.map((name) => <SecretRow key={name} name={name} status={secrets} onChange={setSecrets} />) : null}
        </div>
      </section>

      {info ? (
        <section className="settings-section" aria-labelledby="s-acerca">
          <div className="settings-intro">
            <h2 id="s-acerca">Aplicación</h2>
          </div>
          <dl className="about">
            <dt>Versión</dt>
            <dd>{info.versions.app}</dd>
            <dt>Electron, Chromium y Node</dt>
            <dd>
              {info.versions.electron}, {info.versions.chrome} y {info.versions.node}
            </dd>
            <dt>Datos de la aplicación</dt>
            <dd className="mono">{info.dataDir}</dd>
          </dl>
        </section>
      ) : null}

      {dirty || errors || savedOk ? (
        <div className="save-bar" role="region" aria-label="Guardar cambios">
          {errors ? <p className="form-error">{errors}</p> : dirty ? <p>Tienes cambios sin guardar.</p> : <p>Cambios guardados.</p>}
          {dirty ? (
            <>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  setDraft(saved);
                  setErrors(null);
                }}
              >
                Descartar
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void save().then(() => setTimeout(() => setSavedOk(false), 2500))}>
                Guardar cambios
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function OpenRouterModels({ model, fallback, onModel, onFallback }: { model: string; fallback: string[]; onModel: (m: string) => void; onFallback: (f: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<CatalogModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [onlyFree, setOnlyFree] = useState(false);
  const [hideMandatory, setHideMandatory] = useState(true);

  useEffect(() => {
    if (!open || catalog) return;
    let cancelled = false;
    window.radar.ai
      .models()
      .then((m) => !cancelled && setCatalog(m))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [open, catalog]);

  const filtered = useMemo(() => {
    const q = fold(query.trim());
    return (catalog ?? []).filter(
      (m) =>
        m.structuredOutputs && (!onlyFree || m.free) && (!hideMandatory || (m.reasoning !== 'obligatorio' && m.reasoning !== 'no ajustable')) && (q === '' || fold(`${m.id} ${m.name}`).includes(q)),
    );
  }, [catalog, query, onlyFree, hideMandatory]);

  const price = (m: CatalogModel): string =>
    m.free
      ? 'Gratis'
      : m.inputPerMTok === null || m.outputPerMTok === null
        ? '—'
        : `${m.inputPerMTok.toLocaleString('es', { maximumFractionDigits: 2 })} / ${m.outputPerMTok.toLocaleString('es', { maximumFractionDigits: 2 })}`;

  return (
    <div className="field field-wide">
      <label htmlFor="modelo-or">Modelo</label>
      <div className="model-line">
        <input id="modelo-or" className="input mono" value={model} onChange={(e) => onModel(e.target.value.trim())} placeholder="proveedor/modelo" spellCheck={false} />
        <button type="button" className="btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Cerrar la lista' : 'Elegir de la lista'}
        </button>
      </div>
      {fallback.length > 0 ? (
        <div className="fallbacks">
          <span className="hint">Respaldo, por orden, si el modelo falla o está saturado:</span>
          {fallback.map((f) => (
            <button key={f} type="button" className="chip" aria-pressed="true" onClick={() => onFallback(fallback.filter((x) => x !== f))} title="Quitar de los respaldos">
              <span className="mono">{f}</span>
              <Icon name="close" size={12} />
            </button>
          ))}
        </div>
      ) : null}
      {open ? (
        <div className="catalog">
          <div className="catalog-filters">
            <label className="search">
              <Icon name="search" size={16} />
              <span className="visually-hidden">Buscar modelo</span>
              <input className="input" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar (qwen, llama, nemotron…)" />
            </label>
            <label className="check">
              <input type="checkbox" checked={onlyFree} onChange={(e) => setOnlyFree(e.target.checked)} />
              <span>Solo gratuitos</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={hideMandatory} onChange={(e) => setHideMandatory(e.target.checked)} />
              <span>Ocultar los que siempre razonan</span>
            </label>
          </div>
          {error ? <p className="form-error">{error}</p> : null}
          {!catalog && !error ? <p className="muted">Cargando el catálogo de OpenRouter…</p> : null}
          {catalog ? (
            <>
              <p className="hint">
                {filtered.length} modelos compatibles. Precio en USD por millón de tokens de entrada y de salida. Los gratuitos tienen un límite de peticiones al día y suelen requerir permitir
                proveedores que guardan datos.
              </p>
              <div className="catalog-scroll">
                <table className="table catalog-table">
                  <thead>
                    <tr>
                      <th scope="col" className="col-model">
                        Modelo
                      </th>
                      <th scope="col" className="num">
                        Precio
                      </th>
                      <th scope="col" className="num">
                        Contexto
                      </th>
                      <th scope="col">Razonamiento</th>
                      <th scope="col">
                        <span className="visually-hidden">Acciones</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.slice(0, 60).map((m) => (
                      <tr key={m.id} aria-current={m.id === model || undefined}>
                        <td className="mono" title={m.name}>
                          {m.id}
                        </td>
                        <td className="num">{price(m)}</td>
                        <td className="num">{m.contextLength ? `${Math.round(m.contextLength / 1000)}k` : '—'}</td>
                        <td>{m.reasoning}</td>
                        <td className="actions">
                          <button type="button" className="btn btn-small" onClick={() => onModel(m.id)} disabled={m.id === model}>
                            Usar
                          </button>
                          <button
                            type="button"
                            className="btn btn-quiet btn-small"
                            onClick={() => onFallback([...fallback, m.id])}
                            disabled={m.id === model || fallback.includes(m.id) || fallback.length >= 3}
                            title={fallback.length >= 3 ? 'Como mucho 3 respaldos' : undefined}
                          >
                            Respaldo
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {filtered.length > 60 ? <p className="hint">Y {filtered.length - 60} más: afina la búsqueda.</p> : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SecretRow({ name, status, onChange }: { name: SecretName; status: SecretsStatus; onChange: (s: SecretsStatus) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<{ result: OpenRouterKeyCheck | null; error: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const s = status.secrets[name];
  const state = s.stored ? 'Guardada y cifrada' : s.fromEnv ? `Desde la variable ${ENV_NAMES[name]}` : 'Sin configurar';

  async function act(fn: () => Promise<SecretsStatus>): Promise<void> {
    setBusy(true);
    setError(null);
    setCheck(null);
    try {
      onChange(await fn());
      setValue('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function verify(): Promise<void> {
    setBusy(true);
    setCheck(null);
    try {
      setCheck({ result: await window.radar.ai.checkKey(), error: null });
    } catch (err) {
      setCheck({ result: null, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="secret">
      <div className="secret-head">
        <span className="label">{SECRET_LABELS[name]}</span>
        <span className="secret-state" data-set={s.stored || s.fromEnv || undefined}>
          {s.stored || s.fromEnv ? <Icon name="check" size={14} /> : null}
          {state}
        </span>
        <button type="button" className="btn btn-quiet btn-small secret-link" onClick={() => void window.radar.app.openExternal(KEY_PAGES[name])}>
          <Icon name="external" size={14} /> {name === 'github' ? 'Crear un token' : 'Crear una clave'}
        </button>
      </div>
      <form
        className="secret-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act(() => window.radar.secrets.set(name, value));
        }}
      >
        <input
          className="input mono"
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={s.stored ? 'Pega una nueva para sustituirla' : 'Pega aquí la clave'}
          autoComplete="off"
          spellCheck={false}
          aria-label={SECRET_LABELS[name]}
          disabled={!status.encryptionAvailable}
        />
        <button type="submit" className="btn" disabled={busy || value.trim() === ''}>
          Guardar
        </button>
        {s.stored ? (
          <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => void act(() => window.radar.secrets.delete(name))}>
            Borrar
          </button>
        ) : null}
        {name === 'openrouter' && (s.stored || s.fromEnv) ? (
          <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => void verify()}>
            Comprobar
          </button>
        ) : null}
      </form>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {check?.error ? (
        <p className="form-error" role="alert">
          {check.error}
        </p>
      ) : null}
      {check?.result ? (
        <p className="secret-ok" role="status">
          <Icon name="check" size={14} /> OpenRouter acepta la clave.
          {check.result.freeDaily ? ` Peticiones gratuitas hoy: ${check.result.freeDaily.remaining} de ${check.result.freeDaily.limit}.` : ''}
          {check.result.limitRemaining !== null ? ` Crédito restante de la clave: ${check.result.limitRemaining.toFixed(2)} USD.` : ' La clave no tiene límite de crédito.'}
        </p>
      ) : null}
    </div>
  );
}
