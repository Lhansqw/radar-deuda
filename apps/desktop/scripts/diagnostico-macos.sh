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

echo "== Traza de la caída (lldb, paquete original)"
RADAR_DATA_DIR="$(mktemp -d)" perl -e 'alarm 120; exec @ARGV' lldb --batch -o run -k 'bt 30' -k 'register read pc lr' -k 'image lookup -a $pc' -- "$APP/Contents/MacOS/radar-deuda" --prueba-arranque 2>&1 | tail -n 60
