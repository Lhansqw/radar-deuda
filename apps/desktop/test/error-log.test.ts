import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDiagnostics, ErrorLog, interfaceReporter, sanitize } from '../src/main/error-log.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function logDir(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'radar-registros-'));
  dirs.push(d);
  return path.join(d, 'registros');
}

describe('sanitize', () => {
  it('quita rutas del equipo, correos, claves y parámetros de URL', () => {
    const text = [
      'ENOENT: no such file, open \'C:\\Users\\ana\\proyectos\\banco\\secreto.ts\'',
      'en C:/Users/ana/repo/a.ts y \\\\servidor\\compartida\\x.py',
      'file:///home/ana/repo/index.html, /home/ana/repo/b.ts, /Users/ana/x.js y /tmp/radar-1/c.ts',
      'sesión de ana.garcia+radar@ejemplo.com',
      'clave sk-or-v1-' + 'a1'.repeat(32),
      'https://abc.supabase.co/rest/v1/projects?apikey=eyJhbGciOi&select=*',
    ].join('\n');
    const out = sanitize(text);
    for (const leak of ['ana', 'banco', 'secreto', 'servidor', 'radar-1', 'ejemplo.com', 'a1a1a1a1a1', 'apikey', 'eyJhbGciOi']) expect(out).not.toContain(leak);
    expect(out).toContain('open \'<ruta>\'');
    expect(out).toContain('<correo>');
    expect(out).toContain('https://abc.supabase.co/rest/v1/projects?…');
  });

  it('conserva las rutas de la propia aplicación, que ayudan a localizar el fallo', () => {
    const appRoot = 'C:\\Users\\ana\\AppData\\Local\\Programs\\radar-deuda\\resources\\app.asar';
    const stack = `at abrir (${appRoot}\\dist\\main.cjs:120:15)\n    at C:/Users/ana/AppData/Local/Programs/radar-deuda/resources/app.asar/dist/worker.cjs:3:1`;
    expect(sanitize(stack, { appRoot })).toBe('at abrir (<app>/dist/main.cjs:120:15)\n    at <app>/dist/worker.cjs:3:1');
  });

  it('no toca el texto normal ni las direcciones de la aplicación', () => {
    const text = 'El análisis falló en la fase 2/3 a las 10:30 (app://radar/assets/index.js:1:200)';
    expect(sanitize(text)).toBe(text);
  });
});

describe('ErrorLog', () => {
  it('guarda los errores limpios y los devuelve del más reciente al más antiguo', async () => {
    let t = 0;
    const log = new ErrorLog({ dir: await logDir(), now: () => new Date(Date.UTC(2026, 10, 10, 10, 0, t++)) });
    const err = new TypeError('No se pudo abrir C:\\Users\\ana\\repo\\a.ts');
    err.stack = 'TypeError: No se pudo abrir C:\\Users\\ana\\repo\\a.ts\n    at leer (C:\\Users\\ana\\repo\\a.ts:1:1)';
    log.record('principal', err);
    log.record('interfaz', 'texto suelto');
    expect(log.recent()).toEqual([
      { at: '2026-11-10T10:00:01.000Z', source: 'interfaz', message: 'texto suelto' },
      { at: '2026-11-10T10:00:00.000Z', source: 'principal', message: 'TypeError: No se pudo abrir <ruta>', stack: 'at leer (<ruta>:1:1)' },
    ]);
    expect(log.recent(1)).toHaveLength(1);
  });

  it('rota al llenarse: conserva el archivo anterior y no crece sin límite', async () => {
    const dir = await logDir();
    const log = new ErrorLog({ dir, maxBytes: 400 });
    for (let i = 0; i < 20; i++) log.record('análisis', new Error(`fallo ${i} ${'x'.repeat(40)}`));
    expect(readFileSync(path.join(dir, 'errores.jsonl'), 'utf8').length).toBeLessThanOrEqual(400);
    expect(existsSync(path.join(dir, 'errores.1.jsonl'))).toBe(true);
    const recent = log.recent(50);
    expect(recent[0]?.message).toContain('fallo 19');
    expect(recent.length).toBeLessThan(20);
  });

  it('ignora líneas dañadas y vacía el registro al borrarlo', async () => {
    const dir = await logDir();
    const log = new ErrorLog({ dir });
    log.record('ipc', new Error('uno'));
    writeFileSync(path.join(dir, 'errores.jsonl'), `${readFileSync(path.join(dir, 'errores.jsonl'), 'utf8')}{roto\n{"at":"x","source":"otra","message":"m"}\n`);
    expect(log.recent().map((e) => e.message)).toEqual(['uno']);
    log.clear();
    expect(log.recent()).toEqual([]);
  });

  it('si no puede escribir, no lanza', async () => {
    const dir = await logDir();
    writeFileSync(`${dir}`, 'no es una carpeta');
    const log = new ErrorLog({ dir });
    expect(log.record('principal', new Error('x'))).toBeNull();
    expect(log.recent()).toEqual([]);
  });

  it('acorta los mensajes enormes', async () => {
    const log = new ErrorLog({ dir: await logDir() });
    expect(log.record('interfaz', 'x'.repeat(5000))?.message.length).toBe(1001);
  });
});

describe('interfaceReporter', () => {
  it('guarda los errores de la interfaz con su pila, con un límite por minuto', async () => {
    let t = 0;
    const log = new ErrorLog({ dir: await logDir() });
    const report = interfaceReporter(log, { perMinute: 2, now: () => t });
    report('TypeError: x', 'TypeError: x\n    at app://radar/assets/index.js:1:2');
    report('segundo', null);
    report('tercero, descartado', null);
    t = 61_000;
    report('cuarto, ya en otro minuto', null);
    expect(log.recent().map((e) => [e.source, e.message, e.stack ?? null])).toEqual([
      ['interfaz', 'cuarto, ya en otro minuto', null],
      ['interfaz', 'segundo', null],
      ['interfaz', 'TypeError: x', 'at app://radar/assets/index.js:1:2'],
    ]);
  });
});

describe('buildDiagnostics', () => {
  const base = {
    versions: { app: '0.1.0', electron: '45.2.3', chrome: '146.0', node: '24.1.0' },
    os: { platform: 'win32', release: '10.0.19045', arch: 'x64', locale: 'es-ES', totalMemoryMb: 16000, freeMemoryMb: 8000 },
    uptimeMinutes: 12,
  };

  it('versiones, sistema y errores con su pila', () => {
    const text = buildDiagnostics({ ...base, errors: [{ at: '2026-11-10T10:00:00.000Z', source: 'interfaz', message: 'Fallo', stack: 'at a (<app>/x.js:1:1)\nat b (<app>/y.js:2:2)' }] });
    expect(text).toBe(
      [
        'Radar de Deuda Técnica 0.1.0',
        'Electron 45.2.3, Chromium 146.0, Node 24.1.0',
        'Sistema: Windows 10.0.19045 (x64), idioma es-ES',
        'Memoria: 16000 MB, libre 8000 MB; abierta hace 12 min',
        '',
        'Errores recientes (1, del más reciente al más antiguo):',
        '',
        '2026-11-10T10:00:00.000Z [interfaz] Fallo',
        '    at a (<app>/x.js:1:1)',
        '    at b (<app>/y.js:2:2)',
      ].join('\n'),
    );
  });

  it('sin errores lo dice', () => {
    expect(buildDiagnostics({ ...base, os: { ...base.os, platform: 'freebsd' }, errors: [] })).toMatch(/Sistema: freebsd [^\n]*\nMemoria: [^\n]*\n\nSin errores registrados\.$/);
  });
});
