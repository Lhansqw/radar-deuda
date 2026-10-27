import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnalysisReport, ReportComparison } from '@radar/engine';
import type { JobState } from '../shared/jobs.js';
import type { AnalysisSummary, Project } from '../shared/model.js';

/** Proyectos y estado de los análisis, sincronizados con el proceso principal. */
export function useRadar() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [jobs, setJobs] = useState<Record<number, JobState>>({});
  /** Cambia cuando hay datos nuevos de un proyecto (análisis guardado, IA terminada). */
  const [revisions, setRevisions] = useState<Record<number, number>>({});
  const last = useRef<Record<string, { analysisId: number | null; status: string }>>({});

  const reloadProjects = useCallback(async () => {
    setProjects(await window.radar.projects.list());
  }, []);

  /** Vuelve a cargar los datos de un proyecto (p. ej. tras añadir una explicación de la IA). */
  const refresh = useCallback((projectId: number) => {
    setRevisions((r) => ({ ...r, [projectId]: (r[projectId] ?? 0) + 1 }));
  }, []);

  useEffect(() => {
    void window.radar.projects.list().then(setProjects);
    void window.radar.jobs.list().then((list) => {
      const byProject: Record<number, JobState> = {};
      for (const j of [...list].reverse()) byProject[j.projectId] = j;
      setJobs(byProject);
    });
    return window.radar.jobs.onEvent((s) => {
      setJobs((prev) => ({ ...prev, [s.projectId]: s }));
      const before = last.current[s.jobId];
      last.current[s.jobId] = { analysisId: s.analysisId, status: s.status };
      // Solo se recarga cuando cambia algo que se ve: análisis guardado o trabajo terminado.
      if (before?.analysisId !== s.analysisId || (before?.status !== s.status && s.status !== 'running')) {
        void reloadProjects();
        setRevisions((r) => ({ ...r, [s.projectId]: (r[s.projectId] ?? 0) + 1 }));
      }
    });
  }, [reloadProjects]);

  return { projects, jobs, revisions, reloadProjects, refresh };
}

export interface ProjectData {
  analyses: AnalysisSummary[];
  report: AnalysisReport | null;
  /** Análisis que se está mostrando. */
  analysisId: number | null;
  /** Aún no han llegado los datos de este proyecto (o de la última revisión). */
  loading: boolean;
  error: string | null;
}

interface Loaded {
  key: string;
  analyses: AnalysisSummary[];
  report: AnalysisReport | null;
  analysisId: number | null;
  error: string | null;
}

/** Historial del proyecto y el informe elegido (por defecto, el más reciente). */
export function useProjectData(projectId: number | null, revision: number, chosen: number | null): ProjectData {
  const key = `${projectId}|${revision}|${chosen}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    if (projectId === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const analyses = await window.radar.analyses.list(projectId);
        const id = chosen !== null && analyses.some((a) => a.id === chosen) ? chosen : (analyses[0]?.id ?? null);
        const report = id !== null ? await window.radar.analyses.report(id) : null;
        if (!cancelled) setLoaded({ key, analyses, report, analysisId: id, error: null });
      } catch (err) {
        if (!cancelled) setLoaded({ key, analyses: [], report: null, analysisId: null, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, projectId, chosen]);
  // Mientras llega la nueva versión se muestran los datos anteriores del mismo proyecto (sin parpadeos).
  const sameProject = loaded !== null && loaded.key.split('|')[0] === String(projectId);
  return {
    analyses: sameProject ? loaded.analyses : [],
    report: sameProject ? loaded.report : null,
    analysisId: sameProject ? loaded.analysisId : null,
    loading: loaded?.key !== key,
    error: sameProject ? loaded.error : null,
  };
}

/** Deuda nueva, resuelta y con otra severidad respecto al análisis anterior (null si no hay anterior). */
export function useComparison(analysisId: number | null, previousId: number | null): ReportComparison | null {
  const key = `${previousId}|${analysisId}`;
  const [loaded, setLoaded] = useState<{ key: string; value: ReportComparison | null } | null>(null);
  useEffect(() => {
    if (analysisId === null || previousId === null) return;
    let cancelled = false;
    window.radar.analyses
      .compare(previousId, analysisId)
      .then((value) => !cancelled && setLoaded({ key, value }))
      .catch(() => !cancelled && setLoaded({ key, value: null }));
    return () => {
      cancelled = true;
    };
  }, [key, analysisId, previousId]);
  return loaded?.key === key ? loaded.value : null;
}

/**
 * Lo que la interfaz recuerda de cada proyecto mientras se cambia de vista o
 * de proyecto: filtros de hallazgos, hallazgo seleccionado y análisis elegido
 * en el historial (null: el más reciente).
 */
export function useProjectMemory<F>(emptyFilter: F) {
  const [filters, setFilters] = useState<Record<number, F>>({});
  const [findings, setFindings] = useState<Record<number, string | null>>({});
  const [analyses, setAnalyses] = useState<Record<number, number | null>>({});
  return {
    filterOf: (projectId: number): F => filters[projectId] ?? emptyFilter,
    setFilter: (projectId: number, update: (f: F) => F) => setFilters((all) => ({ ...all, [projectId]: update(all[projectId] ?? emptyFilter) })),
    findingOf: (projectId: number): string | null => findings[projectId] ?? null,
    selectFinding: (projectId: number, findingId: string | null) => setFindings((all) => ({ ...all, [projectId]: findingId })),
    analysisOf: (projectId: number): number | null => analyses[projectId] ?? null,
    chooseAnalysis: (projectId: number, analysisId: number | null) => setAnalyses((all) => ({ ...all, [projectId]: analysisId })),
  };
}

export type ProjectMemory<F> = ReturnType<typeof useProjectMemory<F>>;
