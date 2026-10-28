import path from 'node:path';
import type { AccountState } from '../shared/account.js';
import type { SyncState } from '../shared/sync.js';
import type { AccountChannel } from '../shared/ipc.js';
import { signedInHandlers, signedOutHandlers } from './account-handlers.js';
import type { AccountChange } from './account-service.js';
import { AiService } from './ai-service.js';
import type { CloudRepo } from './cloud-repo.js';
import { CloudSync } from './cloud-sync.js';
import { CredentialStore, type Cipher } from './credentials.js';
import { createHandlers, loadSettings, type AppDeps, type HandlerDeps, type Handlers } from './handlers.js';
import { JobManager, type JobDeps } from './jobs.js';
import { Store } from './store.js';
import { adoptLegacyData, DB_FILE, userDataDir } from './user-data.js';

/** Lo que tiene abierto un usuario con la sesión iniciada: su base de datos y sus servicios. */
export interface Workspace extends Pick<HandlerDeps, 'store' | 'credentials' | 'jobs' | 'ai' | 'sync'> {
  userId: string;
  /** Su carpeta de datos (usuarios/<id>). */
  dir: string;
  /** Detiene su análisis en curso y cierra su base de datos. */
  dispose(): void;
}

export interface WorkspaceDeps {
  /** Carpeta de datos de la aplicación. */
  dataDir: string;
  cipher: Cipher;
  spawn: JobDeps['spawn'];
  emit: JobDeps['emit'];
  /** La nube con la sesión del usuario (null sin sesión). */
  cloud: () => Promise<CloudRepo | null>;
  /** Avisa a la interfaz del estado de la copia en la nube. */
  emitSync: (state: SyncState) => void;
}

/** Espera antes de la primera sincronización: que la ventana termine de abrir. */
const FIRST_SYNC_MS = 1500;

/** Abre los datos de un usuario (los de antes de las cuentas pasan a la primera que entra). */
export function openWorkspace(userId: string, d: WorkspaceDeps): Workspace {
  const dir = userDataDir(d.dataDir, userId);
  adoptLegacyData(d.dataDir, dir);
  const store = Store.open(path.join(dir, DB_FILE));
  const credentials = new CredentialStore(store, d.cipher);
  const settings = () => loadSettings(store);
  const jobs = new JobManager({ store, credentials, settings, spawn: d.spawn, emit: d.emit });
  const ai = new AiService({ store, credentials, settings });
  const sync = new CloudSync({ ledger: store.cloudLedger(), repo: d.cloud, enabled: () => settings().cloud.sync, emit: d.emitSync });
  // Lo que cambia el usuario (proyectos, análisis) sube a los pocos segundos.
  const stopWatching = store.onChange(() => sync.schedule());
  sync.schedule(FIRST_SYNC_MS);
  return {
    userId,
    dir,
    store,
    credentials,
    jobs,
    ai,
    sync,
    dispose: () => {
      stopWatching();
      sync.dispose();
      jobs.dispose();
      store.close();
    },
  };
}

export interface SessionRouterDeps {
  account: Pick<Handlers, AccountChannel>;
  app: AppDeps;
  open: (userId: string) => Workspace;
  /** Avisa a la interfaz del nuevo estado de la cuenta. */
  notify: (state: AccountState) => void;
}

/**
 * Qué responde cada canal según la sesión: sin sesión, solo la cuenta; con
 * sesión, los datos de ese usuario. Al cambiar de usuario o cerrar sesión se
 * cierra lo del anterior antes de abrir nada.
 */
export class SessionRouter {
  private workspace: Workspace | null = null;
  private current: Handlers;

  constructor(private readonly d: SessionRouterDeps) {
    this.current = signedOutHandlers(d.account, d.app);
  }

  handlers(): Handlers {
    return this.current;
  }

  /** Carpeta de datos del usuario con la sesión iniciada, o null. */
  get userDir(): string | null {
    return this.workspace?.dir ?? null;
  }

  change({ state, user }: AccountChange): void {
    if (this.workspace && this.workspace.userId !== user?.id) this.close();
    if (user && !this.workspace) {
      this.workspace = this.d.open(user.id);
      this.current = signedInHandlers(createHandlers({ ...this.workspace, ...this.d.app }), this.d.account);
    }
    this.d.notify(state);
  }

  dispose(): void {
    this.close();
  }

  private close(): void {
    this.current = signedOutHandlers(this.d.account, this.d.app);
    const w = this.workspace;
    this.workspace = null;
    w?.dispose();
  }
}
