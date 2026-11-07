#!/usr/bin/env bash
# Diagnóstico temporal (solo CI de macOS, cuando la prueba de arranque falla):
# repite el arranque de una copia del paquete cambiando los fuses de uno en uno
# y saca la traza de la caída con lldb. No modifica el paquete original.
set -u
APP="${1:-apps/desktop/release/mac-arm64/radar-deuda.app}"
WORK="$(mktemp -d)"

# Ejecuta la copia con un límite de tiempo y muestra cómo termina.
arrancar() {
  local etiqueta="$1" app="$2" datos
  shift 2
  datos="$(mktemp -d)"
  RADAR_DATA_DIR="$datos" perl -e 'alarm 90; exec @ARGV' "$app/Contents/MacOS/radar-deuda" "${@:---prueba-arranque}" >"$WORK/salida.txt" 2>&1
  local codigo=$?
  echo "-- $etiqueta: código de salida $codigo (128+n = señal n; 142 = tiempo agotado) | $(grep -c 'Prueba de arranque superada' "$WORK/salida.txt") confirmación(es)"
  tail -n 3 "$WORK/salida.txt"
}

variante() {
  local etiqueta="$1"; shift
  local copia="$WORK/copia.app"
  rm -rf "$copia"; cp -R "$APP" "$copia"
  if [ "$#" -gt 0 ]; then
    npx --no-install @electron/fuses write --app "$copia" "$@" >/dev/null 2>&1 || echo "   (no se pudieron escribir los fuses: $*)"
  fi
  codesign --force --deep --sign - "$copia" >/dev/null 2>&1 || echo "   (no se pudo volver a firmar)"
  arrancar "$etiqueta" "$copia"
}

echo "== Fuses del paquete original"
npx --no-install @electron/fuses read --app "$APP" 2>&1 | head -20
echo "== Variantes (cada una en una copia, firmada de nuevo ad-hoc)"
variante "A. sin cambios"
variante "B. EnableCookieEncryption=off" EnableCookieEncryption=off
variante "C. EnableEmbeddedAsarIntegrityValidation=off" EnableEmbeddedAsarIntegrityValidation=off
variante "D. GrantFileProtocolExtraPrivileges=on" GrantFileProtocolExtraPrivileges=on
variante "E. los tres cambiados a la vez" EnableCookieEncryption=off EnableEmbeddedAsarIntegrityValidation=off GrantFileProtocolExtraPrivileges=on

echo "== Separar empaquetado y código (sobre una copia del paquete original)"
copia="$WORK/original.app"; rm -rf "$copia"; cp -R "$APP" "$copia"
arrancar "G. --version (¿llega a arrancar el ejecutable?)" "$copia" --version
arrancar "H. --no-sandbox --prueba-arranque" "$copia" --no-sandbox --prueba-arranque
arrancar "I. --disable-gpu --prueba-arranque" "$copia" --disable-gpu --prueba-arranque
echo "-- U. Electron sin empaquetar con el mismo código (apps/desktop, --prueba-arranque)"
RADAR_DATA_DIR="$(mktemp -d)" perl -e 'alarm 90; exec @ARGV' node_modules/electron/dist/Electron.app/Contents/MacOS/Electron apps/desktop --prueba-arranque 2>&1 | tail -n 4
echo "   código de salida: ${PIPESTATUS[0]}"

echo "== Composición del paquete"
ls -1 "$APP/Contents" "$APP/Contents/Frameworks" "$APP/Contents/MacOS" "$APP/Contents/Resources" | head -50
for k in CFBundleName CFBundleDisplayName CFBundleExecutable CFBundleIdentifier LSMinimumSystemVersion NSPrincipalClass; do
  echo "   $k = $(/usr/libexec/PlistBuddy -c "Print :$k" "$APP/Contents/Info.plist" 2>&1)"
done
echo "   (Electron sin empaquetar) CFBundleName = $(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' node_modules/electron/dist/Electron.app/Contents/Info.plist 2>&1), CFBundleExecutable = $(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' node_modules/electron/dist/Electron.app/Contents/Info.plist 2>&1)"

echo "== Variantes del paquete con --version (¿qué lo hace caer?)"
version() {
  local etiqueta="$1" app="$2"
  RADAR_DATA_DIR="$(mktemp -d)" perl -e 'alarm 30; exec @ARGV' "$app/Contents/MacOS/$3" --version >"$WORK/v.txt" 2>&1
  echo "-- $etiqueta: código $? | $(head -c 80 "$WORK/v.txt" | tr '\n' ' ')"
}
control="$WORK/electron-control.app"; rm -rf "$control"; cp -R node_modules/electron/dist/Electron.app "$control"
version "control: Electron.app sin empaquetar" "$control" Electron
v="$WORK/v-sin-licencias.app"; rm -rf "$v"; cp -R "$APP" "$v"; rm -f "$v/Contents/THIRD_PARTY_LICENSES.txt"; codesign --force --deep --sign - "$v" >/dev/null 2>&1
version "1. paquete sin THIRD_PARTY_LICENSES.txt" "$v" radar-deuda
v="$WORK/v-sin-asar.app"; rm -rf "$v"; cp -R "$APP" "$v"; rm -f "$v/Contents/Resources/app.asar"; codesign --force --deep --sign - "$v" >/dev/null 2>&1
version "2. paquete sin app.asar" "$v" radar-deuda
v="$WORK/v-plist-electron.app"; rm -rf "$v"; cp -R "$APP" "$v"; cp node_modules/electron/dist/Electron.app/Contents/Info.plist "$v/Contents/Info.plist"; mv "$v/Contents/MacOS/radar-deuda" "$v/Contents/MacOS/Electron"; codesign --force --deep --sign - "$v" >/dev/null 2>&1
version "3. paquete con el Info.plist de Electron" "$v" Electron
echo "-- registro del sistema sobre la caída:"
log show --last 3m --style compact --predicate 'process == "radar-deuda" OR eventMessage CONTAINS "radar-deuda"' 2>/dev/null | grep -v 'linkd\|intents' | tail -n 25 | cut -c1-260

echo "== Aplicaciones mínimas dentro del mismo paquete (¿cae el paquete o el código?)"
# Copia con los nombres internos en ASCII (sin la tilde de «Técnica»): ayudantes y CFBundleName.
ascii_rename() {
  local app="$1" h base suf nuevo
  for h in "$app"/Contents/Frameworks/*Helper*.app; do
    base="$(basename "$h" .app)"
    suf="${base#*Helper}"
    nuevo="Radar Helper$suf"
    mv "$h/Contents/MacOS/$base" "$h/Contents/MacOS/$nuevo"
    /usr/libexec/PlistBuddy -c "Set :CFBundleExecutable $nuevo" -c "Set :CFBundleName $nuevo" -c "Set :CFBundleDisplayName $nuevo" "$h/Contents/Info.plist" >/dev/null 2>&1
    mv "$h" "$(dirname "$h")/$nuevo.app"
  done
  /usr/libexec/PlistBuddy -c "Set :CFBundleName Radar" -c "Set :CFBundleDisplayName Radar" "$app/Contents/Info.plist" >/dev/null 2>&1
}

mini() {
  local nombre="$1" main="$2" hijo="${3:-}"
  local dir="$WORK/mini-$nombre" copia="$WORK/mini-$nombre.app"
  rm -rf "$dir" "$copia"; mkdir -p "$dir"
  printf '{"name":"mini","version":"1.0.0","main":"main.js"}' >"$dir/package.json"
  printf '%s\n' "$main" >"$dir/main.js"
  [ -n "$hijo" ] && printf '%s\n' "$hijo" >"$dir/hijo.js"
  npx --no-install asar pack "$dir" "$WORK/mini-$nombre.asar" >/dev/null 2>&1
  cp -R "$APP" "$copia"; cp "$WORK/mini-$nombre.asar" "$copia/Contents/Resources/app.asar"
  [ -n "${ASCII:-}" ] && ascii_rename "$copia"
  npx --no-install @electron/fuses write --app "$copia" EnableEmbeddedAsarIntegrityValidation=off >/dev/null 2>&1
  codesign --force --deep --sign - "$copia" >/dev/null 2>&1
  RADAR_DATA_DIR="$(mktemp -d)" perl -e 'alarm 45; exec @ARGV' "$copia/Contents/MacOS/radar-deuda" >"$WORK/m.txt" 2>&1
  echo "-- mínima '$nombre': código $? | $(grep -v 'linkd\|intents\|Process Instance\|Will NOT' "$WORK/m.txt" | tail -n 3 | tr '\n' ' ' | cut -c1-200)"
}
mini hola "console.log('MINI-HOLA'); require('electron').app.quit();"
mini sqlite "const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync(':memory:'); d.exec('create table t(a)'); console.log('MINI-SQLITE-OK'); require('electron').app.quit();"
mini ventana "const {app,BrowserWindow}=require('electron'); app.whenReady().then(async()=>{const w=new BrowserWindow({show:false}); await w.loadURL('data:text/html,<p>hola</p>'); console.log('MINI-VENTANA-OK'); app.quit();}); setTimeout(()=>{console.log('MINI-TIEMPO'); app.exit(3);},30000);"
mini hijo "const {app,utilityProcess}=require('electron'); const path=require('path'); app.whenReady().then(()=>{const p=utilityProcess.fork(path.join(__dirname,'hijo.js')); p.on('message',m=>{console.log('MINI-HIJO-OK',m); app.quit();}); p.on('exit',c=>{console.log('MINI-HIJO-SALIO',c); app.quit();});}); setTimeout(()=>{console.log('MINI-TIEMPO'); app.exit(3);},30000);" "process.parentPort.postMessage('ok');"

echo "== Mismas pruebas con los nombres internos en ASCII (sin tilde)"
export ASCII=1
mini ascii-hola "console.log('MINI-HOLA'); require('electron').app.quit();"
mini ascii-ventana "const {app,BrowserWindow}=require('electron'); app.whenReady().then(async()=>{const w=new BrowserWindow({show:false}); await w.loadURL('data:text/html,<p>hola</p>'); console.log('MINI-VENTANA-OK'); app.quit();}); setTimeout(()=>{console.log('MINI-TIEMPO'); app.exit(3);},30000);"
unset ASCII
real="$WORK/real-ascii.app"; rm -rf "$real"; cp -R "$APP" "$real"; ascii_rename "$real"; codesign --force --deep --sign - "$real" >/dev/null 2>&1
arrancar "R. la aplicación real con nombres ASCII (--prueba-arranque)" "$real"

echo "== Traza de la caída (lldb, paquete original)"
RADAR_DATA_DIR="$(mktemp -d)" perl -e 'alarm 120; exec @ARGV' lldb --batch -o run -k 'bt 30' -k 'register read pc lr' -k 'image lookup -a $pc' -- "$APP/Contents/MacOS/radar-deuda" --prueba-arranque 2>&1 | tail -n 60
