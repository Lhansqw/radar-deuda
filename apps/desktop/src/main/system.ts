import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultCacheDir } from '@radar/engine';
import { cacheUsage, clearCache, folderSize } from '@radar/pipeline';
import { defaultReposDir, parseGitHubRepo, removeClone } from '@radar/sources';
import { app, BrowserWindow, clipboard, dialog, nativeTheme, shell } from 'electron';
import { APPEARANCE_FILE, readTheme, windowBackground, writeTheme } from './appearance.js';
import { buildDiagnostics, ErrorLog, interfaceReporter } from './error-log.js';
import type { AppDeps } from './handlers.js';
import { openExternal } from './security.js';
import { checkForUpdate } from './updates.js';
import { currentLocale, languageSetting, setLanguage, tr } from './i18n.js';

/**
 * Lo que la aplicación usa del sistema y no depende del usuario: diálogos,
 * portapapeles, caché, actualizaciones, tema, diagnóstico y registro de
 * errores. main.ts solo lo conecta.
 */

/** Nombre en inglés de cada parte de la caché (en español lo da @radar/pipeline). */
const CACHE_PART_EN = { motor: 'Per-file analysis', ia: 'AI answers', historial: 'Git history', dependencias: 'Vulnerabilities and versions' } as const;

const versions = () => ({ app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node });

/** Color de fondo de la ventana con el tema actual (mientras carga la interfaz). */
export const currentWindowBackground = (): string => windowBackground(nativeTheme.shouldUseDarkColors);

/**
 * Aplica el tema guardado (oscuro por defecto) antes de crear la ventana, para
 * que no destelle el tema por defecto, y sigue sus cambios (también los del
 * sistema con «Como el sistema»). Devuelve el archivo donde se guarda.
 */
export function setupAppearance(dataDir: string): string {
  const file = path.join(dataDir, APPEARANCE_FILE);
  nativeTheme.themeSource = readTheme(file);
  nativeTheme.on('updated', () => {
    for (const w of BrowserWindow.getAllWindows()) w.setBackgroundColor(currentWindowBackground());
  });
  return file;
}

/**
 * Registro de errores de este equipo, que además observa por su cuenta las
 * excepciones sin capturar del proceso principal (`uncaughtExceptionMonitor`
 * solo observa: no cambia lo que hace Electron con ellas) y los procesos que
 * terminan mal.
 */
export function watchErrors(dataDir: string): ErrorLog {
  const errors = new ErrorLog({ dir: path.join(dataDir, 'registros'), appRoot: app.getAppPath() });
  process.on('uncaughtExceptionMonitor', (err) => errors.record('principal', err));
  app.on('render-process-gone', (_event, _contents, details) => {
    if (details.reason !== 'clean-exit') errors.record('interfaz', `La ventana terminó inesperadamente (${details.reason}, código ${details.exitCode}).`);
  });
  app.on('child-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit') errors.record('principal', `El proceso ${details.type} terminó inesperadamente (${details.reason}, código ${details.exitCode}).`);
  });
  return errors;
}

/** El mismo error con un prefijo en el mensaje (conserva la pila). */
export function prefixed(prefix: string, err: unknown): unknown {
  if (!(err instanceof Error)) return `${prefix}${String(err)}`;
  const copy = new Error(`${prefix}${err.name === 'Error' ? '' : `${err.name}: `}${err.message}`);
  copy.stack = err.stack ?? '';
  return copy;
}

export interface SystemContext {
  dataDir: string;
  /** Carpeta de datos del usuario con sesión (si la hay). */
  userDir: () => string | null;
  window: () => BrowserWindow | null;
  errors: ErrorLog;
  appearanceFile: string;
}

export function systemDeps(ctx: SystemContext): AppDeps {
  const openDialog = async (options: Electron.OpenDialogOptions) => {
    const win = ctx.window();
    return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
  };
  const saveDialog = async (options: Electron.SaveDialogOptions) => {
    const win = ctx.window();
    return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options);
  };
  return {
    info: () => ({
      versions: versions(),
      dataDir: ctx.userDir() ?? ctx.dataDir,
      cacheDir: defaultCacheDir(),
      reposDir: defaultReposDir(),
      language: languageSetting(),
      locale: currentLocale(),
    }),
    setLanguage,
    chooseFolder: async () => {
      const r = await openDialog({ title: tr('Elige la carpeta del proyecto', 'Choose the project folder'), properties: ['openDirectory'] });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    openExternal,
    // Solo se muestra en el explorador: abrir el archivo con su programa asociado podría ejecutarlo (.js, .bat…).
    reveal: (abs) => shell.showItemInFolder(abs),
    copyText: (text) => clipboard.writeText(text),
    storage: async () => {
      const [cache, clones] = await Promise.all([cacheUsage(defaultCacheDir()), folderSize(defaultReposDir())]);
      return { cache: { files: cache.files, bytes: cache.bytes, parts: cache.parts.map(({ name, label, files, bytes }) => ({ label: tr(label, CACHE_PART_EN[name]), files, bytes })) }, clones };
    },
    clearCache: () => clearCache(defaultCacheDir()),
    checkUpdate: () => checkForUpdate(app.getVersion()),
    diagnostics: () =>
      buildDiagnostics({
        versions: versions(),
        os: { platform: process.platform, release: os.release(), arch: process.arch, locale: app.getLocale(), totalMemoryMb: Math.round(os.totalmem() / 2 ** 20), freeMemoryMb: Math.round(os.freemem() / 2 ** 20) },
        uptimeMinutes: Math.round(process.uptime() / 60),
        errors: ctx.errors.recent(20),
      }),
    clearErrors: () => ctx.errors.clear(),
    reportError: interfaceReporter(ctx.errors),
    theme: () => nativeTheme.themeSource,
    setTheme: (theme) => {
      writeTheme(ctx.appearanceFile, theme);
      nativeTheme.themeSource = theme;
      return theme;
    },
    removeClone: async (repo) => {
      const ref = parseGitHubRepo(repo);
      if (ref) await removeClone(ref, defaultReposDir());
    },
    // La interfaz no envía el contenido: el proceso principal guarda el parche que generó él mismo.
    savePatch: async (name, content) => {
      const r = await saveDialog({ title: tr('Guardar el parche', 'Save the patch'), defaultPath: path.join(app.getPath('downloads'), name), filters: [{ name: tr('Parche', 'Patch'), extensions: ['patch', 'diff'] }] });
      if (r.canceled || !r.filePath) return null;
      await writeFile(r.filePath, content, 'utf8');
      return r.filePath;
    },
  };
}
