import { useMemo, useState } from 'react';
import type { AnalysisReport } from '@radar/engine';
import { Icon } from '../components/Icon.js';
import { SeverityGlyph } from '../components/SeverityMark.js';
import { formatEffort, formatNumber } from '../lib/format.js';
import { SEVERITY_LABEL } from '../lib/labels.js';
import { buildTree, flattenTree } from '../lib/tree.js';

/** Deuda por carpeta y archivo. Abrir una fila filtra los hallazgos por esa ruta. */
export function Files({ report, onOpenPath }: { report: AnalysisReport; onOpenPath: (path: string) => void }) {
  const root = useMemo(() => buildTree(report.findings.filter((f) => f.locations[0]?.file !== '.')), [report.findings]);
  // Al principio se despliegan las carpetas de primer nivel.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(root.children.filter((c) => !c.isFile).map((c) => c.path)));
  const rows = flattenTree(root, expanded);
  const projectLevel = report.findings.length - root.findings;
  const total = Math.max(1, root.minutes);

  const toggle = (path: string): void =>
    setExpanded((e) => {
      const next = new Set(e);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="files">
      <div className="files-intro">
        <p>
          {formatNumber(root.findings)} hallazgos en archivos, {formatEffort(root.minutes)} de corrección. Cada hallazgo cuenta una vez, en su ubicación principal.
          {projectLevel === 1 ? ' Otro afecta al proyecto entero (por ejemplo, la falta de pruebas).' : projectLevel > 1 ? ` Otros ${projectLevel} afectan al proyecto entero (por ejemplo, la falta de pruebas).` : ''}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="pane-empty">Ningún hallazgo está en un archivo concreto.</p>
      ) : (
        <div role="treegrid" aria-label="Deuda por archivo" className="tree">
          <div role="row" className="tree-row tree-head">
            <span role="columnheader">Ruta</span>
            <span role="columnheader">Peor severidad</span>
            <span role="columnheader">Hallazgos</span>
            <span role="columnheader">Esfuerzo</span>
          </div>
          {rows.map(({ node, depth }) => (
            <div key={node.path} role="row" className="tree-row" aria-level={depth + 1} aria-expanded={node.isFile ? undefined : expanded.has(node.path)}>
              <span role="gridcell" className="tree-name" style={{ paddingLeft: `${depth * 1.25}rem` }}>
                {node.isFile ? (
                  <span className="tree-toggle" aria-hidden="true" />
                ) : (
                  <button type="button" className="tree-toggle" onClick={() => toggle(node.path)} aria-label={expanded.has(node.path) ? `Contraer ${node.name}` : `Desplegar ${node.name}`}>
                    <span data-open={expanded.has(node.path) || undefined}>
                      <Icon name="chevron" size={14} />
                    </span>
                  </button>
                )}
                <Icon name={node.isFile ? 'file' : 'folder'} size={16} />
                <button type="button" className="tree-link mono" onClick={() => onOpenPath(node.path)} title={`Ver los hallazgos de ${node.path}`}>
                  {node.name}
                </button>
              </span>
              <span role="gridcell" className="tree-worst">
                {node.worst ? (
                  <>
                    <SeverityGlyph severity={node.worst} /> {SEVERITY_LABEL[node.worst]}
                  </>
                ) : null}
              </span>
              <span role="gridcell" className="tree-num">
                {node.findings}
              </span>
              <span role="gridcell" className="tree-effort">
                <span className="tree-bar" aria-hidden="true">
                  <span style={{ width: `${(node.minutes / total) * 100}%` }} />
                </span>
                {formatEffort(node.minutes)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
