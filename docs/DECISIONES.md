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
