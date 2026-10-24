# Metodología de la puntuación y de los hallazgos

## Puntuación de mantenibilidad

Se basa en el modelo **SQALE** (*Software Quality Assessment based on Lifecycle
Expectations*), el mismo principio que usa SonarQube para su *maintainability rating*.

```
coste de desarrollo  = líneas de código no vacías × 30 min
deuda                = Σ minutos de corrección estimados de los hallazgos (excepto `info`)
ratio de deuda       = deuda / coste de desarrollo
puntuación (0–100)   = 100 × (1 − ratio / 0,5), acotada a [0, 100]
```

| Calificación | Ratio de deuda | Puntuación |
|---|---|---|
| A | ≤ 5 % | ≥ 90 |
| B | ≤ 10 % | ≥ 80 |
| C | ≤ 20 % | ≥ 60 |
| D | ≤ 50 % | ≥ 0 |
| E | > 50 % | 0 |

La puntuación es una transformación lineal del ratio, así que dos análisis son comparables
mientras no cambien las fórmulas de esfuerzo. Si cambian, cambia la versión del analizador
correspondiente y el historial lo refleja.

**Limitaciones.** El ratio depende del tamaño del proyecto: el mismo problema pesa más en un
proyecto pequeño. Las estimaciones de esfuerzo son orientativas (ver abajo) y sirven para
priorizar, no para planificar con precisión.

## Severidad

| Severidad | Significado |
|---|---|
| `critical` | Riesgo inmediato (p. ej. una credencial real expuesta) o métrica ≥ 4× el umbral |
| `high` | Dificulta claramente el mantenimiento o la seguridad; métrica ≥ 2× el umbral |
| `medium` | Supera el umbral |
| `low` | Mejora recomendable |
| `info` | Contexto; no suma deuda |

En código de pruebas, los hallazgos de complejidad, tamaño y duplicación bajan un nivel
(sin ocultarse): las pruebas toleran más longitud y repetición.

## Confianza

| Confianza | Significado |
|---|---|
| `high` | Medición exacta de una herramienta (métrica del AST, clon verificado token a token, formato de secreto conocido) |
| `medium` | Heurística fiable pero indirecta (proporción de pruebas, acoplamiento, entropía alta) |
| `low` | Probable falso positivo; requiere revisión (p. ej. secretos en ejemplos o documentación) |

## Estimaciones de esfuerzo

Cada hallazgo incluye la fórmula en `effort.rationale`, para que sea auditable.

| Regla | Fórmula | Máximo |
|---|---|---|
| `complexity/function` | 15 min + 4 min × (cognitiva − umbral) + 0,5 min × (líneas − umbral) + 10 min × (anidamiento − umbral) + 10 min si hay exceso de parámetros | 8 h |
| `size/large-file` | 30 min + 0,2 min × (líneas − umbral) | 16 h |
| `duplication/clone` | 20 min + 0,5 min × líneas × (copias − 1) | 8 h |
| `architecture/cycle` | 30 min × módulos del ciclo | 16 h |
| `architecture/high-fan-out` | 30 min + 5 min × (dependencias − umbral) | 8 h |
| `security/secret/*` | 30 min (rotar, mover a entorno, limpiar historial) | — |
| `maintainability/markers` | 30 min por FIXME/HACK/XXX + 10 min por TODO | — |
| `dependencies/*` | 5–20 min por dependencia según la regla | — |
| `testing/no-tests` | 20 min por archivo de código | 40 h |
| `testing/low-ratio` | 30 min por archivo de prueba que falta hasta 0,20 | 20 h |

## Umbrales por defecto

| Umbral | Valor | Referencia |
|---|---|---|
| Complejidad cognitiva por función | 15 | Valor por defecto de SonarQube |
| Complejidad ciclomática por función | 10 | McCabe (1976) |
| Líneas propias por función | 60 | |
| Parámetros | 5 | |
| Anidamiento | 4 | |
| Líneas por archivo | 500 | |
| Duplicación mínima | 60 tokens y 6 líneas | |
| Dependencias internas por módulo | 20 | |

Todos son configurables (`resolveConfig({ thresholds })`) y forman parte de la huella de la
caché: cambiarlos invalida los resultados guardados.

## Métricas de complejidad

- **Cognitiva** (SonarSource, G. Ann Campbell, 2017): +1 por cada ruptura del flujo lineal
  (`if`, bucles, `catch`, ternario, `switch`, secuencias de operadores lógicos, saltos con
  etiqueta) y +1 adicional por cada nivel de anidamiento. `else if` y `else` suman 1 sin
  anidamiento; un `switch` suma 1 aunque tenga muchos casos. Es la métrica que dispara el
  hallazgo porque refleja la dificultad de **entender** el código.
- **Ciclomática** (McCabe): 1 + puntos de decisión. Aproxima el número de casos de prueba
  necesarios; se aporta como evidencia de apoyo.
- Las funciones anidadas se miden por separado y no suman a la función que las contiene.

## Duplicación

Clones de tipo 1 (idénticos salvo espacios y comentarios). Huellas por *winnowing*
(Schleimer, Wilkerson y Aiken, 2003) con k = 25 tokens y ventana 20: se detecta toda
coincidencia de al menos 44 tokens. Cada candidato se verifica comparando los tokens reales,
por lo que no hay falsos positivos por colisión de hash.
