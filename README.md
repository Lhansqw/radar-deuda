# Radar de Deuda Técnica

Aplicación de escritorio para Windows que analiza repositorios (locales o de GitHub),
detecta deuda técnica con herramientas deterministas y usa inteligencia artificial
para explicar, priorizar y proponer correcciones a los hallazgos.

> Estado: en desarrollo por fases. Ver [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md).

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
│     └─ test/
├─ docs/                 Arquitectura, decisiones, entorno, metodología
├─ tsconfig.base.json    TypeScript estricto compartido
├─ eslint.config.js
└─ vitest.config.ts
```

Paquetes previstos: `packages/sources` (Git y GitHub, fase 6), `packages/ai` (fase 7) y
`apps/desktop` (Electron + React, fase 8).

## Comandos

```powershell
npm ci            # instala dependencias exactas del lockfile
npm run check     # tipos + lint + pruebas (debe pasar antes de cada commit)
npm run build     # compila el motor a packages/engine/dist
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
