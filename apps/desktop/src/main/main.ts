import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultCacheDir } from '@radar/engine';
import { defaultReposDir, parseGitHubRepo, removeClone } from '@radar/sources';
import { cacheUsage, clearCache, folderSize, pruneCache } from '@radar/pipeline';
import { app, BrowserWindow, clipboard, dialog, nativeTheme, safeStorage, shell } from 'electron';
import { ACCOUNT_EVENT_CHANNEL, JOB_EVENT_CHANNEL, SYNC_EVENT_CHANNEL } from '../shared/ipc.js';
import { APP_ENTRY } from '../shared/origin.js';
import { createAccountHandlers } from './account-handlers.js';
import { AccountService } from './account-service.js';
import { cloudConfig, type BuiltCloudConfig } from './cloud-config.js';
import { SupabaseRepo } from './cloud-repo.js';
import type { AppDeps } from './handlers.js';
import { registerIpc } from './ipc.js';
import { devServerFromEnv } from './policy.js';
import { registerAppScheme, serveRenderer } from './protocol.js';
import { enableSandboxEverywhere, hardenApp, openExternal } from './security.js';
import { EncryptedSessionStorage } from './session-storage.js';
import { checkRenderer, checkWorker, SMOKE_FLAG } from './smoke.js';
import { spawnAnalysisWorker } from './worker-process.js';
import { openWorkspace, SessionRouter } from './workspace.js';

/** Conexión con Supabase incrustada al compilar (scripts/config.ts); null si no se definió. */
declare const __RADAR_NUBE__: BuiltCloudConfig | null;
const builtCloud: BuiltCloudConfig | null = typeof __RADAR_NUBE__ === 'undefined' ? null : __RADAR_NUBE__;

/** URL del servidor de Vite en desarrollo (npm run dev); null en la aplicación compilada o empaquetada. */
const devServerUrl = devServerFromEnv(process.env['RADAR_DEV_SERVER_URL'], app.isPackaged);
/** Carpeta del proceso principal compilado (dist/; el empaquetado es CommonJS). */
const distDir = __dirname;

/** Prueba de arranque de la aplicación empaquetada (smoke.ts): datos temporales y salir. */
const smoke = process.argv.includes(SMOKE_FLAG);

// Datos en %APPDATA%\radar-deuda (o la carpeta indicada, para pruebas aisladas).
const dataDirFromEnv = process.env['RADAR_DATA_DIR'];
app.setPath('userData', dataDirFromEnv ?? (smoke ? mkdtempSync(path.join(os.tmpdir(), 'radar-datos-')) : path.join(app.getPath('appData'), 'radar-deuda')));

// Ambas deben ocurrir antes de que la aplicación esté lista.
registerAppScheme();
enableSandboxEverywhere();

// La prueba de arranque no compite con una ventana ya abierta de la aplicación.
if (!smoke && !app.requestSingleInstanceLock()) {
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
  // La prueba de arranque no muestra la ventana: la interfaz se carga y se comprueba igual.
  if (!smoke) win.once('ready-to-show', () => win.show());
  void win.loadURL(devServerUrl ?? APP_ENTRY);
  return win;
}

function start(): void {
  // La interfaz es oscura: la barra de título y los controles nativos también.
  nativeTheme.themeSource = 'dark';
  hardenApp(devServerUrl);
  if (!devServerUrl) serveRenderer(path.join(distDir, 'renderer'));

  const dataDir = app.getPath('userData');
  const spawn = ({ memoryLimitMb }: { memoryLimitMb: number }) => spawnAnalysisWorker(path.join(distDir, 'worker.cjs'), memoryLimitMb);
  const broadcast = (channel: string, payload: unknown): void => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
  };
  let win: BrowserWindow | null = null;
  let router: SessionRouter | null = null;

  const appDeps: AppDeps = {
    info: () => ({
      versions: { app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
      dataDir: router?.userDir ?? dataDir,
      cacheDir: defaultCacheDir(),
      reposDir: defaultReposDir(),
    }),
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
  };

  // Cuentas (fase 13): sin sesión no se abre ninguna base de datos; con sesión, la del usuario.
  const account = new AccountService({
    config: cloudConfig(process.env, builtCloud),
    storage: new EncryptedSessionStorage(path.join(dataDir, 'sesion.bin'), safeStorage),
    onChange: (change) => router?.change(change),
  });
  router = new SessionRouter({
    account: createAccountHandlers(account),
    app: appDeps,
    open: (userId) =>
      openWorkspace(userId, {
        dataDir,
        cipher: safeStorage,
        spawn,
        emit: (state) => broadcast(JOB_EVENT_CHANNEL, state),
        cloud: async () => {
          const db = await account.database();
          return db ? new SupabaseRepo(db) : null;
        },
        emitSync: (state) => broadcast(SYNC_EVENT_CHANNEL, state),
        includedAi: () => account.includedAi(),
      }),
    notify: (state) => broadcast(ACCOUNT_EVENT_CHANNEL, state),
  });
  // La sesión guardada (si la hay) llega por onChange en cuanto se lee, ya con el enrutador creado.
  const sessions = router;
  app.on('will-quit', () => {
    sessions.dispose();
    account.dispose();
  });
  registerIpc(() => sessions.handlers(), devServerUrl);

  win = createWindow();
  if (smoke) {
    void runSmokeTest(win, (memoryLimitMb) => spawn({ memoryLimitMb }))
      .catch((err: unknown) => {
        console.error(`Prueba de arranque: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      })
      .then((ok) => {
        // Pase lo que pase, la prueba termina: limpiar es secundario.
        try {
          sessions.dispose();
          // La carpeta temporal de la prueba (la de RADAR_DATA_DIR no se toca). En Windows,
          // Chromium aún tiene abiertos sus archivos: la borra quien lanzó la prueba.
          if (!dataDirFromEnv) rmSync(dataDir, { recursive: true, force: true });
        } catch {
          /* queda en la carpeta temporal del sistema */
        }
        app.exit(ok ? 0 : 1);
      });
    return;
  }
  // Limpieza en segundo plano de lo que lleva 90 días sin usarse (la caché es compartida con la CLI).
  setTimeout(() => void pruneCache(defaultCacheDir(), 90).catch(() => undefined), 20_000).unref();
}

async function runSmokeTest(win: BrowserWindow, spawn: Parameters<typeof checkWorker>[0]): Promise<boolean> {
  const problems = [...(await checkRenderer({ evaluate: (e) => win.webContents.executeJavaScript(e) }, 30_000)), ...(await checkWorker(spawn, 60_000))];
  if (problems.length === 0) console.log('Prueba de arranque superada: la interfaz y el proceso de análisis funcionan desde el paquete.');
  for (const p of problems) console.error(`Prueba de arranque: ${p}`);
  return problems.length === 0;
}
