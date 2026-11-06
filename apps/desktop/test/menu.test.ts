import { describe, expect, it } from 'vitest';
import { menuTemplate } from '../src/main/menu.js';

describe('menuTemplate', () => {
  it('en Windows y Linux no cambia el menú', () => {
    expect(menuTemplate('win32', true)).toBeNull();
    expect(menuTemplate('linux', false)).toBeNull();
  });

  it('en macOS incluye la aplicación y Edición (Cmd+Q, Cmd+C, Cmd+V…)', () => {
    const roles = menuTemplate('darwin', true)?.map((m) => m.role);
    expect(roles).toEqual(['appMenu', 'editMenu', 'windowMenu']);
  });

  it('la recarga y las herramientas de desarrollo solo fuera de la aplicación instalada', () => {
    expect(menuTemplate('darwin', false)?.map((m) => m.role)).toContain('viewMenu');
    expect(menuTemplate('darwin', true)?.map((m) => m.role)).not.toContain('viewMenu');
  });
});
