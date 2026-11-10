import { useMemo, useState } from 'react';
import type { AnalysisReport } from '@radar/engine';
import { Icon } from '../components/Icon.js';
import { SeverityGlyph } from '../components/SeverityMark.js';
import { formatEffort, formatNumber } from '../lib/format.js';
import { SEVERITY_LABEL } from '../lib/labels.js';
import { buildTree, flattenTree } from '../lib/tree.js';
import { tr } from '../i18n.js';

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
          {tr(
            `${formatNumber(root.findings)} hallazgos en archivos, ${formatEffort(root.minutes)} de corrección. Cada hallazgo cuenta una vez, en su ubicación principal.`,
            `${formatNumber(root.findings)} findings in files, ${formatEffort(root.minutes)} to fix. Each finding counts once, at its main location.`,
          )}
          {projectLevel === 1
            ? tr(' Otro afecta al proyecto entero (por ejemplo, la falta de pruebas).', ' Another one affects the whole project (for example, missing tests).')
            : projectLevel > 1
              ? tr(` Otros ${projectLevel} afectan al proyecto entero (por ejemplo, la falta de pruebas).`, ` ${projectLevel} others affect the whole project (for example, missing tests).`)
              : ''}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="pane-empty">{tr('Ningún hallazgo está en un archivo concreto.', 'No finding is in a specific file.')}</p>
      ) : (
        <div role="treegrid" aria-label={tr('Deuda por archivo', 'Debt by file')} className="tree">
          <div role="row" className="tree-row tree-head">
            <span role="columnheader">{tr('Ruta', 'Path')}</span>
            <span role="columnheader">{tr('Peor severidad', 'Worst severity')}</span>
            <span role="columnheader">{tr('Hallazgos', 'Findings')}</span>
            <span role="columnheader">{tr('Esfuerzo', 'Effort')}</span>
          </div>
          {rows.map(({ node, depth }) => (
            <div key={node.path} role="row" className="tree-row" aria-level={depth + 1} aria-expanded={node.isFile ? undefined : expanded.has(node.path)}>
              <span role="gridcell" className="tree-name" style={{ paddingLeft: `${depth * 1.25}rem` }}>
                {node.isFile ? (
                  <span className="tree-toggle" aria-hidden="true" />
                ) : (
                  <button type="button" className="tree-toggle" onClick={() => toggle(node.path)} aria-label={expanded.has(node.path) ? tr(`Contraer ${node.name}`, `Collapse ${node.name}`) : tr(`Desplegar ${node.name}`, `Expand ${node.name}`)}>
                    <span data-open={expanded.has(node.path) || undefined}>
                      <Icon name="chevron" size={14} />
                    </span>
                  </button>
                )}
                <Icon name={node.isFile ? 'file' : 'folder'} size={16} />
                <button type="button" className="tree-link mono" onClick={() => onOpenPath(node.path)} title={tr(`Ver los hallazgos de ${node.path}`, `See the findings of ${node.path}`)}>
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
