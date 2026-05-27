#!/bin/bash
# AudioPro installer for macOS
# Copies the app to /Applications, strips quarantine, and re-signs adhoc
# locally so the system trusts it. No admin password required.

set -e

cd "$(dirname "$0")"

APP_NAME="AudioPro.app"
TARGET="/Applications/$APP_NAME"

echo ""
echo "════════════════════════════════════════"
echo "  Instalador de AudioPro"
echo "════════════════════════════════════════"
echo ""

if [ ! -d "$APP_NAME" ]; then
  echo "✗ Error: no encuentro $APP_NAME en la misma carpeta que este script."
  echo "  Asegúrate de extraer todo el ZIP antes de ejecutar."
  echo ""
  read -p "Presiona Enter para cerrar..."
  exit 1
fi

if [ -d "$TARGET" ]; then
  echo "→ Eliminando versión anterior en /Applications..."
  rm -rf "$TARGET"
fi

echo "→ Copiando AudioPro a /Applications/ ..."
cp -R "$APP_NAME" /Applications/

echo "→ Limpiando marca de cuarentena de macOS..."
xattr -cr "$TARGET" 2>/dev/null || true

echo "→ Re-firmando localmente (sin contraseña, solo para esta Mac)..."
codesign --force --deep --sign - "$TARGET" 2>&1 | grep -v "replacing existing signature" || true

echo ""
echo "✓ AudioPro instalado correctamente."
echo "  Búscalo en Launchpad o en /Applications."
echo ""
osascript -e 'display notification "Listo. Búscalo en Aplicaciones." with title "AudioPro instalado" sound name "Glass"' 2>/dev/null || true

read -p "Presiona Enter para cerrar esta ventana..."
