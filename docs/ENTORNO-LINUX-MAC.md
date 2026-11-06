# Fase 15 — Desarrollar en Linux y macOS

El proyecto es el mismo en los tres sistemas: no hay módulos nativos (SQLite viene con
Node) ni pasos de compilación propios de un sistema. Lo que cambia son las herramientas
para instalarlo y cómo se empaqueta ([INSTALADOR.md](INSTALADOR.md)). La guía de Windows
está en [ENTORNO-WINDOWS.md](ENTORNO-WINDOWS.md).

## 1. Herramientas

| Herramienta | Para qué | Obligatoria |
|---|---|---|
| Node.js 24 (mínimo 22.13) | Ejecutar y compilar todo el proyecto (`.nvmrc`) | Sí |
| Git | Control de versiones; el análisis lo usa para el historial y los clones de GitHub | Sí |
| fnm o nvm | Fijar la versión de Node del proyecto | Recomendada |
| GitHub CLI | Autenticarse y abrir pull requests | Recomendada |

### macOS

```sh
xcode-select --install          # Git y las herramientas de línea de comandos de Apple
brew install fnm gh             # https://brew.sh
fnm install 24 && fnm default 24
```

### Ubuntu / Debian

```sh
sudo apt install git curl libsecret-1-0 xvfb   # xvfb: pantalla virtual para las pruebas de la aplicación
curl -fsSL https://fnm.vercel.app/install | bash
fnm install 24 && fnm default 24
```

En otras distribuciones, los paquetes equivalentes (`libsecret`, `xorg-x11-server-Xvfb`…).

## 2. Clonar y comprobar

```sh
git clone https://github.com/Lhansqw/radar-deuda.git
cd radar-deuda
npm ci
npm run check          # tipos, lint y pruebas
npm run desktop        # compila y abre la aplicación
```

## 3. Particularidades

| | Linux | macOS |
|---|---|---|
| Prueba de extremo a extremo | `xvfb-run -a npm run e2e:desktop` si no hay pantalla; nunca como `root` | `npm run e2e:desktop` |
| Instaladores | `xvfb-run -a npm run dist` → AppImage y .deb | `npm run dist` → dos .dmg (arm64 y x64), firma ad-hoc |
| Sandbox de Chromium | Ubuntu 24.04 restringe los espacios de nombres de usuario: para ejecutar Electron desde `node_modules`, `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` (como en la integración continua) | Sin cambios |
| Credenciales | Necesitan un llavero desbloqueado (GNOME Keyring, KWallet); sin él solo funcionan las variables de entorno | Llavero de macOS |
| Datos de la aplicación | `~/.config/radar-deuda` | `~/Library/Application Support/radar-deuda` |
| Caché y clones | `~/.cache/radar-deuda` | `~/Library/Caches/radar-deuda` |

Los scripts del proyecto (`npm run …`) funcionan igual en los tres sistemas. Los ejemplos de
la documentación en PowerShell (`$env:VAR = "…"`) se escriben en sh como `export VAR="…"`.
