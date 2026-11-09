# Instaladores para Windows, Linux y macOS (fase 12)

## Generarlos

```powershell
npm ci
$env:RADAR_SUPABASE_URL = "https://<proyecto>.supabase.co"      # conexión para las cuentas
$env:RADAR_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_..."      # (docs/CUENTAS.md)
npm run dist             # instaladores del sistema actual en apps\desktop\release\
npm run dist -- --carpeta     # solo la aplicación empaquetada (release\win-unpacked…), más rápido
npm run dist -- --sin-prueba  # sin la comprobación del paquete
```

Las dos variables de Supabase se incrustan en la aplicación (no son secretas; la clave
secreta detiene la compilación). Sin ellas, la aplicación instalada no deja iniciar sesión.
También se pueden poner en `apps/desktop/nube.json`.

Cada sistema genera solo sus propios instaladores:

| Sistema | Archivos en `apps/desktop/release` | Artefacto de CI |
|---|---|---|
| Windows | `radar-deuda-<versión>-instalador-windows-x64.exe` (NSIS) | `instalador-windows` |
| Linux | `radar-deuda-<versión>-linux-x86_64.AppImage` y `radar-deuda-<versión>-linux-amd64.deb` | `instalador-linux` |
| macOS | `radar-deuda-<versión>-macos-arm64.dmg` (Apple Silicon) y `radar-deuda-<versión>-macos-x64.dmg` (Intel) | `instalador-macos` |

La integración continua los genera en cada push a `main` y los publica como artefactos de
la ejecución de GitHub Actions.

En Linux, la comprobación del paquete necesita una pantalla: `xvfb-run -a npm run dist`. En
macOS se comprueba la aplicación de la arquitectura del equipo (la otra se empaqueta, pero
no se arranca).

## Qué instala (Windows)

| | |
|---|---|
| Para quién | Solo el usuario actual; no pide permisos de administrador |
| Dónde | `%LOCALAPPDATA%\Programs\radar-deuda` (se puede cambiar durante la instalación) |
| Accesos directos | Menú Inicio y escritorio |
| Idioma del instalador | Español |
| Datos | Proyectos, historial y credenciales de cada cuenta en `%APPDATA%\radar-deuda\usuarios`, y la sesión cifrada en `%APPDATA%\radar-deuda\sesion.bin`; caché y clones en `%LOCALAPPDATA%\radar-deuda`. Desinstalar **no** los borra |
| Licencias | El instalador muestra la del proyecto (MIT) antes de instalar. Junto al ejecutable: `LICENSE.txt` (la del proyecto), `THIRD_PARTY_LICENSES.txt` (lo empaquetado desde npm), `LICENSE.electron.txt` y `LICENSES.chromium.html` |
| Actualizaciones | La aplicación avisa al abrir si hay una versión nueva en GitHub Releases (se puede desactivar en Configuración → Aplicación). No descarga nada: la versión nueva se instala encima de la anterior y conserva los datos |

Requisitos: Windows 10 o 11 de 64 bits y Git en el `PATH` (para el historial y los
repositorios de GitHub; sin Git, el análisis de carpetas funciona igual).

## Qué instala (Linux)

| | |
|---|---|
| AppImage | Un solo archivo, sin instalar: `chmod +x radar-deuda-*.AppImage` y ejecutarlo. Necesita FUSE 2 (`sudo apt install libfuse2t64` en Ubuntu 24.04) |
| .deb | `sudo apt install ./radar-deuda-*.deb`. Queda en `/opt/Radar de Deuda Técnica`, con `radar-deuda` en el `PATH` y acceso en el menú. Instala Git y libsecret como dependencias, configura el sandbox de Chromium y, en Ubuntu 24.04 o posterior, su perfil de AppArmor |
| Datos | Cuentas y sesión en `~/.config/radar-deuda`; caché y clones en `~/.cache/radar-deuda` (o `$XDG_CACHE_HOME`) |
| Credenciales | Cifradas con el llavero del escritorio (GNOME Keyring, KWallet). Sin llavero, Chromium cifraría con una clave fija conocida por cualquiera: la aplicación no lo acepta, no guarda credenciales ni la sesión, y solo funcionan las variables de entorno |

**AppImage en Ubuntu 23.10 o posterior.** Ubuntu restringe los espacios de nombres de
usuario que usa el sandbox de Chromium, y una AppImage no puede instalar un perfil de
AppArmor. Si no arranca por el sandbox, usa el .deb. La aplicación no se lanza con
`--no-sandbox`: el sandbox es parte de su modelo de seguridad ([SEGURIDAD.md](SEGURIDAD.md)).

No se puede ejecutar como `root` (Chromium no lo admite con el sandbox).

## Qué instala (macOS)

| | |
|---|---|
| Instalar | Abrir el .dmg y arrastrar la aplicación a Aplicaciones |
| Primera apertura | Sin firma de Apple, macOS la bloquea: clic derecho → **Abrir** → **Abrir** (en macOS 15: Ajustes del Sistema → Privacidad y seguridad → «Abrir igualmente»). También: `xattr -dr com.apple.quarantine "/Applications/Radar de Deuda Técnica.app"` |
| Datos | Cuentas y sesión en `~/Library/Application Support/radar-deuda`; caché y clones en `~/Library/Caches/radar-deuda` |
| Credenciales | Cifradas con el Llavero de macOS (la primera vez puede pedir permiso para usarlo) |
| Git | Viene con las Command Line Tools de Xcode (`xcode-select --install`) |

Requisitos: macOS 12 o posterior (los de Electron 44).

## Cómo está hecho

La aplicación ya viene empaquetada por esbuild (procesos de Node) y Vite (interfaz) en
`apps/desktop/dist`, sin `node_modules` en tiempo de ejecución. electron-builder solo:

1. mete `dist/` y `package.json` en un `app.asar` de unos 4,4 MB (sin los mapas de código);
2. escribe los *fuses* en el binario de Electron;
3. guarda en el ejecutable el hash del `app.asar` (integridad);
4. genera los instaladores (NSIS, AppImage y .deb, o .dmg) y, si hay certificado, los firma.

La configuración está en [`apps/desktop/electron-builder.yml`](../apps/desktop/electron-builder.yml)
y el script en [`apps/desktop/scripts/dist.ts`](../apps/desktop/scripts/dist.ts).

### Fuses

Los *fuses* son interruptores dentro del binario de Electron. No dependen de la
configuración ni del entorno, y cambiarlos invalida la firma.

| Fuse | Valor | Por qué |
|---|---|---|
| `RunAsNode` | Desactivado | Con `ELECTRON_RUN_AS_NODE=1` el ejecutable dejaría de ser la aplicación y ejecutaría cualquier script como Node, con la identidad (y la firma) de la aplicación |
| `EnableNodeOptionsEnvironmentVariable` | Desactivado | Sin `NODE_OPTIONS` ni `NODE_EXTRA_CA_CERTS`: con este último, quien pudiera cambiar el entorno haría que la aplicación confiara en un certificado suyo e interceptara sus conexiones, claves de IA incluidas |
| `EnableNodeCliInspectArguments` | Desactivado | `--inspect` o `SIGUSR1` abrirían un depurador con acceso total al proceso principal |
| `OnlyLoadAppFromAsar` | Activado | Solo se carga la aplicación desde `app.asar`, no desde una carpeta `app` puesta al lado |
| `EnableEmbeddedAsarIntegrityValidation` | Activado | Si alguien modifica `app.asar`, la aplicación no arranca (Windows y macOS) |
| `EnableCookieEncryption` | Activado | Cookies cifradas con el sistema (la aplicación no las usa) |
| `GrantFileProtocolExtraPrivileges` | Desactivado | La interfaz se sirve por `app://`; `file://` no necesita privilegios |
| `LoadBrowserProcessSpecificV8Snapshot` | Desactivado | No se usa |

### Comprobación del paquete

Al terminar, `npm run dist` comprueba el ejecutable empaquetado
([`scripts/verify-package.ts`](../apps/desktop/scripts/verify-package.ts)):

1. Los fuses del binario son los de la configuración.
2. **Prueba de arranque** (`radar-deuda --prueba-arranque`): la interfaz se pinta desde el
   ASAR, aislada (tiene `window.radar` pero no `require` ni `process`). El proceso de análisis
   arranca desde el ASAR y analiza una carpeta temporal. Usa una carpeta de datos temporal
   y nunca toca la del usuario.
3. Con `ELECTRON_RUN_AS_NODE=1` sigue arrancando como aplicación. Si se comportara como
   Node, `--prueba-arranque` sería una opción desconocida. Se comprobó en una copia con los
   fuses activados: esta comprobación y la de `--inspect` fallan, como deben.
4. `NODE_OPTIONS=--require …` no ejecuta el script indicado. Una aplicación empaquetada
   ya ignora casi todo `NODE_OPTIONS`; el fuse desactiva el resto, incluido
   `NODE_EXTRA_CA_CERTS`.
5. `--inspect` no abre el depurador.
6. En Windows y macOS, una copia con un byte del código cambiado dentro de `app.asar` no arranca.

Cada comprobación superada se muestra con ✓ (seis en Windows y macOS; cinco en Linux, que no
comprueba la integridad del ASAR) y la salida termina con «Paquete comprobado.». Si una
falla, `npm run dist` se detiene con su mensaje y las últimas líneas de la salida de la
aplicación.

La prueba de extremo a extremo (`npm run e2e:desktop`) usa la aplicación sin empaquetar:
los fuses impiden que Playwright controle la empaquetada, y por eso existe la prueba de
arranque.

## Firma

Sin firma, Windows SmartScreen muestra «Windows protegió su PC» la primera vez («Más
información» → «Ejecutar de todas formas»). Para un proyecto académico o de uso interno
basta así. Para distribuirlo, electron-builder firma solo si encuentra un certificado:

- **Certificado de firma de código (.pfx):** variables `WIN_CSC_LINK` (ruta o base64 del
  .pfx) y `WIN_CSC_KEY_PASSWORD`. En GitHub Actions, como secretos del repositorio,
  pasados como `env` al paso «Instalador».
- **Azure Trusted Signing:** sección `win.azureSignOptions` de
  `electron-builder.yml` y las credenciales de Azure en el entorno.

Firmar después de escribir los fuses es el orden correcto, y es el que sigue
electron-builder.

### macOS

Escribir los fuses invalida la firma de Electron, y Apple Silicon no abre aplicaciones sin
firma. Por eso, sin certificado, `npm run dist` firma *ad-hoc* (`resetAdHocDarwinSignature`
en los fuses e `identity: '-'` en `scripts/dist.ts`). Así arranca, pero Gatekeeper avisa la
primera vez (ver «Qué instala (macOS)»). Para distribuirla sin aviso hace falta una cuenta
de Apple Developer:

- **Firma:** `CSC_LINK` (ruta o base64 del .p12 «Developer ID Application») y
  `CSC_KEY_PASSWORD`, o `CSC_NAME` si el certificado ya está en el llavero. Con ellas se firma
  con *hardened runtime* y solo los permisos que necesita V8
  ([`build/entitlements.mac.plist`](../apps/desktop/build/entitlements.mac.plist)).
- **Notarización:** además, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` y `APPLE_TEAM_ID`.
  electron-builder envía la aplicación a Apple y grapa el resultado al .dmg.

### Linux

La AppImage y el .deb no se firman: su integridad depende del canal por el que se descarguen
(los artefactos de GitHub Actions).

## Publicar una versión

Los instaladores se publican en GitHub Releases con
[`.github/workflows/release.yml`](../.github/workflows/release.yml):

1. Sube la versión en `apps/desktop/package.json` (por ejemplo `0.2.0`) y haz commit.
2. Crea y sube la etiqueta con esa misma versión:
   ```powershell
   git tag v0.2.0
   git push origin v0.2.0
   ```
3. El workflow comprueba que la etiqueta coincide con la versión, crea la versión como
   **borrador** y sube el instalador de Windows, la AppImage y el .deb, y los dos .dmg.
4. Descarga los instaladores del borrador, pruébalos y pulsa **Publish release** en GitHub.
   Hasta entonces nadie la ve, tampoco el aviso de versiones nuevas de la aplicación.

El aviso ([`main/updates.ts`](../apps/desktop/src/main/updates.ts)) consulta
`api.github.com/repos/Lhansqw/radar-deuda/releases/latest`, compara la versión con la
instalada y solo enlaza a páginas de versiones de este repositorio. Ignora borradores y
versiones de prueba (`-beta`, `-rc`).

## Pendiente

- **Actualizaciones automáticas.** Sin instaladores firmados la aplicación solo avisa:
  descargar e instalar sola exige comprobar la firma de lo que descarga (electron-updater).
  Con certificado de firma, es el siguiente paso.
- **Electron 45.** Ya existe; la rama 44 sigue con soporte y es la que está probada.
