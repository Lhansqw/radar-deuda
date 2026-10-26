import { SEVERITY_ORDER, type Finding, type Severity } from '@radar/engine';

export interface TreeNode {
  name: string;
  /** Ruta relativa a la raíz del proyecto ('' para la raíz). */
  path: string;
  isFile: boolean;
  children: TreeNode[];
  findings: number;
  minutes: number;
  worst: Severity | null;
}

interface MutableNode extends TreeNode {
  childMap: Map<string, MutableNode>;
}

function node(name: string, path: string, isFile: boolean): MutableNode {
  return { name, path, isFile, children: [], childMap: new Map(), findings: 0, minutes: 0, worst: null };
}

/**
 * Árbol de archivos con la deuda acumulada por carpeta. Cada hallazgo cuenta
 * una sola vez, en su ubicación principal, para que la suma de las carpetas
 * coincida con el total del proyecto. Las carpetas con un único hijo carpeta
 * se compactan ("src/clientes"), como hacen los editores.
 */
export function buildTree(findings: readonly Finding[]): TreeNode {
  const root = node('', '', false);
  for (const f of findings) {
    const file = f.locations[0]?.file;
    if (!file || file === '.') {
      add(root, f);
      continue;
    }
    const parts = file.split('/');
    let cur = root;
    add(cur, f);
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/');
      let next = cur.childMap.get(part);
      if (!next) {
        next = node(part, path, i === parts.length - 1);
        cur.childMap.set(part, next);
      }
      add(next, f);
      cur = next;
    });
  }
  return finalize(root);
}

function add(n: MutableNode, f: Finding): void {
  n.findings++;
  n.minutes += f.effort.minutes;
  if (n.worst === null || SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[n.worst]) n.worst = f.severity;
}

function finalize(n: MutableNode): TreeNode {
  const children = [...n.childMap.values()].map(finalize);
  children.sort((a, b) => b.minutes - a.minutes || Number(a.isFile) - Number(b.isFile) || a.name.localeCompare(b.name));
  // Compactar cadenas de carpetas con un solo hijo carpeta (sin tocar la raíz).
  const only = children.length === 1 ? children[0] : undefined;
  if (n.path !== '' && !n.isFile && only && !only.isFile) return { ...only, name: `${n.name}/${only.name}` };
  return { name: n.name, path: n.path, isFile: n.isFile, children, findings: n.findings, minutes: n.minutes, worst: n.worst };
}

/** Filas visibles del árbol según las carpetas desplegadas. */
export function flattenTree(root: TreeNode, expanded: ReadonlySet<string>): Array<{ node: TreeNode; depth: number }> {
  const out: Array<{ node: TreeNode; depth: number }> = [];
  const walk = (n: TreeNode, depth: number): void => {
    for (const c of n.children) {
      out.push({ node: c, depth });
      if (!c.isFile && expanded.has(c.path)) walk(c, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}
