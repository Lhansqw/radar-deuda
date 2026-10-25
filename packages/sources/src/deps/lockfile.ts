import semver from 'semver';

/**
 * Inventario de paquetes instalados a partir de package-lock.json (v1, v2 y
 * v3). Solo se leen datos: nunca se ejecuta npm sobre el repositorio.
 */

export interface InstalledPackage {
  name: string;
  version: string;
  /** Declarado en un package.json del proyecto (no transitivo). */
  direct: boolean;
  /** Solo se instala para desarrollo (no llega a producción). */
  dev: boolean;
  /** Rutas dentro del lockfile (`node_modules/a/node_modules/b`). */
  paths: string[];
}

export interface Inventory {
  lockfileVersion: number;
  packages: InstalledPackage[];
  /** Entradas omitidas por no tener versión del registro (git, file:, enlaces). */
  skipped: number;
}

interface LockV2Entry {
  name?: string;
  version?: string;
  dev?: boolean;
  devOptional?: boolean;
  link?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface LockV1Entry {
  version?: string;
  dev?: boolean;
  dependencies?: Record<string, LockV1Entry>;
}

interface Lockfile {
  lockfileVersion?: number;
  packages?: Record<string, LockV2Entry>;
  dependencies?: Record<string, LockV1Entry>;
}

/** Nombre del paquete a partir de su ruta en el lockfile (admite @scope/nombre). */
export function nameFromPath(p: string): string | null {
  const i = p.lastIndexOf('node_modules/');
  if (i < 0) return null;
  const rest = p.slice(i + 'node_modules/'.length);
  const parts = rest.split('/');
  if (parts[0]?.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0] ?? null;
}

function declared(entry: LockV2Entry | undefined): Set<string> {
  const out = new Set<string>();
  for (const section of [entry?.dependencies, entry?.devDependencies, entry?.optionalDependencies, entry?.peerDependencies]) {
    for (const name of Object.keys(section ?? {})) out.add(name);
  }
  return out;
}

export function parseNpmLockfile(text: string): Inventory {
  let lock: Lockfile;
  try {
    lock = JSON.parse(text) as Lockfile;
  } catch (err) {
    throw new Error('package-lock.json no es JSON válido.', { cause: err });
  }
  const byKey = new Map<string, InstalledPackage>();
  let skipped = 0;
  const add = (name: string, version: string | undefined, dev: boolean, direct: boolean, at: string): void => {
    if (!version || !semver.valid(version)) {
      skipped++;
      return;
    }
    const key = `${name}@${version}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.paths.push(at);
      existing.direct ||= direct;
      existing.dev &&= dev; // si alguna copia es de producción, cuenta como producción
    } else byKey.set(key, { name, version, direct, dev, paths: [at] });
  };

  if (lock.packages) {
    // v2/v3: la clave "" es el proyecto raíz; las carpetas de workspaces son claves sin node_modules.
    const directNames = declared(lock.packages['']);
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (key !== '' && !key.includes('node_modules/')) for (const n of declared(entry)) directNames.add(n);
    }
    for (const [key, entry] of Object.entries(lock.packages)) {
      // La raíz, los enlaces y las carpetas de workspaces son código propio, no paquetes del registro.
      if (key === '' || entry.link || !key.includes('node_modules/')) continue;
      const name = entry.name ?? nameFromPath(key);
      if (!name) continue;
      // Primer nivel = un solo segmento node_modules/ (en la raíz o en la carpeta de un workspace).
      const topLevel = key.split('node_modules/').length === 2;
      add(name, entry.version, entry.dev === true || entry.devOptional === true, topLevel && directNames.has(name), key);
    }
    return { lockfileVersion: lock.lockfileVersion ?? 2, packages: sorted(byKey), skipped };
  }

  // v1: árbol anidado en "dependencies"; los de primer nivel pueden ser directos o elevados.
  const walk = (deps: Record<string, LockV1Entry>, prefix: string, depth: number): void => {
    for (const [name, entry] of Object.entries(deps)) {
      const at = `${prefix}node_modules/${name}`;
      add(name, entry.version, entry.dev === true, depth === 0, at);
      if (entry.dependencies) walk(entry.dependencies, `${at}/`, depth + 1);
    }
  };
  walk(lock.dependencies ?? {}, '', 0);
  return { lockfileVersion: lock.lockfileVersion ?? 1, packages: sorted(byKey), skipped };
}

function sorted(map: Map<string, InstalledPackage>): InstalledPackage[] {
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name) || semver.compare(a.version, b.version));
}

/** Línea (base 1) de la entrada de un paquete en el texto del lockfile, para ubicar el hallazgo. */
export function lockfileLine(lines: readonly string[], pkgPath: string, name: string): number {
  const needles = [`"${pkgPath}": {`, `"${name}": {`];
  for (const needle of needles) {
    const i = lines.findIndex((l) => l.includes(needle));
    if (i >= 0) return i + 1;
  }
  return 1;
}
