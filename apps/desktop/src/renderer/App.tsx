import { useCallback, useState } from 'react';
import type { Project } from '../shared/model.js';
import { AddGithubDialog } from './components/AddGithubDialog.js';
import { Icon } from './components/Icon.js';
import { Sidebar, type View } from './components/Sidebar.js';
import { EMPTY_FILTER } from './lib/findings.js';
import { useProjectData, useProjectMemory, useRadar } from './state.js';
import { ProjectWorkspace } from './views/ProjectWorkspace.js';
import { Settings } from './views/Settings.js';
import { Welcome } from './views/Welcome.js';

/** Vistas del proyecto que existen en esta versión de la interfaz. */
const PROJECT_VIEWS = ['panel', 'hallazgos', 'archivos', 'historial', 'preguntar'] as const;

export function App() {
  const { projects, jobs, revisions, reloadProjects, refresh } = useRadar();
  const [chosenId, setSelectedId] = useState<number | null>(null);
  const [view, setView] = useState<View>('panel');
  const [addingGithub, setAddingGithub] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const memory = useProjectMemory(EMPTY_FILTER);

  // Al abrir, o si el proyecto elegido desaparece, se muestra el primero.
  const project = projects?.find((p) => p.id === chosenId) ?? projects?.[0] ?? null;
  const projectId = project?.id ?? null;
  const data = useProjectData(projectId, projectId !== null ? (revisions[projectId] ?? 0) : 0, projectId !== null ? memory.analysisOf(projectId) : null);

  const run = useCallback((fn: () => Promise<unknown>) => {
    setError(null);
    fn().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const added = useCallback(
    async (p: Project | null) => {
      if (!p) return;
      await reloadProjects();
      setSelectedId(p.id);
      setView('panel');
    },
    [reloadProjects],
  );

  const addFolder = (): void => run(async () => added(await window.radar.projects.addFolder()));
  const analyze = (): void => run(async () => project && window.radar.jobs.start(project.id));

  if (!projects) return <div className="app" />;

  return (
    <div className="app">
      <Sidebar
        projects={projects}
        selectedId={projectId}
        view={view}
        jobs={jobs}
        views={PROJECT_VIEWS}
        counts={data.report ? { hallazgos: data.report.findings.length } : {}}
        onSelect={(id) => {
          setSelectedId(id);
          if (view === 'ajustes') setView('panel');
        }}
        onView={setView}
        onAddFolder={addFolder}
        onAddGithub={() => setAddingGithub(true)}
        settingsAvailable
      />
      <main className="workspace">
        {error ? <ErrorNotice message={error} onClose={() => setError(null)} /> : null}
        {view === 'ajustes' ? (
          <div className="workspace-body">
            <Settings />
          </div>
        ) : project ? (
          <ProjectWorkspace
            project={project}
            job={jobs[project.id]}
            data={data}
            view={view}
            memory={memory}
            onView={setView}
            onAnalyze={analyze}
            run={run}
            onRemoved={reloadProjects}
            onReportChanged={async () => {
              refresh(project.id);
              await reloadProjects();
            }}
          />
        ) : (
          <div className="workspace-body">
            <Welcome onAddFolder={addFolder} onAddGithub={() => setAddingGithub(true)} />
          </div>
        )}
      </main>
      {addingGithub ? (
        <AddGithubDialog
          onClose={() => setAddingGithub(false)}
          onAdded={(p) => {
            setAddingGithub(false);
            void added(p);
          }}
        />
      ) : null}
    </div>
  );
}

function ErrorNotice({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="notice" data-tone="error" role="alert">
      <Icon name="alert" size={16} />
      <p>{message}</p>
      <button type="button" className="btn btn-quiet btn-small" onClick={onClose} aria-label="Cerrar aviso">
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
