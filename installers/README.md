# AudioPro · Instalador para Mac

Esta carpeta contiene los archivos listos para distribuir AudioPro a usuarios finales en macOS, sin necesidad de instalar Node, ni compilar, ni saber Terminal.

## ¿Cuál descargar?

| Archivo | Cuándo usarlo |
|---|---|
| **`AudioPro-Installer.zip`** | Recomendado. Doble click al `install.command` adentro instala todo automáticamente y limpia la marca de cuarentena de macOS. |
| **`AudioPro-Installer.dmg`** | Para usuarios que prefieren el flujo Mac clásico (montar imagen, arrastrar a Aplicaciones). Igual incluye el `install.command` adentro si aparece el error de Gatekeeper. |
| **`install.command`** suelto | Si ya tienes `AudioPro.app` instalado en `/Applications/` y solo necesitas re-firmarlo / limpiar cuarentena en una Mac. |
| **`LEEME.txt`** | Instrucciones que ven los usuarios al extraer el ZIP. |

## Cómo se usa (lado del usuario)

1. Descargar el `.zip` desde la sección **Releases** del repo (o desde la carpeta `installers/` en esta rama).
2. Doble click al ZIP para extraerlo.
3. **Click derecho** sobre `install.command` → **Abrir** (no doble click la primera vez).
4. macOS pedirá confirmar. Presionar "Abrir".
5. Se abre Terminal, ejecuta tres pasos en pocos segundos, y queda lista en `/Applications/AudioPro.app`.

## Qué hace el `install.command`

Resuelve el problema clásico de *"AudioPro está dañada y no puede abrirse"* que aparece cuando un usuario abre una app Electron firmada solo con firma adhoc.

```bash
cp -R AudioPro.app /Applications/                    # copia a Aplicaciones
xattr -cr /Applications/AudioPro.app                 # limpia cuarentena
codesign --force --deep --sign - /Applications/AudioPro.app  # re-firma adhoc local
```

El paso de `codesign --force --deep --sign -` aplica una **firma adhoc localmente** (sin certificado, sin cuenta Developer). Esto es lo que macOS necesita para "confiar" en la app en esa Mac específica. Sin este paso, el `xattr -cr` solo no resuelve el error.

## ¿Por qué este parche?

AudioPro está empaquetada con Electron, sin firma Apple Developer ID. Cuando se distribuye:

- A través de **Slack** → Slack corrompe la firma adhoc → macOS lo lee como "está dañada".
- A través de **GitHub / web** → la firma adhoc original llega intacta, pero solo es válida en la Mac donde fue firmada. En cualquier otra Mac, macOS la rechaza igual.

La solución 100% correcta es **firmar y notarizar con Apple Developer ID** (US$99/año). Mientras eso no ocurre, este instalador resuelve el problema sin pagar nada.

## Cómo regenerar el instalador (mantenimiento)

Cuando salga una nueva versión de AudioPro:

```bash
# 1. Compilar la app (asumiendo que ya está corriendo el build de electron-builder)
npm run build           # genera dist/AudioPro.app o dist/AudioPro.dmg

# 2. Reempaquetar el instalador con la app nueva
WORK=/tmp/audiopro-dist
mkdir -p "$WORK/installer"
cp -R dist/AudioPro.app "$WORK/installer/"
cp installers/install.command "$WORK/installer/"
cp installers/LEEME.txt "$WORK/installer/"

# 3. Generar ZIP (ditto preserva metadata Mac, no usar zip normal)
ditto -c -k --keepParent "$WORK/installer" installers/AudioPro-Installer.zip

# 4. Generar DMG
hdiutil create \
  -volname "AudioPro Installer" \
  -srcfolder "$WORK/installer" \
  -ov -format UDZO \
  installers/AudioPro-Installer.dmg

# 5. Commit (Git LFS toma los binarios automáticamente)
git add installers/
git commit -m "chore(installers): bump to vX.Y.Z"
```

## Estructura del bundle

```
AudioPro-Installer.zip          (148 MB, contiene:)
├─ AudioPro.app/                (351 MB descomprimido, app Electron arm64)
├─ install.command              (script bash con permiso de ejecución)
└─ LEEME.txt                    (instrucciones en español para el usuario)

AudioPro-Installer.dmg          (161 MB, mismo contenido que ZIP, montaje visual)
```

## Limitaciones conocidas

- **macOS Apple Silicon únicamente** (arm64). El bundle no incluye binarios x86_64. Para Macs Intel hay que regenerar con `electron-builder --x64` o un bundle universal `--universal`.
- **No funciona en Windows ni Linux** — este instalador es exclusivo macOS.
- El usuario sigue viendo una advertencia "desarrollador no identificado" la primera vez que ejecuta el `install.command`. Eso se resuelve con click derecho → Abrir → Abrir. Es un solo paso, una sola vez.
- Si el usuario ya intentó abrir la app y la movió al basurero, debe sacarla del basurero antes de volver a correr el instalador, o re-descargar el ZIP.
