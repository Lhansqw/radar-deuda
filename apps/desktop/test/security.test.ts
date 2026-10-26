import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, isAllowedExternalUrl, resolveAppPath } from '../src/main/policy.js';
import { APP_ENTRY, isAppUrl } from '../src/shared/origin.js';

describe('origen de la interfaz', () => {
  it('solo acepta app://radar y, en desarrollo, el servidor de Vite en localhost', () => {
    expect(isAppUrl(APP_ENTRY)).toBe(true);
    expect(isAppUrl('app://radar/assets/x.js')).toBe(true);
    expect(isAppUrl('app://otro/index.html')).toBe(false);
    expect(isAppUrl('file:///C:/Windows/system.ini')).toBe(false);
    expect(isAppUrl('https://example.com')).toBe(false);
    expect(isAppUrl(undefined)).toBe(false);
    expect(isAppUrl('no es una url')).toBe(false);
    expect(isAppUrl('http://127.0.0.1:5173/src/main.tsx', 'http://127.0.0.1:5173/')).toBe(true);
    expect(isAppUrl('http://127.0.0.1:5174/', 'http://127.0.0.1:5173/')).toBe(false);
    expect(isAppUrl('http://127.0.0.1:5173/', null)).toBe(false);
    // Un "servidor de desarrollo" remoto nunca se considera de confianza.
    expect(isAppUrl('http://evil.example:5173/', 'http://evil.example:5173/')).toBe(false);
  });
});

describe('archivos servidos por app://', () => {
  const root = path.resolve('/app/dist/renderer');

  it('resuelve los archivos de la interfaz', () => {
    expect(resolveAppPath(root, 'app://radar/')).toBe(path.join(root, 'index.html'));
    expect(resolveAppPath(root, 'app://radar/assets/index-abc.js')).toBe(path.join(root, 'assets', 'index-abc.js'));
    expect(resolveAppPath(root, 'app://radar/assets/a%20b.css')).toBe(path.join(root, 'assets', 'a b.css'));
  });

  it.each([
    'app://radar/..%2f..%2fmain.cjs',
    'app://radar/assets%5c..%5c..%5cmain.cjs',
    'app://radar/x%00.js',
    'app://radar/%E0%A4%A',
    'app://otro/index.html',
    'file:///etc/passwd',
  ])('rechaza %s', (url) => {
    expect(resolveAppPath(root, url)).toBeNull();
  });

  it.each(['app://radar/../main.cjs', 'app://radar/%2e%2e/%2e%2e/secreto', 'app://radar/assets/../../../x', 'app://radar//etc/passwd'])(
    'nunca sale de la carpeta de la interfaz: %s',
    (url) => {
      // El analizador de URLs ya resuelve los ".." literales; lo que queda debe estar dentro de la carpeta.
      const file = resolveAppPath(root, url);
      expect(file === null || file.startsWith(root + path.sep)).toBe(true);
    },
  );
});

describe('política de seguridad de contenido', () => {
  it('en producción no permite nada externo, ni scripts en línea, ni eval', () => {
    const csp = contentSecurityPolicy(null);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:|ws:/);
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('en desarrollo solo añade lo que necesita Vite en localhost', () => {
    const csp = contentSecurityPolicy('http://127.0.0.1:5173/');
    expect(csp).toContain('connect-src \'self\' ws://127.0.0.1:5173');
    expect(csp).not.toContain('unsafe-eval');
  });
});

describe('enlaces externos', () => {
  it('solo https y dominios conocidos', () => {
    expect(isAllowedExternalUrl('https://openrouter.ai/settings/keys')).toBe(true);
    expect(isAllowedExternalUrl('https://github.com/settings/personal-access-tokens')).toBe(true);
    expect(isAllowedExternalUrl('http://openrouter.ai/')).toBe(false);
    expect(isAllowedExternalUrl('https://openrouter.ai.evil.com/')).toBe(false);
    expect(isAllowedExternalUrl('https://user:pass@github.com/')).toBe(false);
    expect(isAllowedExternalUrl('file:///C:/Windows/notepad.exe')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('no es una url')).toBe(false);
  });
});
