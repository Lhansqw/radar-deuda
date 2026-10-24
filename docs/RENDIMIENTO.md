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

## Dónde se va el tiempo

- **Análisis por archivo**: parseo con la API de TypeScript (un AST por archivo, compartido
  por todos los analizadores). Con caché caliente no se lee ningún archivo.
- **Duplicación**: el índice de huellas es lineal; la verificación token a token solo se
  repite para pares de archivos cuyo contenido cambió.
- **Caché**: un JSON por repositorio; en el escenario grande su lectura y escritura domina
  el reanálisis. Si crece demasiado, la alternativa es SQLite en la aplicación (fase 10).

## Memoria

- El descubrimiento solo guarda metadatos; el contenido se lee archivo a archivo con
  concurrencia limitada (8 por defecto) y se libera tras analizarlo.
- La verificación de clones mantiene como mucho ≈4 M tokens en memoria (≈56 MB).
- Archivos > 1 MB solo se miden (líneas) y > 20 MB se ignoran; ambos límites son
  configurables.
