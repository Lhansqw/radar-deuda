import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultCacheDir } from '@radar/engine';
import { defaultReposDir, parseGitHubRepo, removeClone } from '@radar/sources';
import { cacheUsage, clearCache, folderSize, pruneCache } from '@radar/pipeline';
import { app, BrowserWindow, clipboard, dialog, nativeTheme, safeStorage, shell } from 'electron';
import { JOB_EVENT_CHANNEL } from '../shared/ipc.js';
import { APP_ENTRY } from '../shared/origin.js';
import { AiService } from './ai-service.js';
import { CredentialStore } from './credentials.js';
import { createHandlers, loadSettings } from './handlers.js';
import { registerIpc } from './ipc.js';
import { JobManager } from './jobs.js';
import { devServerFromEnv } from './policy.js';
import { registerAppScheme, serveRenderer } from './protocol.js';
import { enableSandboxEverywhere, hardenApp, openExternal } from './security.js';
import { Store } from './store.js';
import { spawnAnalysisWorker } from './worker-process.js';

/** URL del servidor de Vite en desarrollo (npm run dev); null en la aplicación compilada o empaquetada. */
const devServerUrl = devServerFromEnv(process.env['RADAR_DEV_SERVER_URL'], app.isPackaged);
/** Carpeta del proceso principal compilado (dist/; el empaquetado es CommonJS). */
const distDir = __dirname;

// Datos en %APPDATA%\radar-deuda (o la carpeta indicada, para pruebas aisladas).
app.setPath('userData', process.env['RADAR_DATA_DIR'] ?? path.join(app.getPath('appData'), 'radar-deuda'));

// Ambas deben ocurrir antes de que la aplicación esté lista.
registerAppScheme();
enableSandboxEverywhere();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.on('window-all-closed', () => app.quit());
  app
    .whenReady()
    .then(start)
    .catch((err: unknown) => {
      console.error('No se pudo iniciar la aplicación:', err);
      app.exit(1);
    });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: 'Radar de Deuda Técnica',
    backgroundColor: '#131b26',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(distDir, 'preload.cjs'),
      // Valores por defecto de Electron, explícitos para que no dependan de la versión.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
      // Las herramientas de desarrollo solo fuera de la aplicación instalada.
      devTools: !app.isPackaged,
    },
  });
  win.once('ready-to-show', () => win.show());
  void win.loadURL(devServerUrl ?? APP_ENTRY);
  return win;
}

function start(): void {
  // La interfaz es oscura: la barra de título y los controles nativos también.
  nativeTheme.themeSource = 'dark';
  hardenApp(devServerUrl);
  if (!devServerUrl) serveRenderer(path.join(distDir, 'renderer'));

  const dataDir = app.getPath('userData');
  const store = Store.open(path.join(dataDir, 'radar.db'));
  app.on('will-quit', () => store.close());
  const credentials = new CredentialStore(store, safeStorage);
  const jobs = new JobManager({
    store,
    credentials,
    settings: () => loadSettings(store),
    spawn: ({ memoryLimitMb }) => spawnAnalysisWorker(path.join(distDir, 'worker.cjs'), memoryLimitMb),
    emit: (state) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send(JOB_EVENT_CHANNEL, state);
    },
  });
  app.on('before-quit', () => jobs.dispose());
  let win: BrowserWindow | null = null;
  registerIpc(
    createHandlers({
      store,
      credentials,
      jobs,
      ai: new AiService({ store, credentials, settings: () => loadSettings(store) }),
      info: () => ({ versions: { app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node }, dataDir, cacheDir: defaultCacheDir(), reposDir: defaultReposDir() }),
      chooseFolder: async () => {
        const options = { title: 'Elige la carpeta del proyecto', properties: ['openDirectory' as const] };
        const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
        return r.canceled ? null : (r.filePaths[0] ?? null);
      },
      openExternal,
      // Solo se muestra en el explorador: abrir el archivo con su programa asociado podría ejecutarlo (.js, .bat…).
      reveal: (abs) => shell.showItemInFolder(abs),
      copyText: (text) => clipboard.writeText(text),
      storage: async () => {
        const [cache, clones] = await Promise.all([cacheUsage(defaultCacheDir()), folderSize(defaultReposDir())]);
        return { cache: { files: cache.files, bytes: cache.bytes, parts: cache.parts.map(({ label, files, bytes }) => ({ label, files, bytes })) }, clones };
      },
      clearCache: () => clearCache(defaultCacheDir()),
      removeClone: async (repo) => {
        const ref = parseGitHubRepo(repo);
        if (ref) await removeClone(ref, defaultReposDir());
      },
      // La interfaz no envía el contenido: el proceso principal guarda el parche que generó él mismo.
      savePatch: async (name, content) => {
        const options = { title: 'Guardar el parche', defaultPath: path.join(app.getPath('downloads'), name), filters: [{ name: 'Parche', extensions: ['patch', 'diff'] }] };
        const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
        if (r.canceled || !r.filePath) return null;
        await writeFile(r.filePath, content, 'utf8');
        return r.filePath;
      },
    }),
    devServerUrl,
  );
  win = createWindow();
  // Limpieza en segundo plano de lo que lleva 90 días sin usarse (la caché es compartida con la CLI).
  setTimeout(() => void pruneCache(defaultCacheDir(), 90).catch(() => undefined), 20_000).unref();
}
