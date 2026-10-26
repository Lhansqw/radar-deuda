import path from 'node:path';
import { app, BrowserWindow, dialog, nativeTheme, safeStorage, shell } from 'electron';
import { JOB_EVENT_CHANNEL } from '../shared/ipc.js';
import { APP_ENTRY } from '../shared/origin.js';
import { CredentialStore } from './credentials.js';
import { createHandlers, loadSettings } from './handlers.js';
import { registerIpc } from './ipc.js';
import { JobManager } from './jobs.js';
import { registerAppScheme, serveRenderer } from './protocol.js';
import { enableSandboxEverywhere, hardenApp, openExternal } from './security.js';
import { Store } from './store.js';
import { spawnAnalysisWorker } from './worker-process.js';

/** URL del servidor de Vite en desarrollo (npm run dev); null en la aplicación compilada. */
const devServerUrl = process.env['RADAR_DEV_SERVER_URL'] ?? null;
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
    spawn: () => spawnAnalysisWorker(path.join(distDir, 'worker.cjs')),
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
      info: () => ({ versions: { app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node }, dataDir }),
      chooseFolder: async () => {
        const options = { title: 'Elige la carpeta del proyecto', properties: ['openDirectory' as const] };
        const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
        return r.canceled ? null : (r.filePaths[0] ?? null);
      },
      openExternal,
      // Solo se muestra en el explorador: abrir el archivo con su programa asociado podría ejecutarlo (.js, .bat…).
      reveal: (abs) => shell.showItemInFolder(abs),
    }),
    devServerUrl,
  );
  win = createWindow();
}
