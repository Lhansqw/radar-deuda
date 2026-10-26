import { useEffect, useState } from 'react';
import type { AppInfo } from '../shared/ipc.js';
import type { Project } from '../shared/model.js';

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  useEffect(() => {
    void window.radar.app.info().then(setInfo);
    void window.radar.projects.list().then(setProjects);
  }, []);
  return (
    <main className="splash">
      <h1>Radar de Deuda Técnica</h1>
      <p>{info ? `v${info.versions.app} · Electron ${info.versions.electron} · ${projects.length} proyecto(s)` : 'Cargando…'}</p>
    </main>
  );
}
