import { useEffect, useState } from 'react';
import type { AppInfo } from '../../shared/ipc.js';
import type { SecretsStatus } from '../../shared/secrets.js';
import type { AppSettings } from '../../shared/settings.js';
import { AiSection } from './settings/AiSection.js';
import { AnalysisSection } from './settings/AnalysisSection.js';
import { AppSection } from './settings/AppSection.js';
import { Credentials } from './settings/Credentials.js';
import { errorText } from './settings/SettingsSection.js';

/** Cuánto se ve «Cambios guardados» después de guardar. */
const SAVED_NOTICE_MS = 2500;

/** Ajustes guardados y borrador que se edita; se guardan todos a la vez. */
function useSettingsDraft() {
  const [saved, setSaved] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);

  useEffect(() => {
    void window.radar.settings.get().then((s) => {
      setSaved(s);
      setDraft(s);
    });
  }, []);

  useEffect(() => {
    if (!savedOk) return;
    const t = setTimeout(() => setSavedOk(false), SAVED_NOTICE_MS);
    return () => clearTimeout(t);
  }, [savedOk]);

  const save = async (): Promise<void> => {
    if (!draft) return;
    setError(null);
    try {
      const s = await window.radar.settings.set(draft);
      setSaved(s);
      setDraft(s);
      setSavedOk(true);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const discard = (): void => {
    setDraft(saved);
    setError(null);
  };

  const dirty = draft !== null && saved !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  return { draft, setDraft, error, savedOk, dirty, save, discard };
}

export function Settings() {
  const settings = useSettingsDraft();
  const [secrets, setSecrets] = useState<SecretsStatus | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    void window.radar.secrets.status().then(setSecrets);
    void window.radar.app.info().then(setInfo);
  }, []);

  const { draft, setDraft } = settings;
  if (!draft) return null;
  return (
    <div className="settings">
      <header className="settings-head">
        <h1>Configuración</h1>
      </header>
      <AnalysisSection value={draft.analysis} onChange={(patch) => setDraft({ ...draft, analysis: { ...draft.analysis, ...patch } })} />
      <AiSection value={draft.ai} onChange={(patch) => setDraft({ ...draft, ai: { ...draft.ai, ...patch } })} />
      <Credentials status={secrets} onChange={setSecrets} />
      {info ? <AppSection info={info} /> : null}
      <SaveBar dirty={settings.dirty} error={settings.error} savedOk={settings.savedOk} onSave={() => void settings.save()} onDiscard={settings.discard} />
    </div>
  );
}

/** Barra fija abajo mientras hay cambios sin guardar, un error o la confirmación. */
function SaveBar({ dirty, error, savedOk, onSave, onDiscard }: { dirty: boolean; error: string | null; savedOk: boolean; onSave: () => void; onDiscard: () => void }) {
  if (!dirty && !error && !savedOk) return null;
  return (
    <div className="save-bar" role="region" aria-label="Guardar cambios">
      {error ? <p className="form-error">{error}</p> : dirty ? <p>Tienes cambios sin guardar.</p> : <p>Cambios guardados.</p>}
      {dirty ? (
        <>
          <button type="button" className="btn btn-quiet" onClick={onDiscard}>
            Descartar
          </button>
          <button type="button" className="btn btn-primary" onClick={onSave}>
            Guardar cambios
          </button>
        </>
      ) : null}
    </div>
  );
}
