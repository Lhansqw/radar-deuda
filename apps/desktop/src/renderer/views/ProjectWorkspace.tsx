import { useMemo, useState, type ReactNode } from 'react';
import type { JobState } from '../../shared/jobs.js';
import type { Project } from '../../shared/model.js';
import { JobStatus } from '../components/JobStatus.js';
import { ProjectHeader } from '../components/ProjectHeader.js';
import type { View } from '../components/Sidebar.js';
import { EMPTY_FILTER, type FindingFilter } from '../lib/findings.js';
import { useComparison, type ProjectData, type ProjectMemory } from '../state.js';
import { Ask } from './Ask.js';
import { Files } from './Files.js';
import { Findings } from './Findings.js';
import { History } from './History.js';
import { NotAnalyzed } from './NotAnalyzed.js';
import { Panel } from './Panel.js';

type ProjectView = Exclude<View, 'ajustes'>;

interface Props {
  project: Project;
  job: JobState | undefined;
  data: ProjectData;
  view: ProjectView;
  memory: ProjectMemory<FindingFilter>;
  onView: (view: View) => void;
  onAnalyze: () => void;
  /** Ejecuta una acción mostrando su error en el aviso general. */
  run: (fn: () => Promise<unknown>) => void;
  onRemoved: () => Promise<void>;
  /** Tras añadir una explicación de la IA: recargar el análisis y la lista de proyectos. */
  onReportChanged: () => Promise<void>;
}

/** Cabecera, estado del análisis y la vista elegida de un proyecto. */
export function ProjectWorkspace({ project, job, data, view, memory, onView, onAnalyze, run, onRemoved, onReportChanged }: Props) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  return (
    <>
      <ProjectHeader
        project={project}
        job={job}
        onAnalyze={onAnalyze}
        onCancel={(jobId) => run(() => window.radar.jobs.cancel(jobId))}
        onRemove={() => run(async () => (await window.radar.projects.remove(project.id), onRemoved()))}
      />
      {job && !dismissed.has(job.jobId) ? <JobStatus job={job} onDismiss={() => setDismissed((d) => new Set(d).add(job.jobId))} /> : null}
      <div className="workspace-body" data-view={view}>
        {data.report && data.analysisId !== null ? (
          <AnalysisView project={project} data={data as LoadedData} view={view} memory={memory} onView={onView} onReportChanged={onReportChanged} />
        ) : data.loading ? null : (
          <NotAnalyzed running={job?.status === 'running'} onAnalyze={onAnalyze} />
        )}
      </div>
    </>
  );
}

type LoadedData = ProjectData & { report: NonNullable<ProjectData['report']>; analysisId: number };

function AnalysisView({
  project,
  data,
  view,
  memory,
  onView,
  onReportChanged,
}: Pick<Props, 'project' | 'view' | 'memory' | 'onView' | 'onReportChanged'> & { data: LoadedData }) {
  const id = project.id;
  const latestId = data.analyses[0]?.id;
  // Análisis anterior al que se está viendo (para la deuda nueva y resuelta).
  const index = data.analyses.findIndex((a) => a.id === data.analysisId);
  const comparison = useComparison(data.analysisId, index >= 0 ? (data.analyses[index + 1]?.id ?? null) : null);
  const newIds = useMemo(() => (comparison ? new Set(comparison.added.map((f) => f.id)) : undefined), [comparison]);
  const openFinding = (findingId: string | null): void => {
    memory.selectFinding(id, findingId);
    onView('hallazgos');
  };
  const chooseAnalysis = (analysisId: number): void => memory.chooseAnalysis(id, analysisId === latestId ? null : analysisId);

  const views: Record<ProjectView, () => ReactNode> = {
    panel: () => (
      <Panel
        report={data.report}
        analyses={data.analyses}
        analysisId={data.analysisId}
        onOpenFinding={openFinding}
        onOpenFiles={() => onView('archivos')}
        comparison={comparison}
        onShowNew={() => {
          memory.setFilter(id, () => ({ ...EMPTY_FILTER, onlyNew: true }));
          openFinding(comparison?.added[0]?.id ?? null);
        }}
        onOpenHistory={() => onView('historial')}
        onShowLatest={() => memory.chooseAnalysis(id, null)}
      />
    ),
    hallazgos: () => (
      <Findings
        report={data.report}
        analysisId={data.analysisId}
        filter={memory.filterOf(id)}
        newIds={newIds}
        onFilter={(f) => memory.setFilter(id, () => f)}
        selectedId={memory.findingOf(id)}
        onSelect={(findingId) => memory.selectFinding(id, findingId)}
        onExplain={async (analysisId, findingId) => {
          await window.radar.ai.explain(analysisId, findingId);
          await onReportChanged();
        }}
        onOpenSettings={() => onView('ajustes')}
      />
    ),
    archivos: () => (
      <Files
        key={data.analysisId}
        report={data.report}
        onOpenPath={(path) => {
          memory.setFilter(id, (f) => ({ ...f, path }));
          openFinding(null);
        }}
      />
    ),
    historial: () => (
      <History
        analyses={data.analyses}
        viewingId={data.analysisId}
        onView={(analysisId) => {
          chooseAnalysis(analysisId);
          onView('panel');
        }}
        onOpenFinding={(analysisId, findingId) => {
          chooseAnalysis(analysisId);
          openFinding(findingId);
        }}
      />
    ),
    preguntar: () => (
      <Ask
        key={data.analysisId}
        report={data.report}
        analysisId={data.analysisId}
        isOld={data.analysisId !== latestId}
        onOpenFinding={openFinding}
        onOpenSettings={() => onView('ajustes')}
      />
    ),
  };
  return <>{views[view]()}</>;
}
