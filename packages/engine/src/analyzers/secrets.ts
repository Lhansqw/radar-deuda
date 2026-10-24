import type { Confidence, FileAnalyzer, Finding, Severity } from '../types.js';
import { findingId } from '../util.js';

/**
 * Detección de secretos incrustados. Además de producir hallazgos, `redactSecrets`
 * se reutilizará en la capa de IA para que ningún secreto salga del equipo.
 */
const ID = 'secrets';
const VERSION = '1.1.0';
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

const LOW_CONFIDENCE_PATH = /(^|\/)(tests?|__tests__|spec|fixtures?|examples?|samples?|docs?|mocks?)\//i;

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

export function scanSecrets(lines: readonly string[], relPath: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  const isCodeFile = CODE_FILE.test(relPath);
  const lowConfidencePath = LOW_CONFIDENCE_PATH.test(relPath) || /\.md$/i.test(relPath) || /\.example$|\.sample$/i.test(relPath);
  lines.forEach((line, i) => {
    if (line.length > 2000) return;
    let matchedKnown = false;
    for (const rule of KNOWN_FORMATS) {
      const m = rule.pattern.exec(line);
      if (!m) continue;
      matchedKnown = true;
      let severity = rule.severity;
      let confidence: Confidence = 'high';
      if (rule.id === 'connection-string') {
        const u = URL_PASSWORD.exec(m[0]);
        const pwd = u?.[1] ?? '';
        if (INTERPOLATION.test(pwd)) continue; // la contraseña viene de una variable, no está incrustada
        if (EXAMPLE_PASSWORD.test(pwd) || EXAMPLE_HOST.test(u?.[2] ?? '')) {
          severity = 'low';
          confidence = 'low';
        }
      }
      if (lowConfidencePath) {
        severity = downgrade(severity);
        confidence = confidence === 'high' ? 'medium' : 'low';
      }
      matches.push({
        ruleId: rule.id,
        label: rule.label,
        line: i + 1,
        severity,
        confidence,
        redacted: line.replace(m[0], redactValue(m[0])).trim().slice(0, 160),
      });
    }
    if (matchedKnown) return;
    const g = GENERIC_ASSIGNMENT.exec(line);
    if (!g) return;
    const quoted = (g[2] ?? '') !== '';
    // En código fuente solo cuenta un literal de cadena; en .env/.ini/YAML los valores van sin comillas.
    if (isCodeFile && !quoted) return;
    const value = (g[3] ?? '').replace(/["'`]+$/, '');
    if (value.length < 8 || PLACEHOLDER.test(value) || CODE_REFERENCE.test(value) || INTERPOLATION.test(value)) return;
    if (!quoted && /^[a-z_$][\w$]*(\.[\w$]+)*\(/i.test(value)) return; // llamada a función, no un literal
    const entropy = shannonEntropy(value);
    if (entropy < 3.0) return;
    matches.push({
      ruleId: 'generic-assignment',
      label: `Posible secreto asignado a "${g[1] ?? ''}"`,
      line: i + 1,
      severity: lowConfidencePath ? 'low' : 'high',
      confidence: lowConfidencePath ? 'low' : entropy >= 3.8 ? 'medium' : 'low',
      redacted: line.replace(value, redactValue(value)).trim().slice(0, 160),
    });
  });
  return matches;
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
