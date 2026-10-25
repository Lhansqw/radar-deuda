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
| 6 | Git, GitHub y vulnerabilidades (OSV) | Pendiente |
| 7 | Capa de IA con proveedores intercambiables | Pendiente |
| 8 | Aplicación de escritorio y panel de resultados | Pendiente |
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
│  └─ cli/               Comando radar-deuda: orquesta el motor y las fuentes
├─ examples/demo-repo/   Repositorio con deuda técnica intencionada
├─ docs/                 Arquitectura, decisiones, entorno, metodología, rendimiento
├─ tsconfig.base.json    TypeScript estricto compartido
├─ eslint.config.js
└─ vitest.config.ts
```

Paquetes previstos: `packages/sources` (Git y GitHub, fase 6), `packages/ai` (fase 7) y
`apps/desktop` (Electron + React, fase 8).

En desarrollo, los paquetes se importan entre sí desde su código fuente (`paths` en
`tsconfig.json` y `alias` en `vitest.config.ts`); `npm run build` los compila en orden.

## Comandos

```powershell
npm ci            # instala dependencias exactas del lockfile
npm run check     # tipos + lint + pruebas (debe pasar antes de cada commit)
npm run build     # compila los paquetes en orden (engine → cli) a packages/*/dist
npm run bench     # benchmark de rendimiento (añade -- --large para 5 000 archivos)
```

## Analizar un repositorio

```powershell
npm run analyze -- examples\demo-repo
npm run analyze -- C:\ruta\a\otro\repo --json informe.json
npm run analyze -- C:\ruta\a\otro\repo --fail-on high   # código 1 si hay hallazgos altos o críticos (CI)
```

Opciones: `--json <archivo>`, `--no-cache`, `--cache-dir <dir>`, `--concurrency <n>`,
`--top <n>`, `--fail-on <critical|high|medium|low>`, `--quiet`. `Ctrl+C` cancela.

La caché se guarda en `%LOCALAPPDATA%\radar-deuda\cache`, nunca dentro del repositorio
analizado. El motor solo **lee** archivos: no ejecuta código, no instala dependencias y no
hace peticiones de red.

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
