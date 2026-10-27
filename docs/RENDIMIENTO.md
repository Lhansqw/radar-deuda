# Rendimiento

## Cómo medir

```powershell
npm run bench            # repositorios sintéticos pequeño (100 archivos) y mediano (1 000)
npm run bench -- --large # añade el grande (5 000 archivos, ≈450 k líneas)
```

El script compila el motor, genera repositorios TypeScript deterministas, y ejecuta cada
medición en un proceso Node nuevo: primero en frío (caché vacía) y después sin cambios
(caché caliente). Termina con código 1 si no se cumple algún objetivo y guarda el detalle
en `bench-results/` (ignorado por Git).

## Objetivos

Definidos en [ARQUITECTURA.md §6](ARQUITECTURA.md#6-objetivos-de-rendimiento).

| Escenario | Frío | RAM pico | Reanálisis / frío |
|---|---|---|---|
| Pequeño (100 archivos) | ≤ 1 s | ≤ 256 MB | ≤ 25 % |
| Mediano (1 000 archivos) | ≤ 10 s | ≤ 512 MB | ≤ 25 % |
| Grande (5 000 archivos) | ≤ 50 s | ≤ 1 GB | ≤ 25 % |

## Resultados de referencia

Contenedor Linux con 2 vCPU, Node 22. En un equipo de escritorio con más núcleos los tiempos
en frío deberían ser menores; vuelve a medir en Windows con `npm run bench -- --large` y
compara.

| Escenario | Líneas | Frío | CPU | RAM pico | Reanálisis | Hallazgos |
|---|---|---|---|---|---|---|
| Pequeño | 8 493 | 0,31 s | 0,44 s | 152 MB | 0,06 s (18 %) | 281 |
| Mediano | 89 059 | 1,92 s | 2,27 s | 241 MB | 0,34 s (18 %) | 2 365 |
| Grande | 445 992 | 6,71 s | 7,36 s | 460 MB | 0,92 s (14 %) | 11 145 |

### Historial

| Commit | Cambio | Mediano frío | Mediano reanálisis |
|---|---|---|---|
| `test(engine): benchmark…` | Primera medición | 7,38 s | 6,17 s (84 %) ✗ |
| `perf(engine): duplicación incremental…` | Caché de verificación por par + LRU de tokens | 1,92 s | 0,34 s (18 %) ✓ |

Medición de la fase 10 (mismo contenedor, otra sesión: sus tiempos absolutos varían ±30 %
entre sesiones, compara proporciones): pequeño 0,46 s / 17 %, mediano 2,60 s / 20 %,
grande 9,35 s / 15 %, 460 MB de RAM pico. Todos los objetivos se cumplen.

## Repositorio real

`expressjs/express` (6 183 commits, historial desde 2010), con la CLI de principio a fin:

| Cambio (fase 10) | Reanálisis sin cambios |
|---|---|
| Antes | 2,79 s |
| Caché del historial de Git por commit (`perf(pipeline)…`) | 1,18 s |
| Compilador de TypeScript cargado solo si hace falta (`perf(engine)…`) | 0,55 s |

Con la caché caliente, el motor tarda 0,09 s en ese repositorio: el resto era leer el
historial (`git log --numstat`, 0,77 s) y cargar el compilador de TypeScript (≈0,35 s), que
ya no se hace si nada cambió.

## Dónde se va el tiempo

- **Análisis por archivo**: parseo con la API de TypeScript (un AST por archivo, compartido
  por todos los analizadores). Con caché caliente no se lee ningún archivo.
- **Duplicación**: el índice de huellas es lineal; la verificación token a token solo se
  repite para pares de archivos cuyo contenido cambió.
- **Caché**: un JSON por repositorio; en el escenario grande (20 MB) su lectura y la
  recolección de basura que provoca son la mitad del reanálisis. Solo se reescribe si algo
  cambió. La mitad de su tamaño son los hallazgos de complejidad completos; guardar solo
  las métricas y reconstruir los textos es la siguiente optimización si hiciera falta.
- **Historial de Git**: se guarda por commit en `<caché>/git` (un archivo por repositorio);
  solo se vuelve a leer si cambia HEAD, la fecha de inicio, la carpeta o el tipo de clon.
- **Compilador de TypeScript**: se carga la primera vez que hay que analizar un archivo o
  verificar un par de duplicados nuevo. Un reanálisis sin cambios no lo carga.

## Mantenimiento de la caché

`npm run cache` muestra cuánto ocupa por partes; `-- --limpiar [días]` borra lo que no se
usa desde hace ese tiempo (90 por defecto) y `-- --vaciar` la vacía. La aplicación hace lo
mismo desde Configuración y limpia sola lo que lleva 90 días sin usarse. Solo se borran
archivos con los nombres que crea la herramienta; los clones de GitHub no son caché (la
aplicación borra el de un proyecto al quitarlo).

## Memoria

- El descubrimiento solo guarda metadatos; el contenido se lee archivo a archivo con
  concurrencia limitada (8 por defecto) y se libera tras analizarlo.
- La verificación de clones mantiene como mucho ≈4 M tokens en memoria (≈56 MB).
- Archivos > 1 MB solo se miden (líneas) y > 20 MB se ignoran; ambos límites son
  configurables.
- **`.radarignore`** en la raíz del proyecto (sintaxis de `.gitignore`) excluye carpetas
  generadas o de terceros; el informe lo declara en sus límites.
- **Aplicación:** el análisis corre en un proceso con su propio límite de montículo
  (Configuración → Análisis, 512–4096 MB; 4 GB es el máximo de un proceso de Electron).
  Al pasar del 90 % se detiene con un aviso que dice cuánto usaba y qué hacer, en lugar de
  morir sin explicación. El límite se pasa como opción de V8 (`--js-flags`): en un
  `utilityProcess`, `--max-old-space-size` a secas no tiene efecto.
