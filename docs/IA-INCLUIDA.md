# IA incluida (fase 14)

Con la IA incluida, cualquier persona con una cuenta de la aplicación puede pedir
explicaciones, propuestas de corrección y respuestas sin crear ni pegar ninguna clave. Es el
proveedor predeterminado de la aplicación de escritorio. Usa **solo modelos gratuitos** de
OpenRouter, con un número de consultas al día por cuenta.

Quien quiera otros modelos, o más consultas, puede seguir eligiendo en Configuración →
Inteligencia artificial OpenRouter con su propia clave, Anthropic, OpenAI o un modelo local
([IA.md](IA.md)). La CLI no ofrece la IA incluida: no tiene cuenta.

## Cómo funciona

La clave de OpenRouter no puede ir dentro de la aplicación: cualquiera podría sacarla del
instalador y gastarla. La guarda el proyecto de Supabase como secreto, y una función de
Supabase ([`supabase/functions/ia`](../supabase/functions/ia/index.ts)) hace de intermediaria:

```
Aplicación ──(token de la sesión)──▶ función «ia» ──(clave del proyecto)──▶ OpenRouter
                                       │
                                       ├─ ¿la sesión es válida?           (Supabase Auth)
                                       ├─ ¿pide solo modelos gratuitos?
                                       └─ ¿le quedan consultas hoy?       (tabla ai_usage)
```

- **Sesión.** La aplicación envía el token de acceso de la sesión de Supabase (el mismo que
  usa la copia en la nube) en lugar de una clave. La función lo comprueba con Supabase Auth;
  sin sesión válida no reenvía nada.
- **Solo gratuitos.** La aplicación pide el modelo `radar/predeterminado` y la función lo
  cambia por una cadena de hasta tres modelos gratuitos: los de `RADAR_IA_MODELOS` o, si no
  hay, los gratuitos del catálogo con salida estructurada y más contexto. Cualquier otro
  modelo de pago se rechaza. Además, solo reenvía los campos conocidos de la consulta, sin
  streaming y con la respuesta limitada a 16 000 tokens.
- **Cupo diario.** Cada consulta cuenta, antes de enviarse, en la tabla `ai_usage`
  (migración [`20261028010000_ia_incluida.sql`](../supabase/migrations/20261028010000_ia_incluida.sql)).
  Pasado el límite responde que se acabó el cupo del día; se renueva a las 00:00 UTC (las 7 de
  la tarde en Colombia). El usuario no puede escribir esa tabla: solo las funciones de la base
  de datos, y siempre sobre su propia cuenta.
- **Privacidad.** Se aplica la misma privacidad que con cualquier proveedor en la nube: por
  defecto «solo metadatos», sin código. Los proveedores de los modelos gratuitos suelen
  guardar lo que reciben (e incluso entrenar con ello); por eso la IA incluida los permite
  siempre y Configuración lo advierte. Para enviar fragmentos de código, mejor un modelo
  local.

Configuración → Inteligencia artificial muestra las consultas que quedan hoy. Un análisis con
los valores por defecto hace unas 9 consultas; antes de empezar, la aplicación avisa si el
cupo no alcanza.

## Preparar Supabase (una vez)

Necesitas el proyecto de [CUENTAS.md](CUENTAS.md) ya preparado.

1. **Tabla del cupo.** En el editor SQL del proyecto, pega el contenido de
   [`supabase/migrations/20261028010000_ia_incluida.sql`](../supabase/migrations/20261028010000_ia_incluida.sql)
   y ejecútalo una vez (o `supabase db push` con la CLI).
2. **Clave de OpenRouter del proyecto.** Crea una clave en
   https://openrouter.ai/settings/keys solo para esto, con un límite de crédito bajo (los
   modelos gratuitos no gastan crédito; el límite protege si algo cambia).
   **Límites de OpenRouter:** los modelos gratuitos admiten 20 peticiones por minuto y
   **50 al día para toda la clave**, es decir, entre todos los usuarios. Si la cuenta de
   OpenRouter ha comprado al menos 10 USD de crédito, el límite sube a 1000 al día. Con 50
   apenas alcanza para unos pocos análisis diarios en total; para que la usen varias
   personas, compra ese crédito.
3. **Secretos de la función.** En el panel de Supabase, en Edge Functions → Secrets, añade:

   | Secreto | Valor |
   |---|---|
   | `OPENROUTER_API_KEY` | La clave del paso anterior (obligatorio) |
   | `RADAR_IA_LIMITE_DIARIO` | Consultas al día por cuenta (opcional; 30 por defecto) |
   | `RADAR_IA_MODELOS` | Modelos gratuitos separados por comas, hasta 3 (opcional; por defecto los elige la función del catálogo) |

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
función no se llama `ia`). Si dice que **no está configurada**, falta `OPENROUTER_API_KEY`.
Si dice que la clave **no es válida o se quedó sin crédito**, revisa la clave en OpenRouter.
Si OpenRouter responde que ningún proveedor cumple la política de datos, en
https://openrouter.ai/settings/privacy permite los endpoints gratuitos que pueden guardar
los datos.

Para cambiar el límite o los modelos basta con cambiar los secretos; no hace falta
volver a desplegar ni publicar otra versión de la aplicación.

## Seguridad

| Amenaza | Control |
|---|---|
| Sacar la clave de OpenRouter del instalador | No está en la aplicación ni en el repositorio: es un secreto del proyecto de Supabase que solo lee la función |
| Usar la función sin cuenta | Cada consulta exige un token de sesión válido, que la función comprueba con Supabase Auth |
| Gastar crédito con modelos de pago | La función solo reenvía modelos gratuitos (`:free` o con precio 0 en el catálogo de OpenRouter) |
| Agotar el cupo de todos | Límite diario por cuenta en la base de datos; la consulta se cuenta antes de enviarse, también si falla |
| Cambiar el propio contador | La tabla `ai_usage` solo se lee; se escribe con una función de la base de datos que solo suma, y siempre sobre el usuario de la sesión. Probado con `npm run test:db` |
| Consultas enormes | La función rechaza cuerpos de más de 1 MB y limita la respuesta a 16 000 tokens |
| El token de la sesión | Vive en el proceso principal (nunca en la interfaz) y viaja solo por HTTPS a la función del propio proyecto |

**Límite conocido:** quien cree muchas cuentas obtiene más cupo. El cupo total lo acota el
límite diario de la clave de OpenRouter, y la confirmación del correo (con un servidor de
correo propio, [CUENTAS.md](CUENTAS.md)) frena la creación masiva de cuentas.

## Pruebas

- `supabase/functions/ia/index.test.ts`: la función con Supabase y OpenRouter simulados
  (sesión, solo gratuitos, cupo, campos reenviados, errores de la clave del proyecto).
- `supabase/tests/politicas.sql` (`npm run test:db`): el cupo en PostgreSQL (contar, cada
  cuenta el suyo, nadie lo escribe directamente, sin sesión no se cuenta).
- `packages/ai/test/included.test.ts`: el proveedor de la aplicación (cupo antes de empezar,
  mensajes de la función, sesión caducada).
- `apps/desktop/e2e/app.e2e.ts`: la aplicación explica un hallazgo con la IA incluida sin
  ninguna clave y muestra el cupo en Configuración.
