# Radar de Deuda Técnica

Aplicación de escritorio para Windows que analiza repositorios (locales o de GitHub),
detecta deuda técnica con herramientas deterministas y usa inteligencia artificial
para explicar, priorizar y proponer correcciones a los hallazgos.

> Estado: en desarrollo por fases. Ver [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md).

## Estado por fases

| Fase | Contenido | Estado |
|---|---|---|
| 1 | Viabilidad y arquitectura | ✅ |
| 2 | Comparación de tecnologías y stack | ✅ |
| 3 | Herramientas y entorno en Windows | ✅ |
| 4 | Estructura del proyecto y TypeScript | ✅ |
| 5 | Motor de análisis (primera versión funcional) + pruebas y benchmark | ✅ |
| 6 | Git, GitHub, puntos críticos, vulnerabilidades (OSV) y versiones (npm) | ✅ |
| 7 | Capa de IA con proveedores intercambiables (local y nube), privacidad y validación | ✅ |
| 8 | Aplicación de escritorio: proyectos, panel con radar, hallazgos, historial, configuración e IA bajo demanda | ✅ |
| 9 | Recomendaciones, propuestas de corrección y chat | Pendiente |
| 10 | Caché, análisis incremental y optimización (parte del motor ya hecha) | Parcial |
| 11 | Pruebas, auditorías de seguridad y rendimiento | Pendiente |
| 12 | Instalador para Windows | Pendiente |

**Deuda conocida del propio motor** (la detecta al analizarse a sí mismo): algunas funciones
orquestadoras superan el umbral de complejidad (`processFile`, `refineCandidates`, `main` de
la CLI, `analyzeProject` de dependencias). Se refactorizarán en la fase 11.

## Principios

1. **La evidencia la producen herramientas, no el modelo.** Cada hallazgo tiene
   ubicación exacta, métrica o coincidencia verificable, severidad, confianza y
   una estimación de esfuerzo con su fórmula.
2. **La IA explica y prioriza; no inventa.** Sus respuestas distinguen evidencia,
   inferencia y recomendación, y se validan contra los hallazgos.
3. **Nunca se ejecuta código del repositorio analizado** ni se aplican cambios sin
   autorización explícita del usuario.
4. **Barato primero.** Análisis deterministas e incrementales; la IA solo se usa
   donde aporta valor.

## Estructura

```
radar-deuda/
├─ packages/
│  └─ engine/            Motor de análisis determinista (sin Electron, sin red)
│     ├─ src/
│     │  ├─ analyzers/   Un archivo por analizador (registro en index.ts)
│     │  ├─ discovery.ts Recorrido seguro del repositorio
│     │  ├─ cache.ts     Caché incremental persistente
│     │  └─ engine.ts    Orquestador: analyzeRepository()
│     ├─ test/           Pruebas unitarias y de integración (Vitest)
│     └─ scripts/        Benchmark de rendimiento
│  ├─ sources/           Efectos externos: Git endurecido, GitHub, OSV, registro npm
│  ├─ ai/                IA independiente del proveedor: explica y prioriza sin inventar
│  ├─ pipeline/          Análisis completo (origen, motor, Git, dependencias, IA); lo usan la CLI y la app
│  └─ cli/               Comando radar-deuda: opciones de la terminal e impresión del informe
├─ examples/demo-repo/   Repositorio con deuda técnica intencionada
├─ docs/                 Arquitectura, decisiones, entorno, metodología, rendimiento
├─ tsconfig.base.json    TypeScript estricto compartido
├─ eslint.config.js
└─ vitest.config.ts
```

La aplicación de escritorio está en `apps/desktop` (Electron 44 + React 19); ver
[docs/ESCRITORIO.md](docs/ESCRITORIO.md).

En desarrollo, los paquetes se importan entre sí desde su código fuente (`paths` en
`tsconfig.json` y `alias` en `vitest.config.ts`); `npm run build` los compila en orden.

## Comandos

```powershell
npm ci            # instala dependencias exactas del lockfile
npm run check     # tipos + lint + pruebas (debe pasar antes de cada commit; nunca sale a la red)
npm run test:live # pruebas contra servicios reales (requieren RADAR_LIVE=1 o RADAR_LIVE_LLM)
npm run build     # compila los paquetes en orden (engine → sources → ai → pipeline → cli) a packages/*/dist
npm run bench     # benchmark de rendimiento (añade -- --large para 5 000 archivos)
npm run desktop   # compila y abre la aplicación de escritorio
npm run desktop:dev   # aplicación con recarga en caliente de la interfaz
npm run e2e:desktop   # prueba de extremo a extremo de la aplicación (abre una ventana; sin red)
```

## Analizar un repositorio

```powershell
npm run analyze -- examples\demo-repo
npm run analyze -- C:\ruta\a\otro\repo --json informe.json
npm run analyze -- C:\ruta\a\otro\repo --fail-on high   # código 1 si hay hallazgos altos o críticos (CI)
```

```powershell
npm run analyze -- Lhansqw/radar-deuda                   # repositorio de GitHub (se clona)
npm run analyze -- C:\ruta\a\otro\repo --online          # + vulnerabilidades (OSV) y versiones (npm)
npm run analyze -- . --baseline antes.json --fail-on-new medium   # CI: falla solo si se añade deuda
npm run analyze -- C:\ruta\a\otro\repo --ai lmstudio          # explicaciones y plan con un modelo local
npm run models -- --gratis                                    # modelos de OpenRouter compatibles
npm run analyze -- C:\ruta\a\otro\repo --ai openrouter --ai-model proveedor/modelo
```

Todas las opciones: `npm run analyze -- --help`. `Ctrl+C` cancela. Detalles de GitHub, el
token y qué datos salen del equipo en [docs/FUENTES.md](docs/FUENTES.md).

La caché se guarda en `%LOCALAPPDATA%\radar-deuda\cache` (y los clones de GitHub en
`%LOCALAPPDATA%\radar-deuda\repos`), nunca dentro del repositorio analizado. La variable
`RADAR_CACHE_DIR` cambia esa carpeta (los clones van entonces en su subcarpeta `repos`);
la CLI y la aplicación de escritorio la comparten. El motor solo **lee** archivos: no ejecuta código, no instala dependencias y no
hace peticiones de red. Solo `--online` y los repositorios de GitHub usan la red, y nunca
se envía código.

`examples/demo-repo` contiene deuda técnica intencionada (función compleja, duplicación,
ciclo, secreto, dependencias problemáticas) para comprobar que cada analizador funciona.

## Documentación

| Documento | Contenido |
|---|---|
| [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) | Fase 1: viabilidad, riesgos, arquitectura y MVP |
| [docs/DECISIONES.md](docs/DECISIONES.md) | Fase 2: comparación de tecnologías y stack |
| [docs/ENTORNO-WINDOWS.md](docs/ENTORNO-WINDOWS.md) | Fase 3: herramientas y preparación del entorno |
| [docs/METODOLOGIA.md](docs/METODOLOGIA.md) | Puntuación, severidad, confianza y estimaciones de esfuerzo |
| [docs/RENDIMIENTO.md](docs/RENDIMIENTO.md) | Objetivos, benchmark y resultados medidos |
| [docs/FUENTES.md](docs/FUENTES.md) | Fase 6: Git, GitHub, token, privacidad y dependencias en línea |
| [docs/IA.md](docs/IA.md) | Fase 7: qué necesitas, proveedores (incluidos modelos gratuitos de OpenRouter), privacidad y cómo se evita que la IA invente |
| [docs/ESCRITORIO.md](docs/ESCRITORIO.md) | Fase 8: uso de la aplicación, arquitectura de procesos, seguridad, datos y diseño |
