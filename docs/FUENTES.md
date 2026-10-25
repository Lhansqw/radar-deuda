# Fase 6 — Git, GitHub y dependencias en línea

El paquete `@radar/sources` agrupa todo lo que tiene efectos externos: lanzar Git y
consultar servicios de red. El motor (`@radar/engine`) sigue sin red y sin procesos
externos; la CLI une ambos.

## Uso

```powershell
# Repositorio local (si es un repositorio Git, añade commit y puntos críticos)
npm run analyze -- C:\dev\mi-proyecto

# Repositorio de GitHub: se clona en %LOCALAPPDATA%\radar-deuda\repos
npm run analyze -- Lhansqw/radar-deuda
npm run analyze -- https://github.com/owner/repo --branch develop

# Vulnerabilidades conocidas y versiones desactualizadas (requiere red)
npm run analyze -- C:\dev\mi-proyecto --online

# Puntos críticos con otro periodo
npm run analyze -- C:\dev\mi-proyecto --since 2025-01-01

# Comparar con un análisis anterior y fallar solo si se añade deuda (CI)
npm run analyze -- . --json antes.json
npm run analyze -- . --baseline antes.json --fail-on-new medium
```

## Token de GitHub (solo para repositorios privados)

Los repositorios públicos no necesitan token. Para los privados, crea un token
**fine-grained** de solo lectura:

1. Abre https://github.com/settings/personal-access-tokens/new
2. *Expiration*: la más corta que te resulte práctica (p. ej. 30 días).
3. *Repository access*: **Only select repositories** y elige los que quieras analizar.
4. *Permissions → Repository permissions*: **Contents: Read-only**. *Metadata: Read-only*
   se añade automáticamente. No concedas ningún otro permiso.
5. Copia el token (empieza por `github_pat_`).

Defínelo solo para la sesión actual de PowerShell, sin que quede en el historial de
comandos (PSReadLine guarda en texto plano lo que escribes):

```powershell
$s = Read-Host "Token de GitHub" -AsSecureString
$env:RADAR_GITHUB_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
Remove-Variable s
npm run analyze -- owner/repo-privado
```

La aplicación **solo** lee `RADAR_GITHUB_TOKEN`; nunca usa `GITHUB_TOKEN` ni `GH_TOKEN`,
que suelen ser de otras herramientas y tener más permisos. Si el token tiene permisos de
escritura o administración, la CLI lo avisa. En la aplicación de escritorio (fase 8) el
token se guardará cifrado con `safeStorage` (DPAPI de Windows).

## Qué datos salen del equipo

| Servicio | Cuándo | Qué se envía |
|---|---|---|
| `api.github.com` | Al analizar un repositorio de GitHub | `owner/repo` y, si lo hay, el token |
| `github.com` (git) | Al clonar o actualizar | La petición de clonado y, si lo hay, el token |
| `api.osv.dev` | Con `--online` | Nombre y versión de cada paquete del lockfile |
| `registry.npmjs.org` | Con `--online` | Nombre de cada dependencia directa |

**Nunca** se envía código fuente, rutas de archivos ni hallazgos. Las respuestas se
guardan en caché (`%LOCALAPPDATA%\radar-deuda\cache\osv` y `\npm`) para no repetir
consultas: OSV por identificador y fecha de modificación, npm durante 24 h.

## Seguridad al ejecutar Git

Ejecutar Git dentro de un repositorio ajeno no es inocuo: su `.git/config` puede hacer que
Git lance programas. Todas las invocaciones pasan por `runGit`, que:

- anula con `-c` (tiene prioridad sobre cualquier archivo de configuración) los vectores
  conocidos: `core.fsmonitor`, `core.hooksPath`, `core.pager`, `core.editor`,
  `core.sshCommand`, `diff.external`, filtros de LFS y ayudantes de credenciales;
- solo permite el protocolo `https`;
- no usa shell, elimina las variables `GIT_*` heredadas y desactiva los prompts;
- aplica tiempo límite, límite de salida y cancelación;
- redacta tokens y credenciales en los mensajes de error.

Una prueba automatizada demuestra el riesgo: un `core.fsmonitor` malicioso **se ejecuta**
con `git status` normal y **no** con `runGit`.

Además, el historial se lee solo con comandos sobre objetos (`log`, `diff-tree`,
`rev-parse`), que no tocan el árbol de trabajo, y las referencias que escribe el usuario se
validan para impedir inyección de opciones (`--output=…`).

Los clones: superficiales (solo el periodo analizado), de una rama, sin etiquetas, sin
submódulos, sin enlaces simbólicos, sin hooks y sin objetos de LFS. Se hacen en una carpeta
temporal y se mueven al terminar. El token viaja como cabecera HTTP en variables de entorno
(`GIT_CONFIG_COUNT`): no aparece en la línea de comandos ni se escribe en `.git/config`.

## Puntos críticos

Siguiendo a Adam Tornhill (*Your Code as a Crime Scene*), un punto crítico es un archivo
que **cambia a menudo y acumula deuda**: ahí es donde la deuda cuesta más y donde
refactorizar rinde más.

```
puntuación = 100 × (commits / máx. commits) × (deuda / máx. deuda)
```

Solo se consideran archivos con al menos 2 commits en el periodo y deuda pendiente. Se
excluyen por defecto los archivos de pruebas y los de puntuación inferior a 5. Los autores
se cuentan con un hash de su correo que nunca sale de la función.

## Vulnerabilidades y versiones

- **Vulnerabilidades** (OSV, que agrega GitHub Advisory Database y otras): se consultan
  las versiones **exactas** de `package-lock.json` (v1, v2 y v3), incluidas las
  transitivas. La severidad es la de la base de datos o, si falta, la CVSS v3 calculada con
  las ecuaciones de FIRST; el origen queda en la evidencia. Se recomienda la versión mínima
  que corrige todas las vulnerabilidades conocidas del paquete. Las dependencias solo de
  desarrollo bajan un nivel de severidad.
- **Versiones** (registro de npm): dependencias directas con versiones mayores de retraso
  (en `0.x`, cada versión menor cuenta como mayor) y versiones marcadas como en desuso.

## Limitaciones conocidas

- `yarn.lock`, `pnpm-lock.yaml` y `bun.lock` todavía no se leen: el informe lo declara
  como cobertura parcial.
- Sin lockfile no hay versiones exactas y no se consultan vulnerabilidades.
- Sin conexión, `--online` registra el error en el informe y el resto del análisis
  continúa.
- Los puntos críticos de un repositorio clonado solo cubren el periodo descargado.
