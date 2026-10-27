import { describe, expect, it } from 'vitest';
import { cloudConfig, ENV_KEY, ENV_URL } from '../src/main/cloud-config.js';
import { codeProblem, emailProblem, newPasswordProblem, normalizeEmail } from '../src/shared/account.js';

const KEY = 'sb_publishable_prueba_0123456789';
const jwt = (claims: object) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.firma`;

describe('cloudConfig', () => {
  it('lee la URL y la clave publicable del entorno, sin barra final', () => {
    expect(cloudConfig({ [ENV_URL]: ' https://abcd1234.supabase.co/ ', [ENV_KEY]: ` ${KEY} ` }, null)).toEqual({ ok: true, config: { url: 'https://abcd1234.supabase.co', publishableKey: KEY } });
  });

  it('usa la configuración incrustada al compilar si el entorno no la define, y el entorno manda', () => {
    const built = { url: 'https://compilada.supabase.co', publishableKey: KEY };
    expect(cloudConfig({}, built)).toEqual({ ok: true, config: built });
    expect(cloudConfig({ [ENV_URL]: 'https://otra.supabase.co' }, built)).toMatchObject({ ok: true, config: { url: 'https://otra.supabase.co' } });
  });

  it('explica qué falta', () => {
    expect(cloudConfig({}, null)).toMatchObject({ ok: false, message: expect.stringMatching(/RADAR_SUPABASE_URL y RADAR_SUPABASE_PUBLISHABLE_KEY/) });
    expect(cloudConfig({ [ENV_KEY]: KEY }, null)).toMatchObject({ ok: false, message: expect.stringMatching(/^Falta RADAR_SUPABASE_URL/) });
    expect(cloudConfig({ [ENV_URL]: 'https://a.supabase.co' }, null)).toMatchObject({ ok: false, message: expect.stringMatching(/^Falta RADAR_SUPABASE_PUBLISHABLE_KEY/) });
  });

  it('exige https salvo en el propio equipo, y solo la dirección del proyecto', () => {
    const url = (u: string) => cloudConfig({ [ENV_URL]: u, [ENV_KEY]: KEY }, null);
    expect(url('http://abcd.supabase.co')).toMatchObject({ ok: false, message: expect.stringMatching(/https/) });
    expect(url('http://127.0.0.1:54321')).toMatchObject({ ok: true });
    expect(url('http://localhost:54321')).toMatchObject({ ok: true });
    expect(url('https://abcd.supabase.co/rest/v1')).toMatchObject({ ok: false });
    expect(url('https://usuario:clave@abcd.supabase.co')).toMatchObject({ ok: false, message: expect.stringMatching(/usuario ni contraseña/) });
    expect(url('abcd.supabase.co')).toMatchObject({ ok: false, message: expect.stringMatching(/no es una URL válida/) });
  });

  it('rechaza siempre la clave secreta (nueva o antigua) y lo que no parece una clave publicable', () => {
    const key = (k: string) => cloudConfig({ [ENV_URL]: 'https://abcd.supabase.co', [ENV_KEY]: k }, null);
    expect(key('sb_secret_prueba_0123456789')).toMatchObject({ ok: false, message: expect.stringMatching(/clave secreta/) });
    expect(key(jwt({ role: 'service_role' }))).toMatchObject({ ok: false, message: expect.stringMatching(/clave secreta/) });
    expect(key(jwt({ role: 'anon' }))).toMatchObject({ ok: true });
    expect(key('hola')).toMatchObject({ ok: false, message: expect.stringMatching(/formato/) });
    // El mensaje nunca repite la clave.
    const r = key('sb_secret_prueba_0123456789');
    expect(r.ok ? '' : r.message).not.toContain('prueba_0123456789');
  });
});

describe('reglas de la cuenta', () => {
  it('correo', () => {
    expect(normalizeEmail('  Ana@Ejemplo.COM ')).toBe('ana@ejemplo.com');
    expect(emailProblem('ana@ejemplo.com')).toBeNull();
    expect(emailProblem('')).toBe('Escribe tu correo.');
    expect(emailProblem('ana@ejemplo')).toBe('Ese correo no parece válido.');
    expect(emailProblem(`${'a'.repeat(250)}@x.co`)).toBe('Ese correo no parece válido.');
  });

  it('contraseña nueva: mínimo 8 caracteres y máximo 72 bytes (bcrypt)', () => {
    expect(newPasswordProblem('1234567')).toMatch(/al menos 8/);
    expect(newPasswordProblem('12345678')).toBeNull();
    expect(newPasswordProblem('ñ'.repeat(36))).toBeNull();
    expect(newPasswordProblem('ñ'.repeat(37))).toMatch(/más de 72/);
  });

  it('código de un solo uso', () => {
    expect(codeProblem(' 123456 ')).toBeNull();
    expect(codeProblem('12345')).not.toBeNull();
    expect(codeProblem('12a456')).not.toBeNull();
  });
});
