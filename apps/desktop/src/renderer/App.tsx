import { useCallback, useState } from 'react';
import type { Project } from '../shared/model.js';
import { AddGithubDialog } from './components/AddGithubDialog.js';
import { Icon } from './components/Icon.js';
import { JobStatus } from './components/JobStatus.js';
import { ProjectHeader } from './components/ProjectHeader.js';
import { Sidebar, type View } from './components/Sidebar.js';
import { useProjectData, useRadar } from './state.js';
import { EMPTY_FILTER, type FindingFilter } from './lib/findings.js';
import { Files } from './views/Files.js';
import { Findings } from './views/Findings.js';
import { History } from './views/History.js';
import { NotAnalyzed } from './views/NotAnalyzed.js';
import { Panel } from './views/Panel.js';
import { Welcome } from './views/Welcome.js';

/** Vistas del proyecto que existen en esta versión de la interfaz. */
const PROJECT_VIEWS = ['panel', 'hallazgos', 'archivos', 'historial'] as const;

export function App() {
  const { projects, jobs, revisions, reloadProjects } = useRadar();
  const [chosenId, setSelectedId] = useState<number | null>(null);
  const [view, setView] = useState<View>('panel');
  const [addingGithub, setAddingGithub] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  // Filtros y hallazgo seleccionado, por proyecto (se conservan al cambiar de vista).
  const [filters, setFilters] = useState<Record<number, FindingFilter>>({});
  const [selectedFinding, setSelectedFinding] = useState<Record<number, string | null>>({});
  // Análisis elegido en el historial (null: el más reciente).
  const [chosenAnalysis, setChosenAnalysis] = useState<Record<number, number | null>>({});

  // Al abrir, o si el proyecto elegido desaparece, se muestra el primero.
  const project = projects?.find((p) => p.id === chosenId) ?? projects?.[0] ?? null;
  const selectedId = project?.id ?? null;
  const job = project ? jobs[project.id] : undefined;
  const data = useProjectData(project?.id ?? null, project ? (revisions[project.id] ?? 0) : 0, project ? (chosenAnalysis[project.id] ?? null) : null);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
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

  const addFolder = (): void => void run(async () => added(await window.radar.projects.addFolder()));
  const analyze = (): void => void run(async () => project && window.radar.jobs.start(project.id));

  if (!projects) return <div className="app" />;

  return (
    <div className="app">
      <Sidebar
        projects={projects}
        selectedId={selectedId}
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
        settingsAvailable={false}
      />
      <main className="workspace">
        {error ? (
          <div className="notice" data-tone="error" role="alert">
            <Icon name="alert" size={16} />
            <p>{error}</p>
            <button type="button" className="btn btn-quiet btn-small" onClick={() => setError(null)} aria-label="Cerrar aviso">
              <Icon name="close" size={14} />
            </button>
          </div>
        ) : null}
        {project ? (
          <>
            <ProjectHeader
              project={project}
              job={job}
              onAnalyze={analyze}
              onCancel={(jobId) => void run(() => window.radar.jobs.cancel(jobId))}
              onRemove={() => void run(async () => (await window.radar.projects.remove(project.id), reloadProjects()))}
            />
            {job && !dismissed.has(job.jobId) ? <JobStatus job={job} onDismiss={() => setDismissed((d) => new Set(d).add(job.jobId))} /> : null}
            <div className="workspace-body" data-view={view}>
              {data.report && data.analysisId !== null ? (
                view === 'historial' ? (
                  <History
                    analyses={data.analyses}
                    viewingId={data.analysisId}
                    onView={(id) => {
                      setChosenAnalysis((all) => ({ ...all, [project.id]: id === data.analyses[0]?.id ? null : id }));
                      setView('panel');
                    }}
                    onOpenFinding={(analysisId, findingId) => {
                      setChosenAnalysis((all) => ({ ...all, [project.id]: analysisId === data.analyses[0]?.id ? null : analysisId }));
                      setSelectedFinding((all) => ({ ...all, [project.id]: findingId }));
                      setView('hallazgos');
                    }}
                  />
                ) : view === 'archivos' ? (
                  <Files
                    key={data.analysisId}
                    report={data.report}
                    onOpenPath={(path) => {
                      setFilters((all) => ({ ...all, [project.id]: { ...(all[project.id] ?? EMPTY_FILTER), path } }));
                      setSelectedFinding((all) => ({ ...all, [project.id]: null }));
                      setView('hallazgos');
                    }}
                  />
                ) : view === 'hallazgos' ? (
                  <Findings
                    report={data.report}
                    analysisId={data.analysisId}
                    filter={filters[project.id] ?? EMPTY_FILTER}
                    onFilter={(f) => setFilters((all) => ({ ...all, [project.id]: f }))}
                    selectedId={selectedFinding[project.id] ?? null}
                    onSelect={(id) => setSelectedFinding((all) => ({ ...all, [project.id]: id }))}
                  />
                ) : (
                  <Panel
                    report={data.report}
                    analyses={data.analyses}
                    analysisId={data.analysisId}
                    onOpenFinding={(id) => {
                      setSelectedFinding((all) => ({ ...all, [project.id]: id }));
                      setView('hallazgos');
                    }}
                    onOpenFiles={() => setView('archivos')}
                    onShowLatest={() => setChosenAnalysis((all) => ({ ...all, [project.id]: null }))}
                  />
                )
              ) : data.loading ? null : (
                <NotAnalyzed running={job?.status === 'running'} onAnalyze={analyze} />
              )}
            </div>
          </>
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
