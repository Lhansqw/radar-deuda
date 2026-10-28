# IA incluida (fase 14)

Con la IA incluida, cualquier persona con una cuenta de la aplicación puede pedir
explicaciones, propuestas de corrección y respuestas sin crear ni pegar ninguna clave. Es el
proveedor predeterminado de la aplicación de escritorio. Usa el modelo **gpt-oss-120b en
Groq** (con los modelos gratuitos de OpenRouter como respaldo opcional), con un número de
consultas al día por cuenta.

Quien quiera otros modelos, o más consultas, puede seguir eligiendo en Configuración →
Inteligencia artificial OpenRouter con su propia clave, Anthropic, OpenAI o un modelo local
([IA.md](IA.md)). La CLI no ofrece la IA incluida: no tiene cuenta.

## Cómo funciona

Las claves de IA no pueden ir dentro de la aplicación: cualquiera podría sacarlas del
instalador y gastarlas. Las guarda el proyecto de Supabase como secretos, y una función de
Supabase ([`supabase/functions/ia`](../supabase/functions/ia/index.ts)) hace de intermediaria:

```
Aplicación ──(token de la sesión)──▶ función «ia» ──(clave del proyecto)──▶ Groq (gpt-oss-120b)
                                       │                                   └▶ OpenRouter, si Groq
                                       ├─ ¿la sesión es válida?  (Supabase Auth)    no responde
                                       ├─ ¿pide el modelo de la aplicación?
                                       └─ ¿le quedan consultas hoy?  (tabla ai_usage)
```

- **Sesión.** La aplicación envía el token de acceso de la sesión de Supabase (el mismo que
  usa la copia en la nube) en lugar de una clave. La función lo comprueba con Supabase Auth;
  sin sesión válida no reenvía nada.
- **El modelo lo elige el proyecto.** La aplicación pide `radar/predeterminado` y la función
  usa `RADAR_IA_MODELO` en Groq (`openai/gpt-oss-120b` por defecto), con salida estructurada
  estricta y el razonamiento más bajo. Cualquier otro modelo se rechaza. Solo reenvía los
  campos conocidos de la consulta, sin streaming y con la respuesta limitada a 16 000 tokens.
- **Límites por minuto.** Si Groq pide esperar (HTTP 429), la función espera lo que indica
  y repite, hasta 45 segundos por consulta. Si sigue ocupado y hay `OPENROUTER_API_KEY`,
  pasa a los modelos gratuitos de OpenRouter (`RADAR_IA_MODELOS` o los gratuitos del
  catálogo con salida estructurada); si no, responde que está ocupada.
- **Cupo diario.** Antes de reenviar, la función comprueba en la tabla `ai_usage`
  (migración [`20261028010000_ia_incluida.sql`](../supabase/migrations/20261028010000_ia_incluida.sql))
  las consultas del usuario hoy, y solo cuenta las que responden: los reintentos y los fallos
  no gastan cupo. Pasado el límite responde que se acabó el cupo del día; se renueva a las
  00:00 UTC (las 7 de la tarde en Colombia). El usuario no puede escribir esa tabla: solo las
  funciones de la base de datos, y siempre sobre su propia cuenta.
- **Privacidad.** Se aplica la misma privacidad que con cualquier proveedor en la nube: por
  defecto «solo metadatos», sin código. Para enviar fragmentos de código, mejor un modelo
  local. El respaldo de OpenRouter usa modelos gratuitos cuyos proveedores pueden guardar lo
  que reciben.

Configuración → Inteligencia artificial muestra las consultas que quedan hoy. Un análisis con
los valores por defecto hace unas 9 consultas; antes de empezar, la aplicación avisa si el
cupo no alcanza.

## Preparar Supabase (una vez)

Necesitas el proyecto de [CUENTAS.md](CUENTAS.md) ya preparado.

1. **Tabla del cupo.** En el editor SQL del proyecto, pega el contenido de
   [`supabase/migrations/20261028010000_ia_incluida.sql`](../supabase/migrations/20261028010000_ia_incluida.sql)
   y ejecútalo una vez (o `supabase db push` con la CLI).
2. **Clave de Groq del proyecto.** Crea una clave en https://console.groq.com/keys solo para
   esto. **Límites de Groq** para `openai/gpt-oss-120b` en el plan de entrada (consulta los
   de tu cuenta en https://console.groq.com/settings/limits): 30 consultas y 8000 tokens por
   minuto, 1000 consultas y 200 000 tokens al día, **para toda la clave**, es decir, entre
   todos los usuarios. Una explicación gasta unos 3000–5000 tokens: los tokens por día son
   el límite que antes se nota (unas pocas decenas de explicaciones al día, o unos pocos
   análisis completos con IA automática). Para más uso, sube de plan en Groq o añade el
   respaldo de OpenRouter.
3. **Secretos de la función.** En el panel de Supabase, en Edge Functions → Secrets, añade:

   | Secreto | Valor |
   |---|---|
   | `GROQ_API_KEY` | La clave del paso anterior (obligatorio, salvo que solo uses OpenRouter) |
   | `RADAR_IA_MODELO` | Modelo de Groq (opcional; `openai/gpt-oss-120b` por defecto). Debe admitir salida estructurada estricta |
   | `RADAR_IA_LIMITE_DIARIO` | Consultas al día por cuenta (opcional; 30 por defecto) |
   | `OPENROUTER_API_KEY` | Respaldo con modelos gratuitos de OpenRouter (opcional). Sus límites: 50 consultas al día por clave, 1000 con 10 USD de crédito comprado |
   | `RADAR_IA_MODELOS` | Modelos gratuitos de OpenRouter para el respaldo, separados por comas, hasta 3 (opcional) |

   Con la CLI: `supabase secrets set --env-file <archivo>`, con un archivo fuera del
   repositorio que borres después. No escribas la clave en la línea de órdenes: queda en el
   historial de PowerShell. `SUPABASE_URL` y la clave publicable ya las pone Supabase.
4. **Función.** En Edge Functions, crea una función nueva desde el editor, llámala **`ia`**,
   pega el contenido de [`supabase/functions/ia/index.ts`](../supabase/functions/ia/index.ts)
   (no importa nada de fuera) y despliégala. En sus ajustes, **desactiva «Verify JWT with
   legacy secret»**: la función comprueba la sesión por su cuenta, y el catálogo de modelos
   (`/models`) se consulta sin sesión. Con la CLI, desde la carpeta del repositorio:

   ```powershell
   supabase functions deploy ia --no-verify-jwt
   ```

5. **Comprobarlo.** Inicia sesión en la aplicación: en Configuración → Inteligencia
   artificial, con «IA incluida (gratuita)», debe decir «Te quedan 30 de 30 consultas hoy».
   Después, «Explicar con IA» en cualquier hallazgo.

Si la aplicación dice que la IA incluida **no está instalada**, falta el paso 4 (o la
función no se llama `ia`). Si dice que **no está configurada**, falta `GROQ_API_KEY`.
Si dice que la clave **no es válida o se quedó sin crédito**, revisa la clave en Groq (o en
OpenRouter). Si dice que está **ocupada**, se alcanzó el límite por minuto de Groq: espera
un minuto, o añade el respaldo de OpenRouter.

Para cambiar el límite o los modelos basta con cambiar los secretos; no hace falta
volver a desplegar ni publicar otra versión de la aplicación.

## Seguridad

| Amenaza | Control |
|---|---|
| Sacar la clave de Groq u OpenRouter del instalador | No está en la aplicación ni en el repositorio: es un secreto del proyecto de Supabase que solo lee la función |
| Usar la función sin cuenta | Cada consulta exige un token de sesión válido, que la función comprueba con Supabase Auth |
| Usar otros modelos con la clave del proyecto | La función solo usa el modelo configurado (y, de respaldo, modelos gratuitos de OpenRouter) |
| Agotar el cupo de todos | Límite diario por cuenta en la base de datos, comprobado antes de reenviar; solo cuentan las consultas que responden |
| Cambiar el propio contador | La tabla `ai_usage` solo se lee; se escribe con una función de la base de datos que solo suma, y siempre sobre el usuario de la sesión. Probado con `npm run test:db` |
| Consultas enormes | La función rechaza cuerpos de más de 1 MB y limita la respuesta a 16 000 tokens |
| El token de la sesión | Vive en el proceso principal (nunca en la interfaz) y viaja solo por HTTPS a la función del propio proyecto |

**Límites conocidos:** quien cree muchas cuentas obtiene más cupo. El cupo total lo acota el
límite diario de la clave de Groq, y la confirmación del correo (con un servidor de
correo propio, [CUENTAS.md](CUENTAS.md)) frena la creación masiva de cuentas. Dos consultas
simultáneas de la misma cuenta en el último hueco del día pueden pasar las dos (se cuenta al
responder).

## Pruebas

- `supabase/functions/ia/index.test.ts`: la función con Supabase, Groq y OpenRouter
  simulados (sesión, modelo de la aplicación, cupo, esperas por el límite por minuto,
  respaldo, salida estructurada que no valida, errores de la clave del proyecto).
- `supabase/tests/politicas.sql` (`npm run test:db`): el cupo en PostgreSQL (contar, cada
  cuenta el suyo, nadie lo escribe directamente, sin sesión no se cuenta).
- `packages/ai/test/included.test.ts`: el proveedor de la aplicación (cupo antes de empezar,
  mensajes de la función, sesión caducada).
- `apps/desktop/e2e/app.e2e.ts`: la aplicación explica un hallazgo con la IA incluida sin
  ninguna clave y muestra el cupo en Configuración.
