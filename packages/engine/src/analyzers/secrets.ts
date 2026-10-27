import type { Confidence, FileAnalyzer, Finding, Severity } from '../types.js';
import { findingId } from '../util.js';

/**
 * Detección de secretos incrustados. Además de producir hallazgos, `redactSecrets`
 * se reutilizará en la capa de IA para que ningún secreto salga del equipo.
 */
const ID = 'secrets';
const VERSION = '1.3.0';
const TOOL = `${ID}@${VERSION}`;

interface SecretRule {
  id: string;
  label: string;
  pattern: RegExp;
  severity: Severity;
}

const KNOWN_FORMATS: SecretRule[] = [
  { id: 'private-key', label: 'Clave privada', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/, severity: 'critical' },
  { id: 'aws-access-key', label: 'Clave de acceso de AWS', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, severity: 'critical' },
  { id: 'github-token', label: 'Token de GitHub', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/, severity: 'critical' },
  { id: 'anthropic-key', label: 'Clave de API de Anthropic', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/, severity: 'critical' },
  { id: 'openai-key', label: 'Clave de API de OpenAI', pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/, severity: 'critical' },
  { id: 'google-api-key', label: 'Clave de API de Google', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/, severity: 'high' },
  { id: 'slack-token', label: 'Token de Slack', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/, severity: 'high' },
  { id: 'stripe-live-key', label: 'Clave secreta de Stripe', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/, severity: 'critical' },
  { id: 'connection-string', label: 'Cadena de conexión con contraseña', pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:/@'"]+:[^\s@'"]{4,}@[^\s'"]+/i, severity: 'high' },
];

/** `password = "..."`, `"apiKey": "..."`, `SECRET_TOKEN=...` con valor de alta entropía. */
const GENERIC_ASSIGNMENT =
  /(?:^|[^A-Za-z0-9])([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|private[_-]?key|client[_-]?secret|token)[A-Za-z0-9_.-]*)["']?\s*(?::=|=|:)\s*(["'`]?)([^\s"'`,;]{8,200})/i;

/** Contraseña de una URL de conexión: `esquema://usuario:CONTRASEÑA@host`. */
const URL_PASSWORD = /:\/\/[^\s:/@'"]+:([^\s@'"]+)@([^\s/'":]+)/;
const EXAMPLE_PASSWORD = /^(?:pass(?:word)?|secret|user|admin|root|changeme|example|test|xxx+|\*+)$/i;
const EXAMPLE_HOST = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|example\.(?:com|org)|host|db|hostname)$/i;
const INTERPOLATION = /\$\{|^\$|^%|\{\{/;

const PLACEHOLDER = /^(?:x+|\*+|\.+|<[^>]*>|\$\{.*\}|\{\{.*\}\}|%[a-z_]+%|changeme|change_me|your[_-].*|example.*|placeholder|dummy|test|password|secret|null|undefined|true|false|none|todo|redacted|xxx.*)$/i;
/**
 * Valores que son nombres, no secretos: palabras en minúscula unidas por guiones
 * o guiones bajos (`max_completion_tokens`, `bearer-token`, `client_credentials`).
 * Una credencial real mezcla mayúsculas, cifras o símbolos.
 */
const IDENTIFIER_LIKE = /^[a-z]+(?:[_.-][a-z]+)+$/;
const CODE_REFERENCE = /^(?:process\.env|import\.meta\.env|os\.environ|getenv|env\(|config\.|this\.|self\.|req\.|options\.|args\.|props\.)/i;

export function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Conserva los 4 primeros caracteres para poder reconocer el secreto, nunca el resto. */
export function redactValue(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}…[${value.length - 4} caracteres ocultos]`;
}

const ALL_KNOWN_GLOBAL = KNOWN_FORMATS.map((r) => new RegExp(r.pattern.source, r.pattern.flags.includes('g') ? r.pattern.flags : `${r.pattern.flags}g`));

/** Sustituye en un texto todos los secretos con formato conocido. Uso previsto: antes de enviar contexto a un modelo. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of ALL_KNOWN_GLOBAL) out = out.replace(re, (m) => redactValue(m));
  return out;
}

const LOW_CONFIDENCE_PATH = /(^|\/)(tests?|__tests__|spec|e2e|fixtures?|examples?|samples?|docs?|mocks?)\//i;
/** Archivos de prueba por su nombre (app.test.ts, login.spec.js, flujo.e2e.ts). */
const TEST_FILE_NAME = /\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/i;

export interface SecretMatch {
  ruleId: string;
  label: string;
  line: number;
  severity: Severity;
  confidence: Confidence;
  redacted: string;
}

function downgrade(s: Severity): Severity {
  const order: Severity[] = ['info', 'low', 'medium', 'high', 'critical'];
  return order[Math.max(0, order.indexOf(s) - 1)] as Severity;
}

const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|java|kt|go|rb|php|cs|rs|swift|scala|c|h|cc|cpp|hpp|dart|lua|vue|svelte)$/i;
/** Sin comillas, `nombre(` o `objeto.metodo(` es una llamada a función, no un literal. */
const FUNCTION_CALL = /^[a-z_$][\w$]*(\.[\w$]+)*\(/i;
/**
 * Las líneas más largas (código minificado, datos) no se examinan. Quien
 * muestre o envíe código debe tratarlas como si pudieran contener un secreto.
 */
export const MAX_SCANNED_LINE = 2000;

interface FileTraits {
  /** En código fuente solo cuenta un literal de cadena; en .env/.ini/YAML los valores van sin comillas. */
  isCode: boolean;
  /** Pruebas, ejemplos y documentación: lo encontrado probablemente no es real. */
  lowConfidence: boolean;
}

function fileTraits(relPath: string): FileTraits {
  return {
    isCode: CODE_FILE.test(relPath),
    lowConfidence: LOW_CONFIDENCE_PATH.test(relPath) || TEST_FILE_NAME.test(relPath) || /\.md$/i.test(relPath) || /\.example$|\.sample$/i.test(relPath),
  };
}

export function scanSecrets(lines: readonly string[], relPath: string): SecretMatch[] {
  const traits = fileTraits(relPath);
  return lines.flatMap((line, i) => (line.length > MAX_SCANNED_LINE ? [] : scanLine(line, i + 1, traits)));
}

/** Los formatos conocidos tienen prioridad: si alguno aparece, la línea no se examina como asignación genérica. */
function scanLine(line: string, n: number, traits: FileTraits): SecretMatch[] {
  const known = KNOWN_FORMATS.flatMap((rule) => {
    const m = rule.pattern.exec(line);
    return m ? [{ rule, text: m[0] }] : [];
  });
  if (known.length > 0) return known.flatMap(({ rule, text }) => knownMatch(rule, text, line, n, traits) ?? []);
  const generic = genericMatch(line, n, traits);
  return generic ? [generic] : [];
}

const redactIn = (line: string, secret: string): string => line.replace(secret, redactValue(secret)).trim().slice(0, 160);

function knownMatch(rule: SecretRule, text: string, line: string, n: number, traits: FileTraits): SecretMatch | null {
  let severity = rule.severity;
  let confidence: Confidence = 'high';
  if (rule.id === 'connection-string') {
    const kind = connectionPassword(text);
    if (kind === 'variable') return null;
    if (kind === 'example') {
      severity = 'low';
      confidence = 'low';
    }
  }
  if (traits.lowConfidence) {
    severity = downgrade(severity);
    confidence = confidence === 'high' ? 'medium' : 'low';
  }
  return { ruleId: rule.id, label: rule.label, line: n, severity, confidence, redacted: redactIn(line, text) };
}

/** La contraseña de una URL de conexión viene de una variable, es de ejemplo o parece real. */
function connectionPassword(url: string): 'variable' | 'example' | 'real' {
  const u = URL_PASSWORD.exec(url);
  const pwd = u?.[1] ?? '';
  if (INTERPOLATION.test(pwd)) return 'variable';
  return EXAMPLE_PASSWORD.test(pwd) || EXAMPLE_HOST.test(u?.[2] ?? '') ? 'example' : 'real';
}

/** `clave = "valor"` con un valor que parece una credencial y tiene entropía suficiente. */
function genericMatch(line: string, n: number, traits: FileTraits): SecretMatch | null {
  const g = GENERIC_ASSIGNMENT.exec(line);
  if (!g) return null;
  const quoted = (g[2] ?? '') !== '';
  if (traits.isCode && !quoted) return null;
  const value = (g[3] ?? '').replace(/["'`]+$/, '');
  if (!looksLikeSecret(value, quoted)) return null;
  const entropy = shannonEntropy(value);
  if (entropy < 3.0) return null;
  return {
    ruleId: 'generic-assignment',
    label: `Posible secreto asignado a "${g[1] ?? ''}"`,
    line: n,
    severity: traits.lowConfidence ? 'low' : 'high',
    confidence: traits.lowConfidence ? 'low' : entropy >= 3.8 ? 'medium' : 'low',
    redacted: redactIn(line, value),
  };
}

function looksLikeSecret(value: string, quoted: boolean): boolean {
  if (value.length < 8 || PLACEHOLDER.test(value) || CODE_REFERENCE.test(value) || INTERPOLATION.test(value) || IDENTIFIER_LIKE.test(value)) return false;
  if (quoted) return true;
  // Sin comillas, una llamada o un valor que empieza por ( [ o { es una expresión (p. ej. PowerShell en la documentación).
  return !FUNCTION_CALL.test(value) && !/^[([{]/.test(value);
}

export const secretsAnalyzer: FileAnalyzer = {
  id: ID,
  version: VERSION,
  description: 'Secretos incrustados (formatos conocidos y asignaciones de alta entropía). La evidencia siempre se redacta.',
  supports: () => true,
  analyze(input) {
    const findings: Finding[] = scanSecrets(input.lines, input.meta.relPath).map((m) => ({
      id: findingId(`security/secret/${m.ruleId}`, input.meta.relPath, m.redacted),
      ruleId: `security/secret/${m.ruleId}`,
      category: 'security',
      severity: m.severity,
      confidence: m.confidence,
      title: `${m.label} en el código`,
      message: `Se detectó un posible secreto (${m.label.toLowerCase()}) en la línea ${m.line}. Si es real, debe rotarse: ya puede estar en el historial de Git.`,
      locations: [{ file: input.meta.relPath, startLine: m.line, endLine: m.line }],
      evidence: [{ kind: 'match', tool: TOOL, description: `Patrón ${m.ruleId}`, snippet: m.redacted }],
      impact: 'Un secreto en el repositorio puede ser usado por cualquiera con acceso al código o a su historial.',
      effort: { minutes: 30, rationale: 'Rotar la credencial, moverla a variables de entorno o a un gestor de secretos y limpiar el historial si procede (estimación fija).' },
    }));
    return { findings };
  },
};
