/** Estado de la copia en la nube (fase 13b) que ve la interfaz. */
export interface SyncState {
  /** off: desactivada en Configuración; offline: sin conexión, se reintenta sola. */
  status: 'off' | 'idle' | 'syncing' | 'offline' | 'error';
  /** Última sincronización completa (ISO), o null. */
  lastSyncAt: string | null;
  /** Mensaje del último error (status 'error' u 'offline'). */
  message: string | null;
  /** Lo que falta por subir. */
  pending: { projects: number; analyses: number; removals: number };
  /** Cuenta los cambios que llegaron de otros equipos: si cambia, hay que volver a cargar los proyectos. */
  received: number;
}
