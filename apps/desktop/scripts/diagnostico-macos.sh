#!/usr/bin/env bash
# Diagnóstico temporal (solo CI de macOS, cuando la prueba de arranque falla). No modifica el paquete original.
set -u
APP="${1:-apps/desktop/release/mac-arm64/radar-deuda.app}"
WORK="$(mktemp -d)"
FILTRO='linkd|intents|Process Instance|Will NOT'

echo "== Nombres dentro del paquete"
ls -1 "$APP/Contents/Frameworks" | head -12
for k in CFBundleName CFBundleDisplayName CFBundleExecutable; do echo "   $k = $(/usr/libexec/PlistBuddy -c "Print :$k" "$APP/Contents/Info.plist" 2>&1)"; done

# Aplicación mínima dentro del mismo paquete (integridad del ASAR desactivada en la copia).
mini() {
  local nombre="$1" main="$2" hijo="${3:-}"
  local dir="$WORK/mini-$nombre" copia="$WORK/mini-$nombre.app"
  rm -rf "$dir" "$copia"; mkdir -p "$dir"
  printf '{"name":"mini","version":"1.0.0","main":"main.js"}' >"$dir/package.json"
  printf '%s\n' "$main" >"$dir/main.js"
  [ -n "$hijo" ] && printf '%s\n' "$hijo" >"$dir/hijo.js"
  npx --no-install asar pack "$dir" "$WORK/mini-$nombre.asar" >/dev/null 2>&1
  cp -R "$APP" "$copia"; cp "$WORK/mini-$nombre.asar" "$copia/Contents/Resources/app.asar"
  npx --no-install @electron/fuses write --app "$copia" EnableEmbeddedAsarIntegrityValidation=off >/dev/null 2>&1
  codesign --force --deep --sign - "$copia" >/dev/null 2>&1
  RADAR_DATA_DIR="$(mktemp -d)" perl -e 'alarm 40; exec @ARGV' "$copia/Contents/MacOS/radar-deuda" >"$WORK/m.txt" 2>&1
  echo "-- mínima '$nombre': código $? | $(grep -Ev "$FILTRO" "$WORK/m.txt" | tail -n 3 | tr '\n' ' ' | cut -c1-220)"
}
echo "== Aplicaciones mínimas en el paquete con el nombre sin tilde"
mini hola "console.log('MINI-HOLA'); require('electron').app.quit();"
mini ventana "const {app,BrowserWindow}=require('electron'); app.whenReady().then(async()=>{const w=new BrowserWindow({show:false}); await w.loadURL('data:text/html,<p>hola</p>'); console.log('MINI-VENTANA-OK'); app.quit();}); setTimeout(()=>{console.log('MINI-TIEMPO'); app.exit(3);},25000);"
mini hijo "const {app,utilityProcess}=require('electron'); const path=require('path'); app.whenReady().then(()=>{const p=utilityProcess.fork(path.join(__dirname,'hijo.js')); p.on('message',m=>{console.log('MINI-HIJO-OK',m); app.quit();}); p.on('exit',c=>{console.log('MINI-HIJO-SALIO',c); app.quit();});}); setTimeout(()=>{console.log('MINI-TIEMPO'); app.exit(3);},25000);" "process.parentPort.postMessage('ok');"
mini seguro "const {app,safeStorage}=require('electron'); app.whenReady().then(()=>{console.log('MINI-SEGURO-ANTES'); console.log('MINI-SEGURO', safeStorage.isEncryptionAvailable()); app.quit();}); setTimeout(()=>{console.log('MINI-TIEMPO'); app.exit(3);},25000);"

echo "== La aplicación real con distintas opciones (60 s como máximo cada una)"
real() {
  local etiqueta="$1"; shift
  RADAR_DATA_DIR="$(mktemp -d)" ELECTRON_ENABLE_LOGGING=1 perl -e 'alarm 60; exec @ARGV' "$APP/Contents/MacOS/radar-deuda" "$@" --prueba-arranque >"$WORK/r.txt" 2>&1
  local c=$?
  echo "-- $etiqueta: código $c (142 = colgada) | confirmación: $(grep -c 'Prueba de arranque superada' "$WORK/r.txt")"
  grep -Ev "$FILTRO" "$WORK/r.txt" | grep -v '^$' | tail -n 14 | cut -c1-240
  pkill -9 -f 'radar-deuda.app' 2>/dev/null
}
real "base"
real "--disable-gpu" --disable-gpu

echo "== Pila del proceso principal colgado"
RADAR_DATA_DIR="$(mktemp -d)" "$APP/Contents/MacOS/radar-deuda" --prueba-arranque >/dev/null 2>&1 &
PID=$!
sleep 20
sample "$PID" 3 -file "$WORK/sample.txt" 2>&1 | tail -n 3
grep -n "Sort by top of stack" -A18 "$WORK/sample.txt" | cut -c1-200
kill -9 "$PID" 2>/dev/null; pkill -9 -f 'radar-deuda.app' 2>/dev/null
