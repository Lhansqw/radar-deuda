# Instalador para Windows (fase 12)

## Generarlo

```powershell
npm ci
npm run dist             # instalador en apps\desktop\release\
npm run dist -- --carpeta     # solo la aplicación empaquetada (release\win-unpacked), más rápido
npm run dist -- --sin-prueba  # sin la comprobación del paquete
```

El resultado es `radar-deuda-<versión>-instalador-windows-x64.exe`. La integración continua
lo genera en cada push a `main` y lo publica como artefacto (`instalador-windows`) en la
ejecución de GitHub Actions.

En Linux, `npm run dist` genera solo la carpeta (`release/linux-unpacked`), para comprobar el
paquete. Necesita una pantalla: `xvfb-run -a npm run dist`.

## Qué instala

| | |
|---|---|
| Para quién | Solo el usuario actual; no pide permisos de administrador |
| Dónde | `%LOCALAPPDATA%\Programs\radar-deuda` (se puede cambiar durante la instalación) |
| Accesos directos | Menú Inicio y escritorio |
| Idioma del instalador | Español |
| Datos | Proyectos, historial y credenciales en `%APPDATA%\radar-deuda`; caché y clones en `%LOCALAPPDATA%\radar-deuda`. Desinstalar **no** los borra |
| Licencias | `THIRD_PARTY_LICENSES.txt` (lo empaquetado desde npm), `LICENSE.electron.txt` y `LICENSES.chromium.html`, junto al ejecutable |
| Actualizaciones | No hay actualizaciones automáticas: la versión nueva se instala encima de la anterior y conserva los datos |

Requisitos: Windows 10 o 11 de 64 bits y Git en el `PATH` (para el historial y los
repositorios de GitHub; sin Git, el análisis de carpetas funciona igual).

## Cómo está hecho

La aplicación ya viene empaquetada por esbuild (procesos de Node) y Vite (interfaz) en
`apps/desktop/dist`, sin `node_modules` en tiempo de ejecución. electron-builder solo:

1. mete `dist/` y `package.json` en un `app.asar` de unos 4,4 MB (sin los mapas de código);
2. escribe los *fuses* en el binario de Electron;
3. guarda en el ejecutable el hash del `app.asar` (integridad);
4. genera el instalador NSIS y, si hay certificado, firma el ejecutable y el instalador.

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
6. En Windows, una copia con un byte del código cambiado dentro de `app.asar` no arranca.

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

## Pendiente

- **Actualizaciones automáticas.** No hay: añadirlas exige publicar las versiones
  firmadas en un servidor y comprobar su firma antes de instalarlas (electron-updater).
  Hasta entonces, cada versión se instala a mano.
- **Licencia del propio proyecto.** El repositorio no declara ninguna; el instalador no
  muestra una página de licencia. Si se publica, conviene añadirla (`nsis.license`).
- **Electron 45.** Ya existe; la rama 44 sigue con soporte y es la que está probada.
