# Seguridad

Este documento recoge el modelo de amenazas de Radar de Deuda Técnica, los controles que lo
cubren y el resultado de la auditoría de la fase 11 (octubre de 2026). La lista de
comprobación de Electron está en [ESCRITORIO.md](ESCRITORIO.md#seguridad); aquí se ve el
conjunto: motor, fuentes, IA, CLI y aplicación.

## Qué se protege

| Activo | Por qué importa |
|---|---|
| El código del usuario | Puede ser privado. Solo sale del equipo si el usuario lo decide, y sin secretos |
| Las credenciales (claves de IA, token de GitHub) | Dan acceso a cuentas de pago y a repositorios privados |
| El equipo | Analizar un repositorio ajeno no debe ejecutar nada de ese repositorio |
| La fiabilidad del informe | La evidencia sale de las herramientas, nunca de un modelo de lenguaje |

## De dónde vienen los datos no confiables

1. **El repositorio analizado.** Puede ser malicioso, aunque lo normal es que no lo sea. Hay
   que contar con nombres de archivo, contenido, enlaces simbólicos, archivos enormes o
   minificados, `.git/config` con programas que Git ejecutaría, y comentarios que intentan
   dar órdenes a la IA.
2. **Las respuestas de servicios externos.** El modelo de lenguaje puede obedecer una
   inyección, inventar evidencia o proponer un parche mal formado. GitHub, OSV y el registro
   de npm pueden devolver respuestas enormes o redirecciones.
3. **La interfaz.** Muestra todo lo anterior, así que se trata como no confiable aunque sea
   código propio. Nunca tiene acceso directo a Node, al disco ni a las credenciales.
4. **El entorno local.** Variables de entorno y carpetas de datos. Quien controla la cuenta del
   usuario ya controla la aplicación; aun así, la versión instalada no acepta
   configuraciones de desarrollo y sus *fuses* impiden alterarla desde el entorno
   (ver [INSTALADOR.md](INSTALADOR.md)).

## Controles

### Repositorio analizado

| Amenaza | Control | Dónde |
|---|---|---|
| Salir de la carpeta analizada | El recorrido no sigue enlaces simbólicos; cada ruta pasa por `safeJoin`; no se analiza la raíz de una unidad | `engine/discovery.ts`, `engine/engine.ts` |
| Agotar memoria o tiempo | Tamaño máximo por archivo (medición sin análisis por encima), binarios y minificados detectados, límite de memoria del proceso de análisis con aviso al 90 % | `discovery.ts`, `engine.ts`, `worker/memory.ts` |
| Expresiones regulares lentas con líneas enormes | El detector de secretos no examina líneas de más de 2000 caracteres | `analyzers/secrets.ts` |
| Que Git ejecute programas del repositorio | Cada llamada fuerza por `-c` `core.fsmonitor`, `core.hooksPath` (inexistente), paginador, editor, `diff.external`, filtros LFS y `core.sshCommand`; sin shell; sin variables `GIT_*` heredadas; sin preguntas de credenciales; tiempo y salida limitados | `sources/git/run.ts` |
| Clonar algo inesperado | Solo `https` (`protocol.allow=never`), `transfer.fsckObjects`, sin submódulos ni enlaces simbólicos, superficial, con tamaño máximo comprobado antes por la API; ramas validadas (sin `-` inicial ni `..`) y `--end-of-options` | `sources/github/clone.ts` |
| Secretos del repositorio en el informe | La evidencia de un secreto siempre se guarda redactada (4 primeros caracteres) | `analyzers/secrets.ts` |

### Inteligencia artificial

| Amenaza | Control | Dónde |
|---|---|---|
| Enviar código sin querer | Privacidad por defecto «solo metadatos» con proveedores en la nube; «fragmentos» hay que elegirlo; «solo en este equipo» rechaza cualquier proveedor que no sea `localhost` | `ai/context.ts`, `pipeline/ai.ts` |
| Que un servidor «local» sea remoto | La localidad se deduce del host de la URL, no del nombre del proveedor; uno remoto exige `https` | `ai/provider.ts`, `providers/openai-compatible.ts` |
| Enviar un secreto | Cada línea pasa por el detector: con un posible secreto, o si es demasiado larga para examinarla, se sustituye por «[línea omitida: posible secreto]»; los formatos conocidos se redactan en cualquier texto | `ai/context.ts` |
| Inyección desde el código o los nombres | El contexto va entre delimitadores con un nonce derivado del contenido, que el código no puede imitar; las instrucciones del sistema lo declaran dato no confiable | `ai/context.ts`, `ai/chat.ts`, `ai/prompts.ts` |
| Evidencia inventada | Las respuestas se validan con un esquema; las cifras y las líneas citadas se comparan con el contexto enviado; las referencias de las preguntas (`H3`) se comprueban | `ai/validate.ts`, `ai/chat.ts` |
| Parches dañinos | El modelo nunca escribe el parche: propone rangos de líneas y texto, se validan contra el fragmento enviado, las líneas ocultas se restauran y la diferencia se calcula aquí. La aplicación nunca modifica los archivos del proyecto | `ai/fix.ts`, `ai/diff.ts` |
| Gasto descontrolado | Presupuesto por análisis comprobado antes de cada petición con el precio publicado; parada al primer error de clave, saldo o cuota | `ai/usage.ts`, `ai/tasks.ts` |

### Aplicación de escritorio

Resumen (detalle en [ESCRITORIO.md](ESCRITORIO.md#seguridad)): `sandbox`, `contextIsolation`,
sin `nodeIntegration`, protocolo propio `app://`, CSP sin nada externo ni `eval`, sin
navegación ni ventanas nuevas, permisos denegados, IPC con comprobación del remitente y
validación de cada argumento, credenciales cifradas con el sistema (DPAPI) que la interfaz
nunca recibe, lectura de fragmentos solo de archivos citados por el análisis, parches
generados por el proceso principal y respuestas de la IA mostradas como texto.

### Cuentas (fase 13)

Detalle en [CUENTAS.md](CUENTAS.md#5-seguridad). Las cuentas viven en Supabase Auth; el
cliente está en el proceso principal y la interfaz nunca recibe los tokens. Sin sesión no hay
ninguna base de datos abierta ni canal de datos que responda. La sesión se guarda solo
cifrada con el sistema, y la contraseña nunca. La conexión exige `https`, y la clave secreta
de Supabase se rechaza al ejecutar y al compilar.

La copia en la nube (13b) sube los proyectos y el historial sin código (sin los fragmentos
de la evidencia ni lo que añade la IA) a dos tablas con seguridad por filas: cada usuario solo
lee y escribe lo suyo, y el rol anónimo no tiene permisos. `npm run test:db` comprueba esas
reglas en PostgreSQL en la integración continua.

### Red

| Destino | Cuándo | Qué se envía |
|---|---|---|
| `api.osv.dev`, `registry.npmjs.org` | Con «Vulnerabilidades y versiones» (`--online`) | Nombres y versiones de paquetes |
| `api.github.com`, `github.com` | Al añadir o analizar un repositorio de GitHub | El repositorio pedido; el token, si lo hay, en una cabecera |
| `openrouter.ai`, `api.anthropic.com`, `api.openai.com` | Solo al usar la IA | Metadatos del análisis; código solo con «fragmentos» o con permiso explícito para una propuesta |
| `<proyecto>.supabase.co` | Al iniciar sesión, registrarse, recuperar la contraseña y renovar la sesión; con la copia en la nube activada, al sincronizar | Correo, contraseña y códigos de la cuenta. La copia: lista de proyectos (con su carpeta) y resultados de cada análisis, sin código ni nada de la IA |

No hay telemetría ni actualizaciones automáticas. Todas las peticiones tienen tiempo límite,
reintentos solo para errores transitorios y tamaño máximo de respuesta. Una petición con
credenciales solo sigue redirecciones dentro del mismo servidor.

### Credenciales

- Llegan por variables de entorno (`RADAR_*_API_KEY`, `RADAR_GITHUB_TOKEN`) o, en la
  aplicación, por el almacén cifrado con `safeStorage`. Nunca se escriben en archivos de
  configuración, informes, cachés ni registros.
- El proceso de análisis las recibe por mensaje, no por su entorno.
- Cada cuenta de la aplicación tiene sus propias credenciales (en su base de datos). La
  sesión de Supabase se guarda aparte, cifrada igual, y solo si se pide seguir conectado.
- Los mensajes de error nunca incluyen el valor: como mucho, su longitud y el prefijo
  esperado. Git redacta el token y cualquier `usuario:clave@` de las URL.
- El token de GitHub va en `http.extraheader` mediante `GIT_CONFIG_*`, no en la línea de
  órdenes (visible para otros procesos) ni en la URL del remoto (que Git guarda).

## Auditoría de la fase 11

**Método.** Revisión manual de cada superficie de la tabla anterior, `npm audit`, revisión
del archivo de bloqueo, el autoanálisis del propio radar y pruebas nuevas para cada
corrección (que fallan con la versión anterior).

### Problemas encontrados y corregidos

| # | Problema | Riesgo | Corrección |
|---|---|---|---|
| 1 | Las peticiones seguían cualquier redirección. `fetch` quita `Authorization` al cambiar de servidor, pero no las cabeceras propias: la clave de Anthropic (`x-api-key`) habría llegado al servidor de destino de una redirección. Comprobado con dos servidores locales | Medio (requiere que la API redirija o un intermediario) | Con credenciales, las redirecciones se siguen a mano y solo dentro del mismo origen; otra se rechaza sin reintentos (`RedirectError`). Máximo 5 saltos |
| 2 | El detector no examina líneas de más de 2000 caracteres, y esas líneas se enviaban a la IA (con «fragmentos») y se mostraban en el visor sin ocultar las asignaciones de alta entropía | Medio | Quien envía o muestra código trata esas líneas como posibles secretos (`MAX_SCANNED_LINE`) |
| 3 | `RADAR_DEV_SERVER_URL` se aceptaba siempre: la ventana podía cargar una URL remota con la CSP de desarrollo (el IPC sí la rechazaba) | Bajo (requiere controlar el entorno) | Solo sin empaquetar y en `http://localhost` o `127.0.0.1`. Además, sin herramientas de desarrollo en la aplicación empaquetada |

### Comprobado sin cambios

- Todas las consultas SQL usan parámetros; lo interpolado son constantes del propio código.
- Ningún `innerHTML`, `dangerouslySetInnerHTML`, `eval` ni `new Function` en el código.
- Los validadores IPC no repiten el valor recibido en sus mensajes de error.
- Las rutas que llegan de la interfaz son relativas, sin unidad, sin `\` y sin `..`, y el
  proceso principal comprueba además que el archivo real está dentro del proyecto.
- La caché de la IA guarda solo respuestas ya validadas, con nombre de archivo derivado de un
  hash; nunca peticiones ni cabeceras.

### Dependencias

- `npm audit`: 0 vulnerabilidades conocidas (producción y desarrollo).
- 251 paquetes de terceros en el archivo de bloqueo, todos de `registry.npmjs.org` y con
  integridad `sha512`. Solo dos tienen scripts de instalación, ambos de desarrollo
  (`esbuild` y `fsevents`).
- En ejecución, la aplicación solo usa `react`, `react-dom` (`scheduler`), `ignore`,
  `semver`, `typescript` (el compilador, para el análisis) y las dos fuentes tipográficas.
- Electron 44.9.3 (fijado), la última versión de la rama 44, que sigue con soporte.

### Integración continua

Cada push y cada pull request ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml))
ejecuta `npm audit` y `npm audit signatures` (firmas del registro). También ejecuta el
autoanálisis, que falla con deuda alta o crítica, y comprueba que la cobertura de las
pruebas no baja de sus mínimos. Las acciones están fijadas por commit, con
permisos de solo lectura y sin credenciales persistentes. Dependabot propone las
actualizaciones cada semana.

## Riesgos aceptados y pendientes

| Riesgo | Situación |
|---|---|
| El ejecutable y el instalador no van firmados | Firmar necesita un certificado; sin él, SmartScreen avisa al instalar. Los *fuses* y la integridad del ASAR sí están (fase 12) y `npm run dist` los comprueba ([INSTALADOR.md](INSTALADOR.md)) |
| Actualizaciones | No hay automáticas: cada versión se instala a mano. Añadirlas exige publicar versiones firmadas y comprobar la firma antes de instalar |
| El permiso para enviar código en una propuesta lo pide la interfaz | Una interfaz comprometida podría saltárselo, pero solo enviaría el fragmento del hallazgo al proveedor que el usuario configuró |
| La caché de la IA (en `%LOCALAPPDATA%`) no está cifrada y puede contener código de las propuestas | Mismo nivel de protección que el propio código fuente en el disco; `npm run cache -- --vaciar` o Configuración → Vaciar la caché la borran |
| En Linux sin llavero no hay almacén cifrado | La aplicación lo indica y solo acepta las claves por variables de entorno |
| Cuentas de un mismo usuario de Windows | La separación entre cuentas la hace la aplicación, no el cifrado: con acceso a los archivos de ese usuario de Windows se puede abrir la base de datos de otra cuenta. Para separar del todo, un usuario de Windows por persona |
| Correo de Supabase de serie | Solo escribe a los miembros del proyecto y 2 veces por hora; para usuarios reales hace falta un servidor SMTP propio ([CUENTAS.md](CUENTAS.md)) |
| Los modelos gratuitos de OpenRouter suelen exigir permitir proveedores que guardan datos | Es una casilla explícita, desactivada por defecto; con «solo metadatos» no se envía código |
