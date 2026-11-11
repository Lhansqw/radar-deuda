import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { AnalysisReport } from '@radar/engine';
import { Icon } from '../components/Icon.js';
import { SeverityGlyph } from '../components/SeverityMark.js';
import { formatEffort, formatNumber } from '../lib/format.js';
import { SEVERITY_LABEL } from '../lib/labels.js';
import { buildTree, flattenTree, type TreeNode } from '../lib/tree.js';
import { squarify } from '../lib/treemap.js';
import { tr } from '../i18n.js';

/** Deuda por carpeta y archivo. Abrir una fila filtra los hallazgos por esa ruta. */
export function Files({ report, onOpenPath }: { report: AnalysisReport; onOpenPath: (path: string) => void }) {
  const root = useMemo(() => buildTree(report.findings.filter((f) => f.locations[0]?.file !== '.')), [report.findings]);
  // Al principio se despliegan las carpetas de primer nivel.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(root.children.filter((c) => !c.isFile).map((c) => c.path)));
  const [mode, setMode] = useState<'mapa' | 'lista'>('mapa');
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
        {rows.length > 0 ? (
          <div className="files-mode" role="group" aria-label={tr('Forma de ver los archivos', 'How to show the files')}>
            <button type="button" className="chip" aria-pressed={mode === 'mapa'} onClick={() => setMode('mapa')}>
              <Icon name="panel" size={14} /> {tr('Mapa', 'Map')}
            </button>
            <button type="button" className="chip" aria-pressed={mode === 'lista'} onClick={() => setMode('lista')}>
              <Icon name="list" size={14} /> {tr('Lista', 'List')}
            </button>
          </div>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="pane-empty">{tr('Ningún hallazgo está en un archivo concreto.', 'No finding is in a specific file.')}</p>
      ) : mode === 'mapa' ? (
        <DebtMap root={root} onOpenPath={onOpenPath} />
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

/** Camino desde la raíz hasta la carpeta con esa ruta (vacío si no existe). */
function trail(root: TreeNode, path: string): TreeNode[] {
  if (path === '') return [root];
  for (const c of root.children) {
    if (c.isFile) continue;
    if (c.path === path) return [root, c];
    if (path.startsWith(`${c.path}/`)) {
      const rest = trail(c, path);
      if (rest.length > 1) return [root, ...rest];
    }
  }
  return [];
}

/** Por debajo de este tamaño (px) la celda no lleva texto; el nombre sigue en su etiqueta accesible. */
const LABEL_W = 96;
const LABEL_H = 46;
/** Una carpeta así de grande enseña su contenido dentro, bajo una cabecera. */
const NEST_W = 200;
const NEST_H = 120;
const HEADER = 30;
const INSET = 3;

const describe = (n: TreeNode): string =>
  `${n.isFile ? tr('Archivo', 'File') : tr('Carpeta', 'Folder')} ${n.path}: ${n.findings} ${tr('hallazgos', 'findings')}, ${formatEffort(n.minutes)}${n.worst ? `, ${tr('peor severidad', 'worst severity')} ${SEVERITY_LABEL[n.worst].toLowerCase()}` : ''}`;

const findingsText = (n: number): string => (n === 1 ? tr('1 hallazgo', '1 finding') : tr(`${n} hallazgos`, `${n} findings`));

/** Celdas de los hijos de una carpeta; lo que no tiene esfuerzo estimado sigue viéndose, con un área mínima. */
const layoutChildren = (n: TreeNode, w: number, h: number) => {
  const floor = Math.max(1, n.minutes) * 0.015;
  return squarify(n.children, (c) => Math.max(c.minutes, floor), w, h);
};

const box = (x: number, y: number, w: number, h: number, sev: TreeNode['worst']): CSSProperties =>
  ({ left: x, top: y, width: w, height: h, '--sev': sev ? `var(--sev-${sev})` : 'var(--linea-fuerte)' }) as CSSProperties;

/**
 * Mapa de la deuda: cada archivo o carpeta ocupa un área según su esfuerzo de
 * corrección y lleva el color de su peor severidad. Las carpetas grandes
 * enseñan su contenido dentro. Entrar en una carpeta la despliega; abrir un
 * archivo filtra los hallazgos por él.
 */
function DebtMap({ root, onOpenPath }: { root: TreeNode; onOpenPath: (path: string) => void }) {
  const area = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [path, setPath] = useState('');
  // Punto desde el que crece el mapa al entrar en una carpeta (en px del mapa).
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const crumbs = trail(root, path);
  const current = crumbs.at(-1) ?? root;
  const cells = layoutChildren(current, size.w, size.h);

  const go = (to: string, from?: { x: number; y: number }): void => {
    setOrigin(from ?? null);
    setPath(to);
  };
  const open = (n: TreeNode, x: number, y: number, w: number, h: number): void => (n.isFile ? onOpenPath(n.path) : go(n.path, { x: x + w / 2, y: y + h / 2 }));

  const leaf = (n: TreeNode, x: number, y: number, w: number, h: number) => (
    <button key={n.path} type="button" className="debtmap-cell" data-folder={!n.isFile || undefined} style={box(x, y, w, h, n.worst)} aria-label={describe(n)} title={describe(n)} onClick={() => open(n, x, y, w, h)}>
      {w >= LABEL_W && h >= LABEL_H ? (
        <>
          <span className="debtmap-name mono">
            {n.worst ? <SeverityGlyph severity={n.worst} /> : null}
            {n.name}
            {n.isFile ? '' : '/'}
          </span>
          <span className="debtmap-meta">
            {formatEffort(n.minutes)}, {findingsText(n.findings)}
          </span>
        </>
      ) : null}
    </button>
  );

  return (
    <div className="debtmap-wrap">
      <nav className="debtmap-crumbs" aria-label={tr('Carpeta del mapa', 'Map folder')}>
        {crumbs.map((n, i) => {
          const last = i === crumbs.length - 1;
          const name = n.path === '' ? tr('Proyecto', 'Project') : n.name;
          return (
            <span key={n.path || '.'}>
              {i > 0 ? <span className="debtmap-sep" aria-hidden="true">/</span> : null}
              {last ? (
                <span className="mono" aria-current="location">
                  {name}
                </span>
              ) : (
                <button type="button" className="tree-link mono" onClick={() => go(n.path)}>
                  {name}
                </button>
              )}
            </span>
          );
        })}
      </nav>
      <div className="debtmap" ref={area} role="group" aria-label={tr('Mapa de la deuda por archivo', 'Debt map by file')}>
        <div key={path} className="debtmap-layer" data-zoom={origin ? true : undefined} style={origin ? { transformOrigin: `${origin.x}px ${origin.y}px` } : undefined}>
          {cells.map(({ item: n, x, y, w, h }) => {
            if (n.isFile || n.children.length === 0 || w < NEST_W || h < NEST_H) return leaf(n, x, y, w, h);
            const inner = layoutChildren(n, w - 2 * INSET, h - HEADER - INSET);
            return (
              <Fragment key={n.path}>
                <div className="debtmap-group" style={box(x, y, w, h, n.worst)}>
                  <button type="button" className="debtmap-head" aria-label={describe(n)} title={describe(n)} onClick={() => open(n, x, y, w, h)}>
                    <span className="debtmap-name mono">
                      {n.worst ? <SeverityGlyph severity={n.worst} /> : null}
                      {n.name}/
                    </span>
                    <span className="debtmap-meta">
                      {formatEffort(n.minutes)}, {findingsText(n.findings)}
                    </span>
                  </button>
                </div>
                {inner.map((c) => leaf(c.item, x + INSET + c.x, y + HEADER + c.y, c.w, c.h))}
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
