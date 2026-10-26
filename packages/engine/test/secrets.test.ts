import { describe, expect, it } from 'vitest';
import { redactSecrets, redactValue, scanSecrets, secretsAnalyzer, shannonEntropy } from '../src/analyzers/secrets.js';
import { resolveConfig } from '../src/config.js';
import { fileInput } from './helpers/file-input.js';

/**
 * Los secretos de prueba se construyen en tiempo de ejecución: así el propio
 * repositorio no contiene literales que el escaneo de secretos de GitHub
 * bloquearía al hacer push.
 */
const fake = {
  aws: ['AK', 'IA', 'Q7RZ', 'X2LM', 'P9WD', 'K4TB'].join(''),
  github: `gh${'p'}_${'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hJ3kL6'}`,
  anthropic: ['sk', 'ant', 'api03', 'Zx8Qw2Er5Ty7Ui9Op1As3Df'].join('-'),
  privateKey: ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' '),
};

const scan = (line: string, file = 'src/config.ts') => scanSecrets([line], file);

describe('formatos conocidos', () => {
  it.each([
    ['aws-access-key', `const k = "${fake.aws}";`],
    ['github-token', `token: ${fake.github}`],
    ['anthropic-key', `ANTHROPIC_API_KEY=${fake.anthropic}`],
    ['private-key', fake.privateKey],
  ])('%s', (ruleId, line) => {
    const [m] = scan(line, 'config/.env');
    expect(m?.ruleId).toBe(ruleId);
    expect(m?.confidence).toBe('high');
  });

  it('cadena de conexión con contraseña real', () => {
    const [m] = scan('const url = "postgres://app:Zq8vT2mW9x@db.interno.empresa.co:5432/ventas";');
    expect(m).toMatchObject({ ruleId: 'connection-string', severity: 'high' });
  });

  it('no reporta contraseñas interpoladas desde variables', () => {
    expect(scan('const url = `postgres://app:${process.env.PGPASS}@db/x`;')).toEqual([]);
  });

  it('reduce severidad para credenciales de ejemplo en localhost', () => {
    const [m] = scan('DATABASE_URL=postgres://admin:admin@localhost/dev', '.env');
    expect(m).toMatchObject({ severity: 'low', confidence: 'low' });
  });
});

describe('asignaciones genéricas', () => {
  it('detecta un literal de alta entropía asignado a una variable sensible', () => {
    const [m] = scan('const DB_PASSWORD = "Xk9#mP2vL8qR4nT7";');
    expect(m?.ruleId).toBe('generic-assignment');
    expect(m?.severity).toBe('high');
  });

  it.each([
    'const password = process.env.DB_PASSWORD;',
    'const token = getToken(user);',
    'const apiKey = "your-api-key-here";',
    'password: "changeme"',
    'const secret = "aaaaaaaaaaaa";', // entropía baja
    'const token = config.token;',
    // Nombres con "token" cuyo valor es otro nombre, no una credencial (falso positivo real en este repositorio).
    "  maxTokensParam: 'max_completion_tokens',",
    "const { maxTokensParam = 'max_tokens' } = options;",
    'grant_type: "client_credentials",',
    "const tokenType = 'bearer-token';",
  ])('ignora: %s', (line) => {
    expect(scan(line)).toEqual([]);
  });

  it('un valor con mayúsculas, cifras o símbolos sigue contando aunque tenga guiones', () => {
    expect(scan('const token = "live_Xk9mP2vL8q-R4nT7";')).toHaveLength(1);
    expect(scan('const apiKey = "abcd_efgh_ijkl_2024";')).toHaveLength(1);
  });

  it('en código solo cuentan literales entre comillas; en .env no hacen falta', () => {
    expect(scan('const token = abcDEF123ghiJKL456;')).toEqual([]);
    expect(scan('API_TOKEN=Zq8vT2mW9xLp4RbN', '.env')).toHaveLength(1);
  });

  it('baja la confianza en rutas de pruebas, ejemplos y documentación', () => {
    const [m] = scan('const DB_PASSWORD = "Xk9#mP2vL8qR4nT7";', 'test/fixtures/db.ts');
    expect(m).toMatchObject({ severity: 'low', confidence: 'low' });
  });
});

describe('redacción', () => {
  it('nunca incluye el secreto completo en la evidencia', () => {
    const { findings } = secretsAnalyzer.analyze(fileInput('src/a.ts', `const k = "${fake.aws}";`), resolveConfig());
    const snippet = findings[0]?.evidence[0]?.snippet ?? '';
    expect(snippet).not.toContain(fake.aws);
    expect(snippet).toContain(fake.aws.slice(0, 4));
    expect(JSON.stringify(findings)).not.toContain(fake.aws);
  });

  it('redactSecrets sustituye todos los formatos conocidos de un texto', () => {
    const text = `aws=${fake.aws}\ngh=${fake.github}\nnormal=hola`;
    const out = redactSecrets(text);
    expect(out).not.toContain(fake.aws);
    expect(out).not.toContain(fake.github);
    expect(out).toContain('normal=hola');
  });

  it('redactValue oculta por completo los valores cortos', () => {
    expect(redactValue('abc')).toBe('****');
    expect(redactValue('abcdefghijkl')).toBe('abcd…[8 caracteres ocultos]');
  });
});

describe('shannonEntropy', () => {
  it('es 0 para un solo símbolo y crece con la variedad', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBe(2);
  });
});
