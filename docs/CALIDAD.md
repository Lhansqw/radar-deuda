# Calidad: pruebas, cobertura e integración continua (fase 11)

## Pruebas

```powershell
npm run check          # tipos + lint + pruebas; debe pasar antes de cada commit y nunca sale a la red
npm run test:coverage  # lo mismo con cobertura (informe en coverage/index.html)
npm run e2e:desktop    # la aplicación de Electron de extremo a extremo (abre una ventana)
npm run test:live      # contra servicios reales, solo con RADAR_LIVE=1 o RADAR_LIVE_LLM
npm run test:db        # esquema de la nube y sus políticas en un PostgreSQL (RADAR_TEST_DATABASE_URL)
npm run bench          # rendimiento con repositorios sintéticos (-- --large para 5 000 archivos)
```

| Parte | Archivos de prueba | Pruebas | Qué cubren |
|---|---|---|---|
| `packages/engine` | 19 | 175 | Cada analizador, caché, configuración, puntuación, comparación entre informes, referencias, `.radarignore`, carga perezosa del compilador |
| `packages/sources` | 8 | 97 (+3 en vivo) | Git endurecido, historial y puntos críticos, GitHub (URL, API, clonado), OSV, versiones de npm, CVSS, redirecciones con servidores HTTP reales |
| `packages/ai` | 12 | 120 (+2 en vivo) | Proveedores con `fetch` simulado, privacidad, redacción de secretos, validación contra inyecciones, propuestas y parches, preguntas, presupuesto |
| `packages/pipeline` | 3 | 18 | Análisis completo, origen de GitHub (con GitHub simulado), caché del historial, pasos de IA, mantenimiento de la caché |
| `packages/cli` | 5 | 27 | Opciones, códigos de salida, comparación, IA, caché |
| `apps/desktop` | 18 | 159 | IPC (remitente y argumentos), cuentas y sesión (con Supabase simulado), datos por cuenta, copia en la nube (dos equipos y otra cuenta contra la API simulada), credenciales, ajustes, base de datos y migraciones, trabajos, fragmentos, seguridad, lógica de la interfaz |
| **Total** | **65** | **596** (+5 en vivo) | |

Además, `npm run test:db` aplica la migración de `supabase/migrations` en un PostgreSQL real y
comprueba sus políticas de seguridad por filas y sus permisos como los vería la aplicación
(ver [CUENTAS.md](CUENTAS.md#6-pruebas)).

Las pruebas «en vivo» llaman a servicios reales. `npm run check` las desactiva aunque
queden variables olvidadas en la terminal, para no salir a la red ni gastar cuota.

La prueba de extremo a extremo abre la aplicación compilada con Playwright, simula OpenRouter
y Supabase dentro del proceso principal (sin red) y recorre el flujo completo:

0. crear una cuenta y confirmar el correo con el código (también uno erróneo);
1. añadir un proyecto y analizarlo dos veces; el proyecto y el análisis suben a la nube sin código;
2. abrir el panel, los hallazgos, los archivos y el historial;
3. elegir un modelo gratuito y guardar la clave; se comprueba que no vuelve a aparecer;
4. pedir una explicación y comprobar que no se envía código;
5. proponer una corrección con el permiso explícito y aplicar el parche con `git apply`;
6. preguntar sobre el análisis y abrir la referencia de la respuesta;
7. cerrar la sesión, probar una contraseña equivocada y volver a entrar.

También comprueba que la interfaz no tiene `require` ni `process`, que sin sesión no llega a
ningún dato y que no guarda nada de la sesión.

## Cobertura

Medida con V8 sobre el código fuente (sin los puntos de entrada que solo arrancan procesos):

| Parte | Líneas | Funciones | Ramas | Mínimo exigido |
|---|---|---|---|---|
| Paquetes (motor, fuentes, IA, pipeline, CLI) | 97,0 % | 95,9 % | 83,1 % | 95 / 92 / 78 |
| Aplicación: proceso principal, compartido y proceso de análisis | 85,8 % | 73,0 % | 82,9 % | 80 / 70 |
| Aplicación: vistas y componentes de React | — | — | — | Cubiertos por la prueba de extremo a extremo |

Los mínimos están algo por debajo de lo medido: una bajada notable hace fallar la
integración continua.

## Integración continua

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml), en cada push a `main` y cada pull
request:

| Trabajo | Qué hace |
|---|---|
| Comprobar | `npm run check` en Windows y Ubuntu con Node 24, y en Ubuntu con Node 22 (la mínima) |
| Dependencias | `npm audit` (moderada o superior) y `npm audit signatures` |
| Calidad | Autoanálisis con el historial completo (`--fail-on high`), cobertura con sus mínimos y benchmark informativo; publica el informe JSON, la cobertura y el rendimiento |
| Base de datos | `npm run test:db` con PostgreSQL 17: el esquema de la nube y sus políticas de seguridad por filas |
| Aplicación de escritorio e instalador | La prueba de extremo a extremo en Windows (capturas como artefacto) y el instalador con la comprobación del paquete (artefacto `instalador-windows`) |
| Paquete (Linux) | El mismo paquete en Linux, comprobado con una pantalla virtual |

Dependabot propone cada semana las actualizaciones de npm (agrupadas) y de las acciones. Los
detalles de seguridad de la propia integración continua están en [SEGURIDAD.md](SEGURIDAD.md).

## Refactorización de la deuda propia

El radar se analizó a sí mismo y se corrigieron, una por una, todas las funciones con deuda
alta. Comparación entre el inicio de la refactorización (commit `450ce96`) y el final, con
`npm run analyze -- . --no-history`:

| | Antes | Después |
|---|---|---|
| Puntuación | 99/100 (A) | 99/100 (A) |
| Ratio de deuda | 0,72 % | 0,35 % |
| Esfuerzo estimado | 73 h | 38 h |
| Hallazgos altos o críticos | 19 | **0** |
| Hallazgos en total | 90 | 68 |
| Archivos demasiado grandes | 1 | 0 |

| Función | Complejidad cognitiva antes | Qué se hizo |
|---|---|---|
| `runAi` (IA) | 58 | Una clase `AiRun` con un método por etapa; `FatalStop` para la parada al primer error general |
| `parseAiOptions` (CLI) | 50 | Lista ordenada de comprobaciones; la primera que falla da el mensaje |
| `scanSecrets` (motor) | 38 | Rasgos del archivo, formatos conocidos, contraseña de URL y asignación genérica por separado |
| `diffOps`, `formatPatch` (IA) | 38, 37 | Extremos comunes, tabla LCS, recorrido; parche por archivo y por línea |
| `refineCandidates`, `findCandidates` (motor) | 36, 31 | Agrupar por par de archivos, verificar, quitar repetidos; índice de huellas, emparejar, fusionar |
| `formatAiSection`, `formatReport`, `reportDigest` | 36, 35, 34 | Una función por bloque del texto |
| `parseCli` (CLI) | 35 | Leer, comprobar y construir las opciones |
| `processFile` (motor) | 34 | Caché por metadatos, archivos grandes, caché por contenido, análisis |
| `finalize` de arquitectura (motor) | 34 | Grafo de importaciones y cada tipo de hallazgo por separado |
| `analyzeProject` de dependencias (motor) | 32 | Una función por regla |
| `discoverFiles` (motor) | 32 → 17 | Recorrido, decisión por entrada y metadatos por separado |
| `validateSettings`, `layoutRadar`, `cvss3BaseScore` | 31, 31, 30 | Lector de campos con errores; geometría por pasos; pasos de la especificación de CVSS |
| `Settings` (interfaz, 640 líneas) | 27 | Una sección por archivo en `views/settings/` y las reglas en `lib/` con pruebas |

Además, `duplication.ts` (521 líneas) se separó en tokens, emparejamiento y analizador. El
marcado repetido entre el panel y el historial pasó a un componente.

**Cómo se comprobó que nada cambiaba.** Las pruebas existentes se mantuvieron sin tocar
expectativas. Además, cada refactorización se comparó con la versión anterior sobre las
mismas entradas:

- el informe completo, byte a byte, sobre una copia del proyecto, zod, @babel y vite, en
  frío y desde la caché;
- miles de combinaciones de opciones de la CLI y de ajustes, y 20 000 pares de textos para
  las diferencias;
- todos los vectores CVSS posibles (38 885).

En todos los casos la salida fue idéntica. La refactorización no cambió el rendimiento: en la
misma máquina, el benchmark mediano tarda 3,33 s antes y 3,25 s después. Las mejoras de
memoria de la auditoría de rendimiento, con repositorios reales como microsoft/vscode, están
en [RENDIMIENTO.md](RENDIMIENTO.md#repositorios-reales-fase-11).
