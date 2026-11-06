import type { MenuItemConstructorOptions } from 'electron';

/**
 * Menú de la aplicación. En macOS hace falta uno: sin el menú Edición no
 * funcionan Cmd+C, Cmd+V, Cmd+A ni Cmd+Z en los campos de texto, y sin el de
 * la aplicación no hay Cmd+Q. En Windows y Linux no se cambia (null): el
 * menú por defecto de Electron queda oculto (autoHideMenuBar).
 *
 * Las herramientas de recarga y de desarrollo solo fuera de la aplicación instalada.
 */
export function menuTemplate(platform: NodeJS.Platform, packaged: boolean): MenuItemConstructorOptions[] | null {
  if (platform !== 'darwin') return null;
  const template: MenuItemConstructorOptions[] = [{ role: 'appMenu' }, { role: 'editMenu' }];
  if (!packaged) template.push({ role: 'viewMenu' });
  template.push({ role: 'windowMenu' });
  return template;
}
