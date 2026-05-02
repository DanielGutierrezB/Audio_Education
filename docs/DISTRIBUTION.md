# Distribuir AudioPro a tu equipo

Esta guía explica cómo generar el DMG instalador con TODO embebido
(Python + Resemble Enhance + modelos), de modo que el usuario final solo
tenga que abrir el DMG y arrastrar la app a Applications.

---

## Resumen

- **Output:** un único `AudioPro-0.1.1-arm64.dmg` (~3 GB)
- **Target:** macOS Apple Silicon (arm64)
- **Sin firma / sin notarización** — tu equipo abrirá la app con click derecho
  → "Abrir" la primera vez (warning de Gatekeeper aparece una sola vez).
- **Funciona offline desde el primer minuto.** No depende de Python del
  sistema, ni de internet, ni de ninguna instalación previa.

---

## Pre-requisitos del equipo de build (UNA vez)

```bash
brew install pyenv git-lfs ffmpeg
git lfs install
```

(Tu Mac de build ya los tiene a esta altura del proyecto.)

---

## Hacer un build

```bash
cd /ruta/a/AudioPro
npm install                 # primera vez, instala electron-builder
npm run build:full          # 1) construye python-runtime/  2) empaqueta DMG
```

`build:full` corre dos pasos:

1. **`build:python`** → ejecuta `scripts/build-python-runtime.sh`. Crea
   `./python-runtime/` (~3 GB) con:
   - Python 3.10.16 (vía pyenv).
   - `torch==2.1.1`, `torchaudio`, `soundfile`, `resemble-enhance`.
   - Modelos de Resemble Enhance pre-descargados (~680 MB de weights LFS).
   - Launcher portable que reescribe sus paths internos en cada arranque.

2. **`build`** → corre `electron-builder --mac --arm64`, que copia
   `python-runtime/` y `bin/` dentro de `AudioPro.app/Contents/Resources/`.

### Output

```
dist/
├── AudioPro-0.1.1-arm64.dmg          ← este es el que distribuyes
├── mac-arm64/
│   └── AudioPro.app/                  ← .app desempacada (para test rápido)
└── ...
```

### Tiempo estimado de build

- `build:python` la primera vez: ~5-8 min (descarga torch + modelos LFS).
- `build:python` veces siguientes: ~2 min (reusa pip cache).
- `build`: ~1-2 min.

---

## Lo que ve el usuario final

1. Recibe `AudioPro-0.1.1-arm64.dmg` (link de Drive, AirDrop, etc).
2. Doble click → arrastra a Applications.
3. **Primera vez:** macOS bloquea con "no se puede abrir, dev no
   identificado". Workaround: click derecho sobre AudioPro.app → Abrir →
   confirmar. Una sola vez.
4. La app arranca, lista. Sin instalar Python, sin internet, sin nada.

---

## Diagnóstico rápido en el equipo

Si Resemble no funciona en una máquina del equipo, abre la app con la
consola de DevTools (Cmd+Opt+I) y revisa el log:

- ✅ Bien: `RE:loading device=cpu preset=...` y luego `RE:progress diffusion N/M`
- ❌ Mal: `Resemble Enhance not installed` → el `python-runtime/` no se
  empacó bien o el shim no es ejecutable. Revisar permisos en el DMG.

Para test manual desde la app instalada:

```bash
/Applications/AudioPro.app/Contents/Resources/python-runtime/bin/python3.10 \
  -c "import resemble_enhance, torch; print('ok', torch.__version__)"
```

---

## ¿Y si necesito Intel Mac también?

El runtime actual es solo arm64. Para Intel:

1. Compilar todo en una máquina Intel (o usar un Intel runner).
2. Cambiar `--mac --arm64` por `--mac --x64` en el script.
3. `pyenv install 3.10.16` produce un binario para la arquitectura host.

Hacer un DMG universal (arm64+x64) requiere un build separado por
arquitectura y luego juntarlos con `lipo`. Pregunta a Robotina si
necesitas eso — implica reestructurar `bin-paths.js` y duplicar el venv.

---

## Limpieza

Para liberar espacio entre builds:

```bash
rm -rf python-runtime/ dist/
```

Ambos directorios están en `.gitignore`.

---

## Troubleshooting

| Síntoma | Causa probable | Solución |
|--------|----------------|----------|
| `pyenv: command not found` durante `build:python` | pyenv no instalado | `brew install pyenv` |
| `git: 'lfs' is not a git command` | git-lfs faltante | `brew install git-lfs && git lfs install` |
| DMG abre con "está dañado" en el equipo | Atributos de cuarentena | El usuario corre: `xattr -cr /Applications/AudioPro.app` |
| Resemble falla con "model not found" en la app empacada | Modelos no se incluyeron | Verifica que `python-runtime/lib/python3.10/site-packages/resemble_enhance/model_repo/` tenga ~680 MB |
| Build falla con "Symbol not found: _XML_SetAllocTrackerActivationThreshold" | Estás usando el python@3.10 de Homebrew (bug en macOS 25.x) | Usa pyenv. El script ya lo hace por defecto. |
