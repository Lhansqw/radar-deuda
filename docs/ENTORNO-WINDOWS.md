# Fase 3 — Preparar el entorno en Windows

Todos los comandos se ejecutan en **PowerShell** (Windows 10/11).

## 1. Herramientas necesarias

| Herramienta | Para qué | Enlace oficial | Obligatoria |
|---|---|---|---|
| Node.js 24 LTS | Ejecutar y compilar todo el proyecto | https://nodejs.org/en/download | Sí |
| Git para Windows | Control de versiones | https://git-scm.com/downloads/win | Sí |
| fnm (Fast Node Manager) | Fijar la versión de Node del proyecto (`.nvmrc`) | https://github.com/Schniz/fnm | Recomendada |
| Visual Studio Code | Editor | https://code.visualstudio.com/ | Recomendada |
| GitHub CLI | Crear el repositorio remoto y autenticarse | https://cli.github.com/ | Recomendada |
| LM Studio u Ollama | Modelos de IA locales (fase 7) | https://lmstudio.ai/ · https://ollama.com/download | Opcional |

No hace falta Rust, Python ni Visual Studio Build Tools para las fases 1–7.

## 2. Instalación con winget

`winget` viene incluido en Windows 10/11 actualizados.

```powershell
winget install --id Git.Git -e
winget install --id Schniz.fnm -e
winget install --id Microsoft.VisualStudioCode -e
winget install --id GitHub.cli -e
```

Cierra y vuelve a abrir PowerShell para que se actualice el `PATH`.

### Node.js 24 con fnm

```powershell
# Activar fnm en cada sesión de PowerShell (una sola vez)
if (!(Test-Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force | Out-Null }
Add-Content $PROFILE 'fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression'
. $PROFILE

fnm install 24
fnm default 24
node -v   # debe mostrar v24.x
npm -v
```

Alternativa sin fnm: descarga el instalador **v24 (LTS)** desde https://nodejs.org/en/download.

### Si PowerShell bloquea `npm`

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

## 3. Configuración de Git (una sola vez)

```powershell
git config --global user.name  "Tu Nombre"
git config --global user.email "tu-correo@ejemplo.com"
git config --global core.autocrlf false   # el repositorio normaliza finales de línea con .gitattributes
git config --global core.longpaths true   # rutas largas de node_modules
git config --global init.defaultBranch main
```

## 4. Obtener el proyecto e instalar dependencias

```powershell
cd $HOME\Documents
git clone <url-o-ruta-del-repositorio> radar-deuda
cd radar-deuda
npm ci
npm run check
```

`npm run check` ejecuta comprobación de tipos, lint y pruebas. Si termina sin errores, el
entorno está listo.

## 5. Publicar en GitHub (opcional)

```powershell
gh auth login                      # GitHub.com → HTTPS → navegador
gh repo create radar-deuda --private --source . --push
```

## 6. Credenciales que necesitarás más adelante

| Fase | Credencial | Permisos mínimos |
|---|---|---|
| 6 | Token *fine-grained* de GitHub (https://github.com/settings/personal-access-tokens) | Solo los repositorios elegidos · *Contents: Read-only* · *Metadata: Read-only* |
| 7 | Clave de API de un proveedor en la nube (opcional) | Una clave dedicada a esta aplicación, con límite de gasto |

Nunca pegues credenciales en archivos del repositorio: la aplicación las guardará cifradas
con `safeStorage` (DPAPI de Windows).

## 7. Extensiones recomendadas de VS Code

- ESLint (`dbaeumer.vscode-eslint`)
- Vitest (`vitest.explorer`)
