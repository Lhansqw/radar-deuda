/**
 * API que el preload expone a la interfaz en window.radar. La interfaz solo
 * conoce este tipo; nunca accede a Node ni a Electron.
 */
export interface RadarApi {
  versions: { electron: string; chrome: string; node: string };
}
