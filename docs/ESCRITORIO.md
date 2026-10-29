# Aplicación de escritorio (fases 8, 9, 11 y 12)

La aplicación (`apps/desktop`) reúne en una ventana lo que hace la CLI: proyectos locales
y de GitHub, análisis con progreso y cancelación, panel con el radar de hallazgos,
detalle con el código, deuda por carpeta, historial con comparación entre análisis,
configuración, explicaciones de la IA bajo demanda y, desde la fase 9, propuestas de
corrección como diferencias revisables y preguntas sobre el análisis. Usa el mismo motor y las mismas
fuentes que la CLI (`@radar/pipeline`), así que un análisis da el mismo resultado desde
las dos.

## Cómo se usa

```powershell
npm ci
npm run desktop        # compila y abre la aplicación
npm run dist           # o genera el instalador para Windows (docs/INSTALADOR.md)
```

0. **Iniciar sesión** o **crear una cuenta** (correo y contraseña; el correo se confirma con
   el código que envía Supabase). La conexión con Supabase viene incluida
   (`nube.json`): ver [CUENTAS.md](CUENTAS.md).
1. **Añadir carpeta** o **Añadir de GitHub** (`propietario/repositorio`, rama opcional).
   Los repositorios privados necesitan un token de GitHub en Configuración.
2. **Analizar**. El análisis corre en un proceso aparte: la ventana sigue respondiendo y
   se puede cancelar.
3. **Panel**: puntuación, radar (un sector por categoría, un anillo por severidad, lo
   crítico en el centro), qué cambió desde el análisis anterior, evolución, por dónde
   empezar y puntos críticos.
4. **Hallazgos**: filtros por severidad, categoría, texto, carpeta y «Solo nuevos»; el
   detalle muestra el código citado (con los secretos ocultos), la evidencia, el esfuerzo,
   la explicación de la IA (o **Explicar con IA**) y **Proponer una corrección**: una
   diferencia que se copia o se guarda como parche para aplicarla con `git apply`.
5. **Archivos**: deuda por carpeta y archivo. **Historial**: análisis anteriores y qué
   deuda es nueva, cuál se resolvió y cuál cambió de severidad.
6. **Preguntar**: conversación con la IA sobre el análisis (solo recibe sus datos, nunca
   código); las referencias de la respuesta (`H2`) llevan al hallazgo.
7. **Configuración**: la cuenta (copia en la nube y «Cerrar sesión»), opciones del análisis (incluida la memoria máxima del proceso de
   análisis), proveedor y modelo de IA (con el catálogo de OpenRouter y sus modelos
   gratuitos), privacidad, presupuesto, credenciales y espacio en disco (vaciar la caché).

La IA funciona sin configurar nada: por defecto es la **IA incluida**, gpt-oss-120b (Groq)
con la cuenta de la aplicación y un cupo diario que se ve en Configuración
([IA-INCLUIDA.md](IA-INCLUIDA.md)). Para usar OpenRouter con tu clave: Configuración → Inteligencia artificial → elige
un modelo de la lista (filtro «Solo gratuitos») → si es gratuito, marca «Permitir
proveedores que guardan o entrenan con los datos» → Guardar cambios → pega la clave en
Credenciales → Comprobar. Después, **Explicar con IA** en cualquier hallazgo. Con
«Explicar automáticamente al terminar cada análisis», se explican los más importantes
(hasta el límite configurado) y, si está activado, se propone un plan de reducción.

## Arquitectura

```
┌────────────────────────── Proceso principal (Node) ──────────────────────────┐
│ main.ts      arranque, ventana, protocolo app://, endurecimiento             │
│ handlers.ts  un manejador por canal IPC   ◄── ipc-validation.ts (argumentos)  │
│ store.ts     SQLite (node:sqlite): proyectos, análisis, ajustes, secretos    │
│ credentials  cifrado con safeStorage (DPAPI en Windows)                      │
│ jobs.ts      un análisis a la vez, progreso, cancelación                     │
│ ai-service   catálogo de OpenRouter, comprobación de clave, explicar         │
│ snippets.ts  lectura segura del código citado por los hallazgos              │
└──────▲─────────────────────────────────────────────▲─────────────────────────┘
       │ IPC tipado (shared/ipc.ts)                  │ mensajes (worker/protocol.ts)
┌──────┴────────────────────┐              ┌────────┴──────────────────────────┐
│ preload.ts → window.radar │              │ utilityProcess: analysis-worker   │
│ Interfaz (React, sandbox) │              │ @radar/pipeline: motor, Git,      │
│ app://radar/index.html    │              │ GitHub, OSV/npm e IA del análisis │
└───────────────────────────┘              └───────────────────────────────────┘
```

| Carpeta | Contenido |
|---|---|
| `src/shared` | Tipos y reglas sin Node ni Electron: contrato IPC, ajustes y su validación, credenciales, estado de los trabajos, origen de la interfaz |
| `src/main` | Proceso principal. Lo que no depende de Electron (`policy.ts`, `ipc-dispatch.ts`, `store.ts`, `jobs.ts`…) se prueba en `test/` sin abrir la aplicación |
| `src/preload` | Puente mínimo: expone `window.radar` y devuelve los errores como excepciones con su mensaje en español |
| `src/worker` | Proceso del análisis. Recibe la petición y las claves por mensaje (nunca por variables de entorno) |
| `src/renderer` | Interfaz. Solo importa los **tipos** del motor (`@radar/engine` apunta a `types.ts`), nunca su código |
| `scripts` | Compilación (esbuild para los procesos de Node, Vite para la interfaz) y modo desarrollo |
| `e2e` | Prueba de extremo a extremo (`npm run e2e:desktop`) |

**Por qué un proceso aparte para el análisis.** Un repositorio grande puede tardar y usar
mucha memoria; en el proceso principal bloquearía la ventana. El `utilityProcess` se
puede terminar si no responde a la cancelación (5 s de margen) sin afectar a la
aplicación.

**Por qué `node:sqlite`.** Viene con Node 22+ y con el Node de Electron: sin módulos
nativos que recompilar para cada versión de Electron ni herramientas de compilación en
Windows (decisión D10 en [DECISIONES.md](DECISIONES.md)).

## Seguridad

Sigue la [lista de comprobación de Electron](https://www.electronjs.org/docs/latest/tutorial/security).
La interfaz se trata como no confiable: muestra datos de repositorios ajenos (nombres de
archivo, mensajes, fragmentos de código) y explicaciones de un modelo de lenguaje. El modelo
de amenazas completo y la auditoría de la fase 11 están en [SEGURIDAD.md](SEGURIDAD.md).

| Medida | Dónde |
|---|---|
| `sandbox`, `contextIsolation`, sin `nodeIntegration`, `webSecurity`; `app.enableSandbox()` para todos los procesos de interfaz | `main.ts`, `security.ts` |
| La interfaz se sirve desde `app://radar` (protocolo propio, sin `file://`) y no puede salir de su carpeta | `protocol.ts`, `policy.ts` |
| CSP estricta: nada externo (`default-src 'none'`, sin `unsafe-inline` ni `eval` fuera de desarrollo) | `policy.ts` |
| Sin navegación, redirecciones, ventanas nuevas ni `<webview>`; permisos (cámara, notificaciones…) denegados | `security.ts` |
| Enlaces externos solo `https` y a una lista cerrada de dominios, en el navegador del sistema | `policy.ts` |
| Cada mensaje IPC comprueba el remitente (solo la interfaz de la aplicación) y valida sus argumentos antes de llegar al manejador | `ipc-dispatch.ts`, `ipc-validation.ts` |
| Las credenciales se cifran con el sistema; la interfaz solo sabe si existen y de dónde vienen, nunca su valor | `credentials.ts` |
| La interfaz solo puede pedir fragmentos de archivos citados por un hallazgo, dentro del proyecto, sin enlaces simbólicos, de tamaño acotado y con los secretos ocultos | `snippets.ts` |
| «Mostrar en la carpeta» nunca abre el archivo (podría ejecutarse un `.js` o un `.bat`) | `main.ts` |
| La aplicación nunca escribe en los proyectos: las propuestas se copian o se guardan como parche donde elija el usuario, y el contenido del parche lo genera el proceso principal (la interfaz no puede escribir contenido arbitrario en disco) | `handlers.ts`, `main.ts` |
| Antes de enviar código para una propuesta con la privacidad «solo metadatos», se pide permiso mostrando el texto exacto que saldría | `FixConsentDialog.tsx`, `@radar/pipeline` |
| Las respuestas de la IA se muestran como texto, nunca como HTML | `lib/answer.ts` |
| Una sola instancia: una segunda apertura enfoca la ventana existente | `main.ts` |
| El servidor de desarrollo (`RADAR_DEV_SERVER_URL`) solo se acepta sin empaquetar y en `http://localhost` o `127.0.0.1`; sin herramientas de desarrollo en la aplicación empaquetada | `policy.ts`, `main.ts` |
| La interfaz no recibe líneas que el detector de secretos no puede examinar (más de 2000 caracteres) | `snippets.ts` |
| Sin sesión, solo responden los canales de la cuenta, `app:info` y abrir enlaces: no hay base de datos abierta. La interfaz nunca recibe los tokens de Supabase | `workspace.ts`, `account-handlers.ts`, `account-service.ts` |

La prueba de extremo a extremo comprueba que la interfaz no tiene `require` ni `process`,
que solo ve `window.radar`, que una clave guardada no vuelve a aparecer en la página y que
la petición a la IA no contiene código ni secretos con la privacidad por defecto.

**Aplicación instalada (fase 12):** va en un ASAR con su integridad comprobada y con los
*fuses* de Electron que impiden usarla como Node (`ELECTRON_RUN_AS_NODE`), inyectarle
código (`NODE_OPTIONS`) o depurarla (`--inspect`). `npm run dist` lo comprueba sobre el
ejecutable generado; ver [INSTALADOR.md](INSTALADOR.md). Quedan pendientes la firma con un
certificado y las actualizaciones automáticas firmadas.

## Datos

| Qué | Dónde (Windows) |
|---|---|
| Proyectos, historial (hasta 100 análisis por proyecto, informe completo comprimido), propuestas, conversaciones (200 mensajes por análisis), ajustes y credenciales cifradas, de cada cuenta | `%APPDATA%\radar-deuda\usuarios\<id>\radar.db` |
| Sesión de la cuenta (cifrada, solo con «Seguir conectado») | `%APPDATA%\radar-deuda\sesion.bin` |
| Copia de los proyectos y del historial, sin código (si está activada) | Supabase: tablas `projects` y `analyses` ([CUENTAS.md](CUENTAS.md#4-la-copia-en-la-nube-13b)) |
| Caché del motor, de la IA y de OSV/npm (compartida con la CLI) | `%LOCALAPPDATA%\radar-deuda\cache` |
| Clones de GitHub | `%LOCALAPPDATA%\radar-deuda\repos` |

Configuración → Aplicación muestra las rutas. La base de datos lleva su versión de
esquema y se migra al abrir; una base de datos de una versión más nueva no se abre (para
no estropearla). Quitar un proyecto borra su historial, nunca la carpeta ni el
repositorio.

Las claves también se aceptan por variables de entorno (`RADAR_OPENROUTER_API_KEY`,
`RADAR_ANTHROPIC_API_KEY`, `RADAR_OPENAI_API_KEY`, `RADAR_GITHUB_TOKEN`), como en la CLI.
Si hay una guardada, tiene preferencia. En Linux sin llavero del sistema no se pueden
guardar credenciales: solo funcionan las variables.

## Desarrollo

```powershell
npm run desktop:dev    # Vite con recarga en caliente; reinicia Electron al cambiar main, preload o worker
npm run desktop:build  # compila a apps/desktop/dist
npm run e2e:desktop    # compila y ejecuta la prueba de extremo a extremo
```

| Variable | Uso |
|---|---|
| `RADAR_SUPABASE_URL`, `RADAR_SUPABASE_PUBLISHABLE_KEY` | Otro proyecto de Supabase para las cuentas, en lugar del de `nube.json` ([CUENTAS.md](CUENTAS.md)) |
| `RADAR_DATA_DIR` | Carpeta de datos (base de datos) en lugar de `%APPDATA%\radar-deuda` |
| `RADAR_CACHE_DIR` | Caché y clones en lugar de `%LOCALAPPDATA%\radar-deuda` |
| `RADAR_E2E_ELECTRON` | Ejecutable de Electron para la prueba, si no es el de `node_modules` |
| `RADAR_E2E_KEEP=1` | No borrar la carpeta temporal de la prueba |

La prueba de extremo a extremo no sale a la red: simula OpenRouter y Supabase Auth dentro
del proceso principal. En Linux no se puede ejecutar como `root` (el sandbox de Chromium no lo admite)
y necesita una pantalla (`xvfb-run`).

## Diseño

Un plano técnico sobre pizarra: superficies azul pizarra, líneas finas y la tiza como
color de acción. La personalidad está en el radar; el resto es sobrio para que la
información mande.

- **Severidad**: color de estado siempre acompañado de forma y texto (◆ crítica,
  ▲ alta, ● media, ○ baja, – informativa), legible también sin color.
- **Contraste** comprobado (WCAG): texto principal 13,3:1, secundario 7,6:1 y apagado
  ≥ 4,5:1 sobre el fondo.
- **Teclado**: el radar y la evolución se recorren con el teclado; cada gráfico tiene su
  equivalente en tabla o lista (Hallazgos, Historial).
- **Letra**: Instrument Sans para la interfaz y JetBrains Mono para código y rutas, ambas
  incluidas en la aplicación (sin cargar nada de internet).
