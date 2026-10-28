# Cuentas de usuario (fase 13)

La aplicación de escritorio exige iniciar sesión. Las cuentas (correo y contraseña) viven en
[Supabase Auth](https://supabase.com/docs/guides/auth), el servicio de autenticación de
Supabase sobre PostgreSQL. La decisión y las alternativas están en
[DECISIONES.md](DECISIONES.md#d11-cuentas-de-usuario-supabase-auth-fase-13).

| Parte | Estado |
|---|---|
| **13a.** Registro, confirmación del correo, inicio de sesión, recuperación de la contraseña y cierre de sesión. Cada cuenta tiene sus propios proyectos, historial, ajustes y claves de IA en el equipo | ✅ |
| **13b.** Copia de los proyectos y del historial en PostgreSQL, sin código, con reglas de seguridad por filas para que cada usuario solo vea lo suyo, y disponible en cualquier equipo con la misma cuenta | ✅ |

La CLI no cambia: no necesita cuenta.

## 1. Preparar Supabase (una vez)

1. **Proyecto.** En [supabase.com](https://supabase.com), crea un proyecto (el plan gratuito
   basta; la región más cercana a Colombia es São Paulo). Guarda la contraseña de la base
   de datos en tu gestor de contraseñas: la aplicación no la usa.
2. **Claves.** En la configuración de claves de la API del proyecto están la **URL del
   proyecto** (`https://<proyecto>.supabase.co`) y la **clave publicable**
   (`sb_publishable_…`). Son las dos únicas que necesita la aplicación.
   La **clave secreta** (`sb_secret_…`, o la antigua `service_role`) da acceso total a la
   base de datos saltándose sus reglas: nunca debe ir en la aplicación, en un archivo ni en
   un commit. La aplicación y la compilación la rechazan, y el radar la marca como hallazgo
   crítico si aparece en un repositorio.
3. **Plantillas de correo.** Una aplicación de escritorio no puede abrir los enlaces de los
   correos de Supabase: usa el código de un solo uso que Supabase pone en `{{ .Token }}`. En
   Authentication, en las plantillas de correo, cambia al menos estas dos:

   **Confirm signup** — asunto: `Tu código para Radar de Deuda Técnica`

   ```html
   <h2>Confirma tu correo</h2>
   <p>Escribe este código en la aplicación para terminar de crear tu cuenta:</p>
   <p style="font-size: 28px; letter-spacing: 6px"><strong>{{ .Token }}</strong></p>
   <p>Si no creaste una cuenta en Radar de Deuda Técnica, ignora este mensaje.</p>
   ```

   **Reset password** — asunto: `Tu código para cambiar la contraseña`

   ```html
   <h2>Elige una contraseña nueva</h2>
   <p>Escribe este código en la aplicación junto con tu contraseña nueva:</p>
   <p style="font-size: 28px; letter-spacing: 6px"><strong>{{ .Token }}</strong></p>
   <p>Si no lo pediste, ignora este mensaje: tu contraseña no cambia.</p>
   ```

4. **Servidor de correo.** El que trae Supabase de serie **solo envía a los miembros del
   equipo del proyecto** (tu propio correo) y como mucho 2 mensajes por hora: sirve para
   probar. Para que se registre cualquier persona, configura un servidor SMTP propio en
   Authentication (Brevo o Resend tienen planes gratuitos). Otra opción, solo para
   pruebas, es desactivar «Confirm email» en el proveedor de correo: las cuentas entran sin
   confirmar el correo.
5. **Contraseñas.** La aplicación exige al menos 8 caracteres. Conviene poner el mismo mínimo
   en la configuración de contraseñas de Authentication (y, si quieres, exigir tipos de
   caracteres: la aplicación muestra el motivo si Supabase rechaza una).
6. **Tablas de la nube (13b).** En el editor SQL del proyecto, pega el contenido de
   [`supabase/migrations/20261028000000_proyectos_e_historial.sql`](../supabase/migrations/20261028000000_proyectos_e_historial.sql)
   y ejecútalo una vez (o, con la CLI de Supabase, `supabase link` y `supabase db push`).
   Crea las tablas `projects` y `analyses` con sus reglas de seguridad por filas. Sin ellas,
   la aplicación funciona igual, pero Configuración → Cuenta dice que faltan las tablas y no
   sube nada.

Supabase pausa los proyectos gratuitos que pasan tiempo sin actividad; se reactivan desde
su panel.

## 2. Conectar la aplicación

La URL y la clave publicable llegan por dos variables de entorno. No son secretas (la clave
publicable está pensada para ir dentro de las aplicaciones), pero no se guardan en el
repositorio.

**Desarrollo** (PowerShell, en la misma ventana):

```powershell
$env:RADAR_SUPABASE_URL = "https://<proyecto>.supabase.co"
$env:RADAR_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_..."
npm run desktop:dev      # o npm run desktop
```

Para no repetirlo en cada ventana, guárdalas como variables de tu usuario de Windows
(Configuración → Sistema → Información → Configuración avanzada del sistema → Variables de
entorno) y abre una terminal nueva.

**Instalador.** Con las variables definidas, `npm run dist` incrusta la conexión en la
aplicación y lo indica («Conexión con Supabase incluida: …»). Sin ellas, el instalador se
genera igual, pero la aplicación instalada muestra «Falta la conexión con Supabase» y no
deja entrar. El instalador que genera la integración continua no la lleva.

## 3. Cómo funciona

```
Interfaz (sin Node)            Proceso principal                          Supabase
───────────────────            ─────────────────                          ────────
Acceso: correo, contraseña ──▶ AccountService (@supabase/supabase-js) ──▶ Auth (HTTPS)
        código del correo           │  sesión: memoria + sesion.bin (cifrado DPAPI)
                                    ▼
◀── solo el estado ─────────  SessionRouter: abre usuarios/<id>/radar.db
    (correo, sin conexión)         y sus servicios; sin sesión, todo cerrado
                                    │
◀── estado de la copia ──────  CloudSync: proyectos e historial ───────▶ PostgreSQL (RLS)
                                    sin código, con el token del usuario   projects, analyses
```

- **La interfaz nunca recibe los tokens.** Solo conoce el estado: sin sesión, con sesión
  (con el correo y si hay conexión) o eligiendo una contraseña nueva. Los tokens viven en el
  proceso principal.
- **Sin sesión no hay datos.** Ningún canal IPC salvo los de la cuenta, `app:info` y abrir
  enlaces responde: no hay base de datos abierta. Al cerrar sesión se detiene el análisis
  en curso, se cierra la base de datos y la interfaz se recarga para no conservar nada en
  memoria.
- **Datos por cuenta.** Cada cuenta tiene su base de datos en
  `%APPDATA%\radar-deuda\usuarios\<id>\radar.db`. Los datos de antes de las cuentas pasan a
  la primera cuenta que inicia sesión en el equipo. La caché y los clones de GitHub
  (`%LOCALAPPDATA%\radar-deuda`) se comparten: se calculan a partir del contenido.
- **Seguir conectado.** Si está marcado (por defecto), la sesión se guarda cifrada con el
  sistema en `%APPDATA%\radar-deuda\sesion.bin` y la aplicación entra sola la próxima vez.
  Sin marcar, o si el sistema no ofrece cifrado, la sesión dura lo que la aplicación esté
  abierta.
- **Sin conexión.** Con una sesión guardada, la aplicación abre al instante con los datos
  del equipo y lo indica al pie de la barra lateral. Supabase Auth renueva la sesión cuando
  vuelve la red; si la rechaza (caducada, revocada o con la contraseña cambiada en otro
  equipo), la sesión se cierra.
- **Recuperar la contraseña.** Se pide un código, y con el código se elige la contraseña
  nueva. Si Supabase la rechaza (por ejemplo, por débil), se elige otra sin pedir otro
  código. Mientras tanto no se abren los datos ni se guarda la sesión en el disco.
- **Mensajes.** Los errores de Supabase se muestran en español y nunca repiten el correo,
  la contraseña ni el código. Al pedir un código de recuperación, la respuesta es la misma
  exista o no la cuenta.

## 4. La copia en la nube (13b)

Los datos de trabajo siguen en el equipo (SQLite); la nube guarda una copia de los proyectos
y del historial para verlos desde otro equipo con la misma cuenta. Se activa o desactiva en
Configuración → Cuenta («Guardar los proyectos y el historial en la nube», activada por
defecto), que también muestra el estado y permite sincronizar ya o borrar la copia.

| Sube | No sube |
|---|---|
| La lista de proyectos: nombre, tipo, carpeta (o `owner/repo`) y rama | El código, ni siquiera los fragmentos de la evidencia: comentarios TODO, versiones de dependencias o el principio redactado de un secreto |
| Cada análisis: fechas, puntuación, recuentos y el informe con hallazgos, ubicaciones, métricas y mensajes (comprimido) | Las claves de IA y el token de GitHub |
| | Lo que añade la IA (explicaciones, propuestas) y las conversaciones |
| | Los ajustes |

- **Cuándo.** Al abrir la sesión y a los pocos segundos de cada cambio (proyecto añadido o
  quitado, análisis guardado). Cada 10 minutos se buscan novedades de otros equipos. Sin
  conexión queda pendiente y se reintenta cada 2 minutos.
- **Cómo.** Primero se recibe lo de otros equipos (como mucho los 100 análisis más
  recientes de cada proyecto) y después se envía lo pendiente. El mismo repositorio añadido
  en dos equipos se une en uno. Quitar un proyecto en un equipo lo quita en los demás; volver
  a añadirlo lo recupera. Cada análisis tiene su identificador antes de subir, así que una
  subida cortada no lo duplica.
- **Proyectos de otro equipo.** Un repositorio de GitHub se puede analizar en cualquier
  equipo. Una carpeta local solo existe donde se añadió: en los demás se ve su historial, y
  para analizarla hay que añadir su carpeta desde ese equipo.
- **Borrar la copia en la nube** borra de Supabase los proyectos y el historial de la cuenta
  y desactiva la copia; en el equipo no se borra nada. Si otro equipo sigue con la copia
  activada, volverá a subir lo suyo.

**Reglas de la base de datos** (la migración): cada fila es de un usuario (`user_id`, que pone
la propia base de datos) y las políticas de seguridad por filas solo le dejan leer y escribir
las suyas; nadie puede guardar análisis en el proyecto de otro; el rol anónimo no tiene
ningún permiso; de un proyecto solo se cambian el nombre, la rama y si está quitado, y de un
análisis solo el informe; un disparador conserva los 100 análisis más recientes por
proyecto. `npm run test:db` lo comprueba en un PostgreSQL (la integración continua lo
ejecuta con PostgreSQL 17).

## 5. Seguridad

| Amenaza | Control |
|---|---|
| Robo de la contraseña | Nunca se guarda en el equipo; Supabase la guarda con bcrypt. Viaja solo por HTTPS (la URL debe ser `https://`, salvo Supabase local en el propio equipo) |
| Robo de la sesión | Tokens solo en el proceso principal; en el disco, cifrados con DPAPI para el usuario de Windows. Cerrar sesión los borra y revoca la sesión en Supabase |
| Clave secreta en la aplicación | Se rechaza al ejecutar y al compilar; el detector de secretos del radar la reporta como crítica |
| Fuerza bruta | Límites de peticiones de Supabase Auth; la aplicación muestra el aviso de esperar |
| Saber si un correo tiene cuenta | La recuperación responde igual en ambos casos; el registro con confirmación también |
| Una interfaz comprometida | No ve tokens ni contraseñas guardadas; sin sesión no llega a ningún dato |
| Otro usuario lee o cambia mi copia en la nube | Seguridad por filas en las dos tablas, con permisos explícitos solo para usuarios con sesión; probado con `npm run test:db` |
| El código sale del equipo | El informe sube sin fragmentos de código ni lo que añade la IA; la prueba de extremo a extremo lo comprueba en lo que sube |
| Un informe dañado o enorme en la nube | Al bajarlo se limita el tamaño descomprimido y se comprueba su formato; uno que no vale se salta |

**Límite conocido (13a):** la separación entre cuentas de un mismo equipo la hace la
aplicación, no el cifrado. Alguien con acceso a los archivos del mismo usuario de Windows
puede abrir la base de datos de otra cuenta; las claves de IA siguen protegidas por DPAPI
(del usuario de Windows, no de la cuenta). Para separar del todo a dos personas, cada una
debe usar su propio usuario de Windows.

## 6. Pruebas

- **Unitarias:** `test/helpers/fake-supabase.ts` simula la API HTTP de Supabase Auth
  (registro, códigos, inicio de sesión, renovación, cambio de contraseña) y se la pasa a
  `AccountService` como `fetch`. Cubren la sesión guardada, sin conexión, sesiones
  revocadas, la recuperación y los mensajes de error.
- **Copia en la nube:** `test/helpers/fake-postgrest.ts` simula la API de datos con las mismas
  reglas que la migración. Las pruebas de `CloudSync` usan dos equipos con la misma cuenta
  (y otra cuenta): recibir sin volver a subir, unir el mismo repositorio, quitar y recuperar
  proyectos, sin conexión, subidas cortadas y la nube sin código.
- **Base de datos** (`npm run test:db`): aplica la migración en un PostgreSQL y comprueba cada
  política como la vería la aplicación. Necesita `psql` y
  `RADAR_TEST_DATABASE_URL=postgresql://postgres@localhost:5432/postgres` (un servidor donde
  se pueda crear una base de datos temporal).
- **Extremo a extremo** (`npm run e2e:desktop`): simula Supabase dentro del proceso
  principal, crea una cuenta con su código (también uno erróneo), comprueba que sin sesión
  la interfaz no llega a los datos y que no guarda nada de la sesión, que el proyecto y su
  análisis suben solos sin código, y al final cierra la sesión y vuelve a entrar.
- **Con un proyecto real:** define las dos variables y crea una cuenta con tu correo (el
  servidor de correo de serie solo te escribe a ti).
