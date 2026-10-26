/** Credenciales que la aplicación puede guardar. */
export const SECRET_NAMES = ['openrouter', 'anthropic', 'openai', 'github'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export const SECRET_LABELS: Readonly<Record<SecretName, string>> = {
  openrouter: 'Clave de OpenRouter',
  anthropic: 'Clave de Anthropic',
  openai: 'Clave de OpenAI',
  github: 'Token de GitHub (repositorios privados)',
};

/** Lo único que la interfaz sabe de las credenciales: si existen y de dónde vienen. Nunca su valor. */
export interface SecretsStatus {
  /** El sistema ofrece cifrado (en Windows, siempre: DPAPI). */
  encryptionAvailable: boolean;
  secrets: Record<SecretName, { stored: boolean; fromEnv: boolean }>;
}
