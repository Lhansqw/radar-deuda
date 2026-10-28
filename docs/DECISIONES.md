# Fase 2 — Decisiones de tecnología

Cada decisión indica alternativas, criterio y consecuencias. Si una decisión cambia, se
añade una entrada nueva en lugar de editar la anterior.

## D1. Electron frente a Tauri

| Criterio | Electron | Tauri 2 |
|---|---|---|
| Lenguaje del proceso privilegiado | Node.js (TypeScript) | Rust |
| Ejecutar el motor (TypeScript Compiler API) | Nativo, en `utilityProcess` | Necesita un *sidecar* Node empaquetado aparte |
| Tamaño del instalador | ~90–120 MB | ~5–15 MB **sin** el motor; con Node como *sidecar*, +40–70 MB |
| RAM en reposo | Mayor (Chromium propio) | Menor (WebView2 del sistema) |
| Toolchain en Windows | Solo Node.js | Rust + MSVC Build Tools + WebView2 |
| Aislamiento de la interfaz | `contextIsolation`, `sandbox`, preload tipado | Modelo de permisos por comando (muy bueno) |
| Credenciales | `safeStorage` (DPAPI en Windows) | Plugin *stronghold* o keyring en Rust |
| Procesos en segundo plano cancelables | `utilityProcess` (se puede terminar) | *Sidecar* (se puede terminar) |
| Un solo lenguaje en todo el proyecto | Sí | No (TS + Rust) |

**Decisión: Electron.** El componente más pesado y crítico es el motor de análisis, y está
escrito en TypeScript sobre la API del compilador de TypeScript. Con Tauri habría que
empaquetar Node como *sidecar*, lo que elimina la ventaja de tamaño y añade un segundo
lenguaje y una toolchain de Rust en Windows. La mayor RAM de Electron se mitiga ejecutando
el análisis en un `utilityProcess` que se termina al acabar.

**Consecuencias:** mantener Electron actualizado (una versión mayor cada ~8 semanas; solo
reciben parches las tres últimas) y aplicar su lista de comprobación de seguridad desde el
primer día (fase 8).

## D2. Node.js 24 LTS como entorno de desarrollo

Electron 43–45 incluyen Node 24. Desarrollar con la misma versión mayor evita diferencias
entre la CLI y la aplicación. El repositorio fija `24` en `.nvmrc` y exige `>=22.13` en
`engines` (mínimo con `fs.opendir` asíncrono y `AbortSignal.throwIfAborted`).

## D3. TypeScript estricto en todo el código

`strict` más `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` y
`verbatimModuleSyntax`. Encarece un poco escribir código, pero elimina clases enteras de
errores (accesos fuera de rango, `undefined` implícitos) en un motor que procesa entradas
arbitrarias.

## D4. Monorepo con npm workspaces

| Alternativa | Motivo para no elegirla ahora |
|---|---|
| pnpm workspaces | Mejor rendimiento de instalación, pero añade una herramienta más que instalar |
| Nx / Turborepo | Complejidad innecesaria para 3–4 paquetes |

npm viene con Node y basta. Se puede migrar a pnpm sin tocar el código.

## D5. Motor de análisis: herramientas

| Necesidad | Elegido | Alternativas evaluadas |
|---|---|---|
| AST de JS/TS | TypeScript Compiler API | Babel (sin tipos), SWC (sin API de recorrido estable en JS), tree-sitter (multilenguaje, se reevaluará para otros lenguajes) |
| Duplicación | Implementación propia: tokens + *winnowing* | jscpd: correcto, pero no expone huellas por archivo, así que no permite análisis incremental; ejecutarlo como proceso externo complica la caché |
| Complejidad | Cognitiva (SonarSource) + ciclomática (McCabe) propias | eslint `complexity`: solo ciclomática, requiere configurar ESLint por repositorio |
| Reglas y errores potenciales | ESLint y Semgrep como analizadores enchufables (posterior) | — |
| Exclusiones | Paquete `ignore` (semántica exacta de `.gitignore`) | `minimatch`: no replica `.gitignore` |
| Vulnerabilidades | API de OSV (fase 6) | `npm audit`: requiere lockfile y ejecutar npm sobre el repositorio |

Implementar complejidad y duplicación permite que sus resultados sean **artefactos
cacheables por archivo**, base del análisis incremental.

## D6. Persistencia: SQLite

`better-sqlite3` en el proceso principal de Electron (fase 8): síncrono, rápido, un solo
archivo, transacciones. La caché del motor es un JSON por repositorio porque el motor no
debe depender de un módulo nativo (se usa también desde la CLI y en CI).

## D7. Interfaz: React + Vite

React por ecosistema y madurez; Vite por arranque rápido y
compilación del *renderer*. Sin librería de componentes pesada: CSS propio con variables,
tablas virtualizadas para listas largas de hallazgos.

## D8. Calidad: Vitest + ESLint (flat config) + `tsc --noEmit`

Vitest es compatible con TypeScript y ESM sin configuración adicional. `npm run check`
encadena tipos, lint y pruebas, y es lo que debe pasar antes de cada commit.

## D9. Capa de IA independiente del proveedor

Interfaces propias en TypeScript; los SDK de proveedores solo dentro de sus adaptadores.
El adaptador compatible con OpenAI cubre también modelos locales (LM Studio, Ollama,
llama.cpp), así que el soporte local no requiere código específico.

## D10. SQLite integrado en Node (`node:sqlite`) en lugar de `better-sqlite3` (fase 8)

Sustituye la elección de biblioteca de D6; el resto de D6 (SQLite en el proceso principal,
caché del motor en JSON) se mantiene.

| Criterio | `better-sqlite3` | `node:sqlite` |
|---|---|---|
| Instalación | Módulo nativo: hay que recompilarlo para la versión de Electron (`@electron/rebuild`) o descargar binarios precompilados; si no los hay, exige Visual Studio Build Tools y Python en Windows | Incluido en Node 24 y, por tanto, en Electron 44 (SQLite 3.53) |
| API | Síncrona, muy completa | Síncrona (`DatabaseSync`), suficiente: sentencias preparadas, transacciones con `BEGIN`/`COMMIT`, BLOB |
| Estabilidad | Madura | Marcada aún como experimental en Node; la API usada es la básica |
| Empaquetado (fase 12) | Hay que desempaquetar el `.node` del asar | Nada que empaquetar |

**Decisión: `node:sqlite`.** Elimina el único módulo nativo previsto y, con él, el paso de
compilación más frágil en Windows. Comprobado en Electron 44.9.3 (proceso principal) y en
Node 22 y 24 (pruebas). Si la API cambiara, el acceso está concentrado en
`apps/desktop/src/main/store.ts`.

**Consecuencias:** las pruebas de la base de datos necesitan Node ≥ 22.13 (ya exigido en
`engines`), y Node 22 muestra un aviso de función experimental al usarla.

## D11. Cuentas de usuario: Supabase Auth (fase 13)

La aplicación debe exigir inicio de sesión, con las cuentas en una base de datos en la nube
(la misma cuenta en cualquier equipo) y acceso con correo y contraseña.

| Criterio | Cuentas locales (SQLite) | Supabase (Auth + PostgreSQL) | Firebase Auth + Firestore | Servidor propio (API + PostgreSQL/MySQL) |
|---|---|---|---|---|
| La misma cuenta en varios equipos | No | Sí | Sí | Sí |
| Base de datos | La actual | PostgreSQL con reglas por filas (RLS) | Documentos (NoSQL) | La que se elija |
| Qué hay que mantener | Nada | Un proyecto en su panel | Un proyecto en su panel | El servidor, su despliegue y sus actualizaciones |
| Correos (confirmación, recuperación) | No hay | Incluidos, con plantillas y código de un solo uso | Incluidos | Hay que montarlos |
| Guardar contraseñas | Lo haría la aplicación | Supabase (bcrypt) | Google | Lo haría el servidor |
| Coste para el proyecto | Ninguno | Plan gratuito suficiente | Plan gratuito suficiente | Alojamiento |

**Decisión: Supabase.** Da autenticación probada (contraseñas, límites de intentos,
correos) sin servidor propio, y la base de datos es PostgreSQL relacional, como el resto del
proyecto (SQLite), con reglas por filas que la fase 13b usará para que cada usuario solo
lea sus proyectos. El cliente oficial (`@supabase/supabase-js`, MIT) funciona en el proceso
principal de Electron.

**Cómo encaja con lo que ya había:**

- El cliente vive en el proceso principal; la interfaz solo ve el estado de la cuenta
  (mismo criterio que las credenciales de IA).
- La conexión (URL y clave publicable) llega por variables de entorno o se incrusta al
  compilar; la clave secreta se rechaza siempre.
- Los datos locales siguen en SQLite, una base de datos por cuenta: la aplicación funciona
  sin conexión con una sesión guardada. La fase 13b añade la copia en PostgreSQL de
  proyectos e historial (local primero: la nube es una copia que se sincroniza), nunca de las
  claves de IA, de lo que dice la IA ni del código.
- Los correos llevan un código en lugar de un enlace, porque una aplicación de escritorio
  no puede recibir el enlace.

**Consecuencias:** hace falta un proyecto de Supabase (ver [CUENTAS.md](CUENTAS.md)), con
servidor de correo propio para que se registre cualquier persona; sin conexión configurada
la aplicación no deja entrar. La CLI sigue sin cuentas.


## D12. IA sin claves para el usuario: función de Supabase con modelos gratuitos (fase 14)

La aplicación debe poder usar la IA sin que el usuario cree ni pegue ninguna clave, y la IA
debe estar en la nube (no local).

| Criterio | Clave de OpenRouter dentro de la aplicación | Función de Supabase con la clave del proyecto | Servidor propio |
|---|---|---|---|
| ¿Se puede robar la clave? | Sí: cualquiera la saca del instalador | No: es un secreto del proyecto | No |
| Solo usuarios con cuenta | No | Sí (token de la sesión) | Sí, si se programa |
| Limitar el gasto | Solo el límite de la clave, para todos | Solo modelos gratuitos y cupo diario por cuenta | Lo que se programe |
| Qué hay que mantener | Nada | Una función y una tabla en el proyecto que ya existe | Servidor, despliegue y actualizaciones |
| Coste | El de los modelos | Ninguno con modelos gratuitos (plan gratuito de Supabase) | Alojamiento |

**Decisión: función «ia» en Supabase.** Reutiliza las cuentas y la base de datos de la fase
13, habla la misma API que OpenRouter (en la aplicación es el proveedor de OpenRouter
apuntando a la función, con el token de la sesión como credencial) y el usuario eligió solo
modelos gratuitos, con un cupo diario por cuenta.

**Consecuencias:** el dueño del proyecto instala la función y su tabla una vez
([IA-INCLUIDA.md](IA-INCLUIDA.md)). El cupo total depende del límite diario de OpenRouter
para su clave (50 consultas gratuitas al día, o 1000 con 10 USD de crédito comprado). Los
modelos gratuitos son más lentos e inestables y sus proveedores pueden guardar lo que
reciben; por defecto solo se envían metadatos. OpenRouter con clave propia y los demás
proveedores siguen disponibles.
