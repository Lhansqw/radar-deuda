# Puesta en producción

Lo que hay que hacer, fuera del código, para que cualquier persona pueda descargar la
aplicación, crear su cuenta y usar la IA incluida. Cada paso enlaza al documento con el
detalle.

## 1. Correo de las cuentas (obligatorio)

El registro exige confirmar el correo con el enlace que se envía. El servidor de correo que trae
Supabase **solo envía a los miembros del equipo del proyecto** y como mucho 2 mensajes por
hora: sin un servidor propio, nadie más puede registrarse.

1. Crea una cuenta en un servicio de correo transaccional (Resend o Brevo tienen planes
   gratuitos) y verifica tu dominio en él (registros SPF y DKIM).
2. En Supabase: **Authentication → Emails → SMTP Settings → Enable custom SMTP**, con el
   servidor, puerto, usuario y contraseña que te da el servicio, y un remitente de tu dominio.
3. En **Authentication → Rate Limits**, sube el límite de correos por hora (con SMTP propio
   ya no es 2).
4. En **Authentication → URL Configuration**, cambia la **Site URL** (por defecto
   `http://localhost:3000`) por una página tuya, por ejemplo la del proyecto en GitHub: es
   donde acaba el navegador después de pulsar el enlace. Con `localhost` la persona ve un
   error, aunque su cuenta sí quede confirmada.
5. Prueba: regístrate con un correo que no sea del equipo del proyecto, pulsa el enlace y
   vuelve a la aplicación («Ya lo confirmé: entrar»).

Plantillas de los correos, en español e inglés (la aplicación tiene los dos idiomas, y
Supabase envía la misma plantilla a todo el mundo): [CUENTAS.md](CUENTAS.md), paso 3.

## 2. Contraseñas

En **Authentication → Providers → Email** (o **Auth → Password security**):

- activa **Leaked password protection** (rechaza contraseñas filtradas, según
  HaveIBeenPwned; el asesor de seguridad de Supabase lo marca como pendiente);
- pon el mínimo de longitud en 8, el mismo que exige la aplicación.

El asesor también avisa de que `ai_count_request` y `ai_requests_today` se pueden llamar
directamente. Es intencionado: trabajan siempre sobre el usuario de la sesión, así que solo
pueden gastar o consultar el cupo propio.

## 3. IA incluida: Groq de pago y respaldo de OpenRouter

La clave de Groq es una sola para todos los usuarios. Con el plan gratuito, entre todos se
gastan unas pocas decenas de explicaciones al día.

1. En https://console.groq.com, pasa al plan **Developer** (pago por uso) y define un
   **límite de gasto** mensual.
2. Crea una clave de OpenRouter (https://openrouter.ai/settings/keys) con un límite de
   crédito bajo, para el respaldo con modelos gratuitos.
3. En Supabase, **Edge Functions → Secrets**: `GROQ_API_KEY` y `OPENROUTER_API_KEY`.
   Opcional: `RADAR_IA_LIMITE_DIARIO` (30 por defecto) para ajustar el cupo de cada cuenta.
4. Comprueba en la aplicación: Configuración → Inteligencia artificial debe decir «Te
   quedan 30 de 30 consultas hoy».

Detalle: [IA-INCLUIDA.md](IA-INCLUIDA.md).

## 4. Plan de Supabase

El plan gratuito **pausa el proyecto** tras unos días sin actividad, y entonces nadie puede
iniciar sesión hasta que se reactiva desde el panel. Con usuarios reales, pasa al plan
**Pro**, o como mínimo vigila el estado del proyecto.

## 5. Publicar la primera versión

1. Fusiona los cambios en `main` y comprueba que el CI está en verde.
2. Crea la etiqueta de la versión de `apps/desktop/package.json` y súbela:
   ```powershell
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. El workflow «Publicar versión» crea un **borrador** en GitHub Releases con todos los
   instaladores. Descárgalos, pruébalos y pulsa **Publish release**.
4. Desde ese momento, las versiones instaladas avisan al abrir cuando publiques la
   siguiente.

Detalle: [INSTALADOR.md](INSTALADOR.md#publicar-una-versión).

## Lo que queda fuera por ahora

- **Firma de los instaladores.** Sin certificado, Windows muestra «Windows protegió su PC»
  («Más información» → «Ejecutar de todas formas») y macOS pide abrir con clic derecho la
  primera vez. Conviene explicarlo en la página de descarga. Cómo firmar:
  [INSTALADOR.md](INSTALADOR.md#firma).
- **Actualizaciones automáticas.** La aplicación avisa y enlaza a la descarga; instalar
  sola exige instaladores firmados.
