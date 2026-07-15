# Plan de acción — AudioPro: la mejor voz para cursos

> Estado: **PLAN aprobado para implementación por fases — ninguna fase implementada aún.**
> Este documento es el punto de partida de la siguiente sesión de trabajo.
> Base: rama `cursor/unify-adobe-podcast-pipeline-940c` (pipeline unificado v0.2.0:
> probe → measure → render, EQ F6 + loudnorm a −16 LUFS).

## 0. Objetivo

Flujo de trabajo: el profesor graba → **Adobe Podcast** limpia la voz → **AudioPro**
produce el master final del curso. La mejor versión de la herramienta debe garantizar
tres cosas en cada clase:

1. **Nivel correcto y consistente** para la plataforma de destino (Platzi, YouTube, podcast).
2. **Voz con cuerpo y presencia** — llena, cercana, sin sonar procesada.
3. **Cero artefactos** — y cuando el material de entrada ya viene con artefactos de la IA
   de Adobe, detectarlos, avisar y (cuando sea posible) repararlos aprovechando el
   audio original.

---

## 1. Investigación: fundamentos

### 1.1 La cadena de postproducción de voz (orden estándar de la industria)

El orden importa: cada etapa asume que la anterior ya hizo su trabajo.

```
1. REPARAR      de-click, de-clip, de-plosivo, notch de hum     (solo si hace falta)
2. LIMPIAR      denoise / de-reverb                             (lo hace Adobe Podcast, upstream)
3. RESTAR (EQ)  HPF + cortes quirúrgicos (mud/box/honk)         (antes de comprimir)
4. DINÁMICA     compresión suave 2:1–3:1 (3–6 dB GR)            (nivela frases)
                + compresión paralela (opcional, da cuerpo)
5. SUMAR (EQ)   presencia 2–5 kHz, aire 10 kHz+, cuerpo 100–300 (después de comprimir)
6. DE-ESS       control dinámico de sibilancia 5–9 kHz          (después de sumar brillo)
7. LOUDNESS     normalización al target de la plataforma
8. LIMITADOR    techo de true peak (−1 a −2 dBTP)               (siempre al final)
```

El pipeline actual de AudioPro hace 3, 5 (estático) y 7. Le faltan 1 (reparación), 4
(dinámica), 6 (de-ess dinámico; hoy es un corte estático opcional) y 8 (limitador TP
real — hoy el techo lo impone solo `loudnorm`).

**Regla de oro para cursos** (confirmada por la literatura de e-learning): cortes antes
que boosts, movimientos de ±1–3 dB máximo, compresión moderada 2:1–3:1. El estudiante
escucha la voz durante horas, muchas veces con audífonos: un master fatigante es peor
que un master conservador.

### 1.2 Niveles de entrega por plataforma (investigado julio 2026)

| Plataforma | Loudness integrado | True peak máx | Comportamiento |
|---|---|---|---|
| **YouTube** | **−14 LUFS** | −1 dBTP | Baja lo que supera −14; **no sube** lo que queda por debajo (quedas más bajo que el resto del contenido) |
| **Apple Podcasts** | **−16 LKFS ±1** | **−1 dBTP** | Espec oficial (ITU-R BS.1770-5); Sound Check reproduce a −16 |
| **Spotify** | −14 LUFS | −1 dBTP (−2 en modo loud) | Normaliza en ambas direcciones |
| **Amazon** | −14 LUFS | −2 dBTP | |
| **Broadcast (EBU R128)** | −23 LUFS | −1 dBTP | Solo si algún día se entrega a TV |
| **Platzi** | *sin espec pública* | — | Ver decisión abajo |

**Platzi no publica especificación técnica de loudness.** Decisión propuesta (a validar
con una medición empírica, ver §4): tratar el master de clase como *spoken word* estándar
→ **−16 LUFS integrado, TP ≤ −2 dBTP, mono**, que es lo que AudioPro ya hace. Es el
estándar Apple/podcast, tolerante a auriculares y parlantes de laptop, y deja 2 LU de
margen si la plataforma re-normaliza a −14.

**Trampa del mono→estéreo (importante, hoy nos afecta):** un WAV mono medido a −16 LUFS,
al colocarse en un video como dual-mono (L=R, sin pan law), suma ~+3 LU → el video queda
a ~−13 LUFS efectivos. Si el editor de video aplica pan law de −3 dB, queda en −16. Es
decir: **el nivel efectivo del curso publicado depende de cómo Platzi inserta el WAV en
el video**. Hay que medirlo una vez con una clase real publicada (experimento en §4) y
fijar el offset en el preset.

**LRA (rango de loudness):** para voz de cursos, LRA objetivo **≤ 8 LU** (ideal 4–6).
Un LRA alto significa frases que se pierden con ruido de fondo del estudiante. Hoy no
medimos ni corregimos LRA por compresión — `loudnorm` en modo lineal no lo reduce.

### 1.3 Qué es una voz "con cuerpo" (y cómo medirlo)

Cuerpo = equilibrio espectral correcto en la zona baja-media de la voz **+** densidad
dinámica (las sílabas débiles no se caen). No es "más graves".

Mapa de frecuencias de la voz hablada (consenso de las fuentes consultadas):

| Zona | Rango | Qué aporta | Riesgo si sobra |
|---|---|---|---|
| Rumble | < 80 Hz | nada útil en voz | ruido, plosivos, manejo |
| **Cuerpo / pecho** | **100–300 Hz** | calidez, peso, autoridad | boom, retumbe |
| Mud / boxiness | 250–600 Hz | — | sonido "de caja", turbio |
| Nasal / honk | 700–1.5 kHz | carácter | voz "de teléfono" |
| **Presencia** | **2–5 kHz** | inteligibilidad, cercanía | dureza, fatiga |
| Sibilancia | 5–9 kHz | articulación | esses hirientes |
| **Aire** | **10–16 kHz** | apertura, "producción cara" | siseo (si la fuente no llega, solo sube ruido) |

**Cómo medirlo objetivamente** (validado con FFmpeg local): energía RMS por banda
(bandpass + `astats` en un solo grafo `asplit`) → ratios banda/total comparados contra
una curva de referencia de voz masculina/femenina. Ejemplo de indicadores:

- `cuerpo_ratio` = RMS(100–300) − RMS(total): sano ≈ −5 a −10 dB. Menos de −15 dB = voz delgada.
- `mud_ratio` = RMS(300–600) − RMS(100–300): si es positivo, hay caja/turbiedad.
- `presencia_ratio` = RMS(2k–5k) − RMS(total): menor a −20 dB = voz opaca/lejana.
- `rolloff` espectral (`aspectralstats=measure=rolloff`): frecuencia bajo la cual está
  el 85 % de la energía. **Validado en este entorno**: ruido full-band → 20.4 kHz;
  el mismo ruido limitado a 8 kHz → 10.6 kHz. Detecta fuentes sin agudos reales
  (grabaciones de 16 kHz efectivos, típico de mala fuente o Zoom) donde el shelf de
  "aire" solo amplificaría ruido.

**Cómo se consigue el cuerpo** (herramientas en orden de transparencia):

1. **Corte antes que boost**: bajar 300–500 Hz (caja) hace que 100–300 Hz respire sin tocar nada.
2. **Compresión paralela** (técnica "New York", validada con grafo FFmpeg local):
   copia ultra-comprimida (ratio 8:1+, ataque rápido, release 300–800 ms) mezclada
   ~−10 dB bajo la señal seca. Sube las sílabas débiles y el sustain de la voz sin
   aplastar transitorios → densidad y cuerpo sin sonido "procesado". Es compresión
   *ascendente*: exactamente lo que le falta a una voz delgada.
3. **Low shelf suave** 100–200 Hz, +1 a +3 dB máximo (ya lo tenemos vía EQ editor).
4. **Excitación armónica** (`aexciter` nativo de FFmpeg — genera armónicos 2k–12 kHz
   para presencia/brillo; para armónicos de cuerpo la vía es saturación suave
   `asoftclip` en la rama paralela). Reemplaza la idea del viejo BodyGen en Python,
   sin Python.
5. **Fusión con el original** (§2.3): el recurso más potente cuando Adobe adelgazó la voz.

### 1.4 Catálogo de artefactos: reconocer → localizar → corregir

Los artefactos del flujo Adobe Podcast (documentados en reviews técnicos 2025-2026 y
reproducibles): la V2 de Enhance re-sintetiza la voz, y a strength alto o con fuentes ya
limpias introduce defectos característicos. Catálogo completo con su estrategia:

| # | Artefacto | Cómo suena | Cómo se detecta automáticamente (FFmpeg validado) | Corrección |
|---|---|---|---|---|
| A1 | **Clipping** (fuente o inter-sample) | crujido en picos, voz áspera | `astats`: `Flat_factor > 0` + `Peak_count` alto + `Peak_level ≈ 0 dBFS`; TP real con `ebur128=peak=true`. Validado: seno recortado → Flat_factor 34.5 vs 0.0 limpio | `adeclip` (interpola muestras recortadas); prevención: `alimiter` al final de la cadena |
| A2 | **Voz metálica/robótica** (sobre-proceso IA) | timbre sintético, "flanger" | difícil de medir directo; proxies: flatness/entropía espectral anómalas en `aspectralstats`. Estrategia honesta: flag heurístico + A/B humano | re-exportar de Adobe a strength 30–60 %; **fusión con original** (§2.3) |
| A3 | **Ruido musical / warble** en silencios | gorjeos tonales, "agua" | segmentar silencios con `silencedetect`, medir ahí tonalidad: flatness espectral baja + flux alto en tramos que deberían ser ruido plano | puerta suave (`agate`) solo en silencios, o fusión: silencios del original |
| A4 | **Esses distorsionadas / lisp** (Adobe V2) | "s" → "th", sibilantes rotas | energía 5–9 kHz por ventana: picos anómalos vs mediana del archivo | `deesser` nativo o `adynamicequalizer` (validado en 6.1); si es lisp severo, solo re-export |
| A5 | **Inicio/fin ahogados** (Adobe V2) | primeras/últimas palabras opacas | `rolloff` por tramos: cabeza y cola vs cuerpo del archivo | crossfade con el original en cabeza/cola |
| A6 | **Finales de palabra cortados / respiraciones tragadas** | habla "gated", antinatural | `RMS_difference` (astats) alto + ratio de silencio anómalo vs habla natural | fusión: cama del original a −15/−20 dB restaura respiraciones |
| A7 | **Plosivos** (p/b/t) | golpes graves | energía transitoria en banda 20–120 Hz por ventana corta | HPF por evento (`adynamicequalizer` modo cut con detección LF); subir HPF global si son constantes |
| A8 | **Hum 50/60 Hz + armónicos** | zumbido eléctrico | RMS de banda estrecha en 50/60/100/120/150/180 Hz vs vecinas (validado con bandpass+astats) | `bandreject` en los armónicos detectados (solo si se detecta) |
| A9 | **Clicks de boca** | chasquidos, saliva | densidad de transitorios HF; no hay detector directo | `adeclick` (existe en 6.1; por defecto es seguro para voz) |
| A10 | **Piso de ruido irregular** | siseo que sube y baja entre frases | `astats` `Noise_floor` + `RMS_trough` en huecos de habla | upstream (re-Adobe); nunca `afftdn` (decisión del proyecto) |
| A11 | **Silencio/ruido en cabeza y cola** | aire muerto antes de empezar | `silencedetect` (validado: detecta head 2.0 s / tail 1.5 s exactos) | trim con padding (~0.3 s) en el render |
| A12 | **DC offset** | clicks al editar, headroom perdido | `astats` `DC_offset` | el HPF de la cadena ya lo elimina; solo reportar |
| A13 | **Ancho de banda limitado** | voz sin aire, "de llamada" | `rolloff` < ~7 kHz | desactivar el shelf de aire automáticamente; avisar |
| A14 | **Fuente ya aplastada** (doble master) | sin dinámica, fatigante | `Crest_factor` bajo + LRA < 3 LU | avisar; saltar compresión propia |

Claves del catálogo: **todo se detecta con los binarios que ya empaquetamos** (ffmpeg/
ffprobe), sin Python ni modelos. La detección alimenta dos cosas: (a) el informe QC
por archivo en la UI, y (b) reparaciones *condicionales* — un filtro de reparación solo
entra a la cadena si su detector disparó, para mantener la filosofía "cadena fija y
predecible, no tocar lo que está bien".

---

## 2. Diseño propuesto: pipeline v0.3

### 2.1 Flujo por archivo

```
                    ┌─────────────────────────────────────────────────┐
 WAV (Adobe) ─────► │ 1. ANALIZAR (1 pasada ffmpeg, sin escribir)     │
                    │    ebur128 (I/LRA/TP) + astats + aspectralstats │
                    │    + silencedetect + bandas (hum, cuerpo, sib.) │
                    └──────────────┬──────────────────────────────────┘
                                   │  → informe QC entrada + flags A1..A14
                    ┌──────────────▼──────────────────────────────────┐
                    │ 2. REPARAR (solo filtros con flag activo)       │
                    │    adeclip | adeclick | bandreject hum | trim   │
                    └──────────────┬──────────────────────────────────┘
                    ┌──────────────▼──────────────────────────────────┐
                    │ 3. TONO + DINÁMICA (cadena única de render)     │
                    │    HPF → EQ F6 (auto-fit) → compresión 2.5:1    │
                    │    → paralela (cuerpo, opcional) → de-ess din.  │
                    │    → presencia/aire (según rolloff)             │
                    └──────────────┬──────────────────────────────────┘
                    ┌──────────────▼──────────────────────────────────┐
                    │ 4. LOUDNESS + TECHO                             │
                    │    loudnorm 2-pass (preset plataforma)          │
                    │    → alimiter techo TP del preset               │
                    └──────────────┬──────────────────────────────────┘
                    ┌──────────────▼──────────────────────────────────┐
                    │ 5. VERIFICAR salida (re-medir I/TP/LRA)         │
                    │    → badge OK / WARN / FAIL + informe QC        │
                    └─────────────────────────────────────────────────┘
```

Costo: pasa de 2 pasadas FFmpeg por archivo a 3–4 (analizar, medir loudness, render,
verificar; la verificación puede fusionarse en el render con `ebur128` en el mismo
grafo). Sigue siendo ~0.15× tiempo real.

### 2.2 Presets de plataforma (reemplaza el target fijo −16)

```js
const DELIVERY_PRESETS = {
  platzi:  { i: -16, tp: -2.0, lra: 8, mono: true,  note: 'validar offset mono→video (§4)' },
  youtube: { i: -14, tp: -1.5, lra: 8, mono: true },
  podcast: { i: -16, tp: -1.0, lra: 8, mono: true },   // espec Apple
};
```

- Selector en la toolbar (junto al output dir). Default: `platzi`.
- **Cambio de política**: normalizar en ambas direcciones (hoy: "solo subir"). Para un
  curso lo que importa es que las 40 clases queden *idénticas*; si una clase vino 2 LU
  más caliente, hay que bajarla. Se mantiene "solo subir" como opción avanzada.
- `lra` del preset es *objetivo de control de calidad*: si la medición de entrada
  supera el LRA objetivo, se activa la compresión niveladora (etapa 3); si ya viene
  denso, la compresión se salta (A14).

### 2.3 Fusión con el audio original (la feature diferencial)

Es la práctica documentada para des-robotizar Adobe Podcast: mezclar el original debajo
del enhanced. AudioPro puede hacerlo mejor que un DAW manual porque es determinista:

- **Emparejado**: el usuario arrastra la carpeta del original y la del enhanced;
  matching por nombre de archivo + duración (±0.1 s). Verificación de alineación por
  `axcorrelate` (existe en 6.1, validado).
- **Modo A — cama global**: original a −15/−20 dB bajo el enhanced (restaura
  respiraciones, naturalidad, silencios reales). Un `amix` con pesos.
- **Modo B — fusión por bandas** (validado el grafo con `acrossover` LR 4º orden,
  recombinación plana ±0.2 dB): **graves (< ~200 Hz) del original** (cuerpo y pecho
  reales que la IA adelgaza) **+ medios/agudos del enhanced** (la limpieza que
  queremos). Crossover configurable.
- Riesgo controlado: Adobe re-sintetiza → no hay coherencia de fase garantizada con el
  original. El modo B (bandas separadas) minimiza el peinado; el modo A se valida a
  oído con el A/B. Si `axcorrelate` indica desalineación > umbral, la fusión se
  desactiva con aviso.

### 2.4 Ajustes de la cadena de tono (sobre lo que ya existe)

- La EQ F6 con auto-fit espectral se conserva tal cual (es el corazón del sonido).
- El **shelf de aire pasa a ser condicional al rolloff** medido (A13).
- **De-esser**: migrar del corte estático opcional a `deesser`/`adynamicequalizer`
  (dinámico: solo actúa cuando hay sibilancia). Se activa solo si el detector A4 lo pide.
- **Compresión niveladora**: `acompressor` ratio 2.5:1, ataque ~15 ms, release ~150 ms,
  3–5 dB de reducción en picos de frase — entra solo si LRA de entrada > objetivo.
- **Compresión paralela de cuerpo**: `asplit` + `acompressor` 8:1 + `amix` (validado).
  Control único en UI: "Cuerpo" 0–100 % (mapea al peso de la rama comprimida).
- **Limitador**: `alimiter` con techo del preset, siempre al final. `loudnorm` deja de
  ser responsable del techo.

---

## 3. Plan de implementación por fases

Cada fase es un PR pequeño, testeable y útil por sí solo. Orden pensado para que el
valor llegue pronto: primero *saber* (medir), luego *no fallar* (verificar), luego
*sonar mejor* (dinámica/cuerpo), luego *reparar*, luego la fusión.

### Fase 1 — Módulo de métricas y QC de entrada
**Archivos:** `src/metrics.js` (nuevo), `src/pipeline.js` (llamada), `main.js` (evento IPC), renderer (mostrar).
- `analyzeFile(path)`: una pasada FFmpeg con `ebur128+astats+aspectralstats+silencedetect`
  + una pasada de bandas (`asplit` → bandpass múltiple + astats) → objeto `{ loudness,
  truePeak, lra, crest, noiseFloor, dcOffset, rolloff, bands, silences, flags[] }`.
- Implementar detectores A1, A8, A11, A12, A13, A14 (los deterministas) con umbrales
  en un solo objeto `QC_THRESHOLDS` comentado.
- UI: fila de archivo muestra chips (p. ej. `CLIP`, `HUM`, `SIN AIRE`) con tooltip.
- **Aceptación:** procesar los WAV sintéticos del corpus (Fase 8 seed) produce
  exactamente los flags esperados; cero falsos positivos sobre el corpus limpio.

### Fase 2 — Presets de plataforma + verificación de salida
**Archivos:** `src/pipeline.js`, `main.js` (schema settings), renderer (selector).
- `DELIVERY_PRESETS`, selector UI, normalización bidireccional (con opción legacy).
- Post-render: re-medir I/TP con `ebur128` y emitir `file:verified {i, tp, delta}`;
  badge verde si |delta| ≤ 0.5 LU y TP ≤ techo, naranja/rojo si no.
- **Aceptación:** los 3 presets aterrizan en ±0.5 LU del target sobre el corpus; el
  informe QC de salida aparece en la UI y en el log copiable.

### Fase 3 — Dinámica: nivelador + limitador
**Archivos:** `src/pipeline.js`.
- `acompressor` condicional a LRA de entrada; `alimiter` siempre (techo del preset).
- Exponer "Compresión: auto / off" en settings.
- **Aceptación:** archivo con LRA 14 LU termina ≤ 8 LU sin bombeo audible (revisión
  A/B); archivo con LRA 5 LU pasa sin compresión (flag A14 respetado).

### Fase 4 — Cuerpo y presencia
**Archivos:** `src/pipeline.js`, renderer (slider "Cuerpo").
- Rama paralela de cuerpo (asplit/acompressor/amix) con peso 0–0.5.
- Shelf de aire condicional al rolloff (A13). `aexciter` opcional detrás de un toggle
  "Presencia extra" (default off — primero validar a oído).
- **Aceptación:** con "Cuerpo" al 30 %, `cuerpo_ratio` del master sube ≥ 2 dB vs
  cuerpo 0 %, sin cambiar el LUFS integrado (±0.3) ni el TP.

### Fase 5 — Reparación condicional
**Archivos:** `src/metrics.js` (detectores A4, A7, A9), `src/pipeline.js` (inserción condicional).
- `adeclip` si A1, `adeclick` si A9, `bandreject` si A8, trim si A11, de-esser
  dinámico si A4, HPF dinámico si A7.
- Cada reparación queda registrada en el log y en el informe del archivo ("se aplicó X
  porque se midió Y").
- **Aceptación:** corpus sintético con cada artefacto inyectado → el master sale sin el
  artefacto (métricas antes/después en el informe) y los archivos limpios salen con
  cadena idéntica a Fase 4 (bit-a-bit).

### Fase 6 — Fusión con el original
**Archivos:** `src/pipeline.js`, `main.js`, renderer (emparejado + slider "Original").
- Emparejado por nombre/duración, verificación `axcorrelate`, modos A (cama) y B
  (bandas). Slider "Original: 0–40 %" + selector de modo.
- **Aceptación:** con un par real (original + enhanced de Adobe), el modo B devuelve
  un master cuyos silencios contienen la respiración del original y cuyo
  `cuerpo_ratio` ≥ el del enhanced solo; sin comb audible en A/B.

### Fase 7 — UX de control de calidad
**Archivos:** renderer.
- A/B con **nivel igualado** en el editor EQ (el A/B actual engaña: lo procesado suena
  "mejor" solo por estar más alto — igualar con ganancia de compensación medida).
- Espectrograma opcional por archivo (`showspectrumpic`, ya validado que existe) para
  inspección visual de artefactos.
- Exportar informe QC del lote (texto/markdown) para adjuntar al entregable del curso.
- **Aceptación:** A/B no cambia de loudness percibido (medición: misma M máx ±0.5 LU).

### Fase 8 — Corpus de validación y regresión
**Archivos:** `test/` (nuevo), `package.json` (script `npm test`), fixtures generadas con ffmpeg.
- Corpus sintético generado por script (tonos, ruido, voz TTS si hay, artefactos
  inyectados: clipping, hum, clicks, silencio, banda limitada) + **pedir a Daniel 5–10
  clases reales** (original + enhanced) como corpus privado no versionado.
- Tests (node:test): cada detector, conformidad de presets, invariantes del render
  (duración ±50 ms, formato, LUFS/TP). Corren con `npm test` en CI.
- **Aceptación:** suite verde; añadir un artefacto nuevo al corpus rompe el test hasta
  implementar su detector.

**Dependencias:** 1 → 2 → 3 → 4 → 5 → 6 (7 y 8 pueden avanzar en paralelo desde la Fase 2).

---

## 4. Decisiones abiertas (responder antes o durante Fase 2)

1. **Nivel Platzi**: ¿−16 LUFS mono está bien, o Platzi/producción pide otra cosa?
   **Experimento propuesto**: tomar una clase ya publicada en Platzi, medir su audio
   (`ffmpeg -i clase.mp4 -af ebur128 -f null -`) y fijar el target/offset del preset
   con ese dato real.
2. **Mono → video**: confirmar cómo inserta producción el WAV en el video (¿dual-mono
   sin pan law? → el master mono debería apuntar ~3 LU más abajo). Mismo experimento de
   arriba lo responde.
3. **¿Tenemos Adobe Podcast Premium?** El slider de strength (30–60 %) upstream reduce
   los artefactos A2–A6 mejor que cualquier reparación downstream. Si hay Premium, el
   SOP de grabación debería fijar strength ~50 % y AudioPro remata.
4. **Corpus real**: necesito 5–10 pares (original + enhanced) de profesores distintos
   (voz grave/aguda, con/sin acento marcado) para calibrar umbrales de detectores y
   defaults de "Cuerpo". Sin esto, los umbrales quedan en valores de literatura.
5. **Alcance de "salida a video"**: ¿AudioPro debe exportar también AAC/MP4 listo para
   pegar en Premiere, o el WAV es siempre el entregable?

---

## 5. Apéndice: comandos validados en este entorno (ffmpeg 6.1.1)

Todos ejecutados y verificados hoy; son la base de `src/metrics.js`:

```bash
# Loudness + LRA + true peak en una pasada
ffmpeg -i in.wav -af "ebur128=peak=true:framelog=quiet" -f null -

# Clipping: Flat_factor > 0 y Peak_count alto → recortado (validado: 34.5 vs 0.0)
ffmpeg -i in.wav -af "astats=measure_perchannel=Peak_count+Flat_factor+Peak_level:measure_overall=none" -f null -

# Ancho de banda efectivo (rolloff medio; validado 20.4k full-band vs 10.6k con lowpass 8k)
ffmpeg -i in.wav -af "aspectralstats=measure=rolloff:win_size=4096,ametadata=print:key=lavfi.aspectralstats.1.rolloff" -f null -

# Hum: RMS de banda estrecha vs total (validado)
ffmpeg -i in.wav -af "bandpass=f=60:width_type=q:w=8,astats=measure_perchannel=RMS_level" -f null -

# Silencios cabeza/cola (validado: 2.0 s / 1.5 s exactos)
ffmpeg -i in.wav -af "silencedetect=noise=-50dB:d=0.5" -f null -

# Reparaciones disponibles
ffmpeg -i in.wav -af adeclip out.wav          # clipping
ffmpeg -i in.wav -af adeclick out.wav         # clicks de boca
ffmpeg -i in.wav -af "bandreject=f=60:width_type=q:w=30" out.wav   # hum

# De-esser dinámico (sintaxis 6.1 validada)
ffmpeg -i in.wav -af "adynamicequalizer=threshold=0.02:dfrequency=6500:dqfactor=3:tfrequency=6500:tqfactor=3:ratio=2:attack=5:release=80" out.wav

# Compresión paralela de cuerpo (validado)
ffmpeg -i in.wav -filter_complex "[0]asplit=2[dry][wet];[wet]acompressor=threshold=-30dB:ratio=8:attack=5:release=340:makeup=6[c];[dry][c]amix=inputs=2:weights=1 0.35:normalize=0" out.wav

# Fusión por bandas original+enhanced (validado; recombinación plana ±0.2 dB)
ffmpeg -i original.wav -i enhanced.wav -filter_complex \
  "[0]acrossover=split=200:order=4th[olo][ohi];[1]acrossover=split=200:order=4th[elo][ehi];\
   [ohi]anullsink;[elo]anullsink;[olo][ehi]amix=inputs=2:normalize=0,alimiter=limit=0.891:level=false" out.wav

# Espectrograma para QC visual
ffmpeg -i in.wav -lavfi showspectrumpic=s=1200x400 spec.png
```

### Fuentes principales

- Apple Podcasts, *Audio requirements* — −16 LKFS ±1, TP ≤ −1 dBTP (ITU-R BS.1770-5):
  podcasters.apple.com/support/893-audio-requirements
- EBU R128 (2011+) — −23 LUFS broadcast, TP −1 dBTP, definición de LRA (EBU Tech 3342).
- Mediciones de la comunidad sobre YouTube: normaliza a ~−14 LUFS y solo atenúa.
- Reviews técnicos de Adobe Podcast Enhance V2 (2025-2026): catálogo de artefactos
  (robotización, esses rotas, inicios ahogados, warble en silencios) y la práctica de
  mezclar el original a ~20 % para restaurar naturalidad.
- Literatura de mezcla de voz (rangos de EQ y compresión paralela): coincidente entre
  múltiples fuentes de ingeniería de audio consultadas.
- Investigación académica sobre "musical noise" en denoise espectral (Interspeech,
  EURASIP): base de los detectores heurísticos A2/A3.
