# Plan de acción — AudioPro: la mejor voz para cursos

> Estado: **Fases 1–9 implementadas, v0.3.4 actual.** Fase 8 completa: A/B con
> nivel igualado en el editor EQ, A/B de tres vías en Modo 2, espectrograma
> opcional por archivo y export del informe QC del lote, además de los chips QC +
> badge de modo + verificación de salida ya existentes. Fase 10 (enhance
> embebido, Nivel 2 de §3.1) **no** se aborda — sigue pendiente de la decisión D6
> (§5). Ver `§4` para el detalle fase por fase y `test/` (Fase 9) para la suite
> que valida los detectores y ambos modos.
> Revisión 2 (misma sesión de diseño): incorpora los **dos modos de entrada**
> definidos por Daniel y la integración con
> [`adobe-podcast-batch`](https://github.com/DanielGutierrezB/adobe-podcast-batch).
> Base de diseño: pipeline v0.2.0 (probe → measure → render, EQ F6 + loudnorm a
> −16 LUFS) — reemplazado por el pipeline de este documento.
> **Auditoría de fidelidad doc↔código (jul. 2026):** este documento describía
> algunas piezas de la Fase 5 y la fusión de Modo 2 como más automáticas de lo
> que el código realmente hace. Corregido en línea en §2.1, §2.2, §2.4, §3 y
> Fase 5/6: el balance de fusión es hoy un ajuste manual del usuario (no hay
> detectores por fuente que lo sugieran), la verificación de alineación del par
> es una tolerancia de duración (no `axcorrelate`), y `adeclick` corre sin
> condición en todo archivo (no hay detector de A9). Cada punto queda marcado
> "no implementado" / "backlog" donde aplica, en vez de sonar como que ya
> funciona.

## 0. Objetivo

AudioPro produce el master final de la voz de los cursos y acepta **dos modos de
entrada** (decisión de producto):

- **Modo 1 — Solo original**: llega únicamente la grabación cruda, sin pasar por
  Adobe Podcast. AudioPro debe llegar al mejor resultado posible por sí solo:
  limpieza local condicional (§2.5) + reparación + tono + dinámica + loudness.
- **Modo 2 — Original + Adobe al 100 %**: llegan el original **y** su versión
  Enhance Speech con voz limpia al **100 %** (generada por `adobe-podcast-batch`,
  ver §3). AudioPro primero **fusiona** ambos hasta el balance ideal — la limpieza
  de Adobe + el cuerpo y la naturalidad del original (§2.4) — y desde ese mejor
  punto de partida aplica la misma cadena de master.

En ambos modos el master debe garantizar tres cosas en cada clase:

1. **Nivel correcto y consistente** para la plataforma de destino (Platzi, YouTube, podcast).
2. **Voz con cuerpo y presencia** — llena, cercana, sin sonar procesada.
3. **Cero artefactos** — detectarlos, avisar y repararlos: los de micro/sala en
   Modo 1; los de la IA de Adobe en Modo 2, donde el original es el recurso de
   reparación.

Meta final (§3.1): **todo en un solo proceso** — se arrastran los originales crudos,
AudioPro obtiene la voz limpia con el motor de `adobe-podcast-batch`, fusiona y
masteriza en una sola cola.

---

## 1. Investigación: fundamentos

### 1.1 La cadena de postproducción de voz (orden estándar de la industria)

El orden importa: cada etapa asume que la anterior ya hizo su trabajo.

```
1. REPARAR      de-click, de-clip, de-plosivo, notch de hum     (solo si hace falta)
2. LIMPIAR      denoise / de-reverb                             (Modo 2: lo hizo Adobe; Modo 1: arnndn local condicional, §2.5)
3. RESTAR (EQ)  HPF + cortes quirúrgicos (mud/box/honk)         (antes de comprimir)
4. DINÁMICA     compresión suave 2:1–3:1 (3–6 dB GR)            (nivela frases)
                + compresión paralela (opcional, da cuerpo)
5. SUMAR (EQ)   presencia 2–5 kHz, aire 10 kHz+, cuerpo 100–300 (después de comprimir)
6. DE-ESS       control dinámico de sibilancia 5–9 kHz          (después de sumar brillo)
7. LOUDNESS     normalización al target de la plataforma
8. LIMITADOR    techo de true peak (−1 a −2 dBTP)               (siempre al final)
```

**Estado histórico (línea base pre-v0.3, ya cerrada):** el pipeline v0.2.0 solo hacía
3, 5 (estático) y 7; le faltaban 1 (reparación), 4 (dinámica), 6 (de-ess dinámico) y 8
(limitador TP real). Las Fases 1–9 (§4) implementan los cuatro huecos — ver el
detalle fase por fase para lo que quedó condicional de verdad vs. lo que no.

**Diferencia de orden que sí persiste:** arriba REPARAR(1) va antes de LIMPIAR(2); en
`pipeline.js` es al revés — el denoise (`arnndn`) corre antes que la reparación
(`adeclip`/`adeclick`/notch de hum). No se tocó el pipeline en esta auditoría de
documentación; queda anotado por si en algún momento se quiere alinear con el orden
de industria de arriba (limpiar con ruido de fondo sin reparar antes podría dejarle
menos que trabajar al denoise, o viceversa — no está medido cuál orden da mejor
resultado en este proyecto).

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
con una medición empírica, ver §5): tratar el master de clase como *spoken word* estándar
→ **−16 LUFS integrado, TP ≤ −2 dBTP, mono**, que es lo que AudioPro ya hace. Es el
estándar Apple/podcast, tolerante a auriculares y parlantes de laptop, y deja 2 LU de
margen si la plataforma re-normaliza a −14.

**Trampa del mono→estéreo (importante, hoy nos afecta):** un WAV mono medido a −16 LUFS,
al colocarse en un video como dual-mono (L=R, sin pan law), suma ~+3 LU → el video queda
a ~−13 LUFS efectivos. Si el editor de video aplica pan law de −3 dB, queda en −16. Es
decir: **el nivel efectivo del curso publicado depende de cómo Platzi inserta el WAV en
el video**. Hay que medirlo una vez con una clase real publicada (experimento en §5) y
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
5. **Fusión con el original** (§2.4): el recurso más potente cuando Adobe adelgazó la voz.

### 1.4 Catálogo de artefactos: reconocer → localizar → corregir

El catálogo cubre las dos familias que ven los dos modos: **artefactos de captura**
(A1, A7–A14: clipping, hum, plosivos, clicks, ruido — lo que trae el original crudo
del Modo 1) y **artefactos de la IA de Adobe** (A2–A6, documentados en reviews
técnicos 2025-2026 y reproducibles: la V2 de Enhance re-sintetiza la voz, y a
strength alto o con fuentes ya limpias introduce defectos característicos — lo que
puede traer el enhanced del Modo 2). Catálogo completo con su estrategia:

| # | Artefacto | Cómo suena | Cómo se detecta automáticamente (FFmpeg validado) | Corrección |
|---|---|---|---|---|
| A1 | **Clipping** (fuente o inter-sample) | crujido en picos, voz áspera | `astats`: `Flat_factor > 0` + `Peak_count` alto + `Peak_level ≈ 0 dBFS`; TP real con `ebur128=peak=true`. Validado: seno recortado → Flat_factor 34.5 vs 0.0 limpio | `adeclip` (interpola muestras recortadas); prevención: `alimiter` al final de la cadena |
| A2 | **Voz metálica/robótica** (sobre-proceso IA) | timbre sintético, "flanger" | difícil de medir directo; proxies: flatness/entropía espectral anómalas en `aspectralstats`. Estrategia honesta: flag heurístico + A/B humano | **fusión con original** (§2.4) — en Modo 2 es automática; subir el peso del original |
| A3 | **Ruido musical / warble** en silencios | gorjeos tonales, "agua" | segmentar silencios con `silencedetect`, medir ahí tonalidad: flatness espectral baja + flux alto en tramos que deberían ser ruido plano | puerta suave (`agate`) solo en silencios, o fusión: silencios del original |
| A4 | **Esses distorsionadas / lisp** (Adobe V2) | "s" → "th", sibilantes rotas | energía 5–9 kHz por ventana: picos anómalos vs mediana del archivo | `deesser` nativo o `adynamicequalizer` (validado en 6.1); en Modo 2, subir peso del original en la banda de sibilancia (§2.4) |
| A5 | **Inicio/fin ahogados** (Adobe V2) | primeras/últimas palabras opacas | `rolloff` por tramos: cabeza y cola vs cuerpo del archivo | crossfade con el original en cabeza/cola |
| A6 | **Finales de palabra cortados / respiraciones tragadas** | habla "gated", antinatural | `RMS_difference` (astats) alto + ratio de silencio anómalo vs habla natural | fusión: cama del original a −15/−20 dB restaura respiraciones |
| A7 | **Plosivos** (p/b/t) | golpes graves | energía transitoria en banda 20–120 Hz por ventana corta | HPF por evento (`adynamicequalizer` modo cut con detección LF); subir HPF global si son constantes |
| A8 | **Hum 50/60 Hz + armónicos** | zumbido eléctrico | RMS de banda estrecha en 50/60/100/120/150/180 Hz vs vecinas (validado con bandpass+astats) | `bandreject` en los armónicos detectados (solo si se detecta) |
| A9 | **Clicks de boca** | chasquidos, saliva | densidad de transitorios HF; no hay detector directo | `adeclick` (existe en 6.1; por defecto es seguro para voz) |
| A10 | **Piso de ruido alto o irregular** | siseo constante o que sube y baja entre frases | `astats` `Noise_floor` + `RMS_trough` en huecos de habla | Modo 1: `arnndn` (RNNoise) condicional, §2.5; Modo 2: re-Adobe upstream. Nunca `afftdn` sobre material ya limpio (decisión del proyecto) |
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

### 2.1 Los dos modos de entrada

| | **Modo 1 — Solo original** | **Modo 2 — Original + Adobe 100 %** |
|---|---|---|
| Entrada | grabación cruda | grabación cruda **+** Enhance Speech al 100 % (par generado por `adobe-podcast-batch`, §3) |
| Problema a resolver | ruido/sala/hum del micrófono real | artefactos de la IA (A2–A6) y voz adelgazada |
| Etapa propia del modo | **limpieza local condicional** (§2.5) | **fusión al balance ideal** (§2.4) |
| Resto de la cadena | idéntica: reparar → tono + dinámica → loudness → verificar | idéntica |

Por qué el par de Modo 2 llega al **100 %** y no con el slider dry/wet de
`adobe-podcast-batch`: el blend de esa app es un `amix` de banda completa a peso
fijo. Al pedir el 100 % + el original, AudioPro conserva las **dos señales puras**
y puede fusionar por bandas (crossover configurable) y/o con una cama global del
original a peso ajustable — dos estrategias explícitas en vez de un porcentaje
único a ciegas — y siempre puede re-fusionar sin volver a gastar créditos de
Adobe. **Estado actual**: el balance (estrategia, crossover, % de original) es un
ajuste del usuario en Settings, fijo para todo el lote — no hay balance
automático por medición ni verificación de alineación por correlación de fase
todavía (ver detalle y honestidad de estado en §2.4).

Detección del modo, sin fricción para el usuario:

1. Si el lote trae pares emparejables (por nombre + duración, §2.4) → Modo 2.
2. El usuario arrastra la **carpeta del lote** (la que contiene los originales
   *y*, como subcarpeta, la `Enhanced/` que produce `adobe-podcast-batch`) — no la
   carpeta `Enhanced/` por sí sola. `pairing.js` `findPairs(folderPath)` escanea
   `folderPath` en busca de audios y busca `folderPath/Enhanced/` como subcarpeta;
   si se arrastra `Enhanced/` directamente, no encuentra `Enhanced/Enhanced/` y
   todo cae como sueltos en Modo 1 sin avisar que faltó un nivel.
3. Archivos sueltos sin par → Modo 1.
4. **No implementado:** no hay selector manual en la toolbar para forzar el modo en
   casos ambiguos; el único control relacionado hoy es "Enable fusion" en Settings
   (apaga la fusión para *todo* el lote, no fuerza un modo por archivo).

### 2.2 Flujo por archivo

```
 Modo 1: original.wav ────────────────────────────────┐
 Modo 2: original.wav + enhanced.wav ► 0. FUSIONAR ───┤   (§2.4: check de duración
                                                      │    + fusión por bandas / cama)
                    ┌─────────────────────────────────▼───┐
                    │ 1. ANALIZAR (1 pasada ffmpeg,       │
                    │    sin escribir)                    │
                    │    ebur128 (I/LRA/TP) + astats +    │
                    │    aspectralstats + silencedetect + │
                    │    bandas (hum, cuerpo, sibilancia) │
                    └──────────────┬──────────────────────┘
                                   │  → informe QC entrada + flags A1..A14
                    ┌──────────────▼──────────────────────┐
                    │ 2. LIMPIAR (solo Modo 1, si A10)    │
                    │    arnndn (RNNoise) condicional     │
                    └──────────────┬──────────────────────┘
                    ┌──────────────▼──────────────────────┐
                    │ 3. REPARAR (solo filtros con flag)  │
                    │    adeclip | adeclick | notch hum   │
                    │    | trim silencios                 │
                    └──────────────┬──────────────────────┘
                    ┌──────────────▼──────────────────────┐
                    │ 4. TONO + DINÁMICA (cadena única)   │
                    │    HPF → EQ F6 (auto-fit) →         │
                    │    compresión 3:1 → paralela        │
                    │    (cuerpo) → de-ess dinámico →     │
                    │    presencia/aire (según rolloff)   │
                    └──────────────┬──────────────────────┘
                    ┌──────────────▼──────────────────────┐
                    │ 5. LOUDNESS + TECHO                 │
                    │    loudnorm 2-pass (preset) →       │
                    │    alimiter techo TP del preset     │
                    └──────────────┬──────────────────────┘
                    ┌──────────────▼──────────────────────┐
                    │ 6. VERIFICAR salida (I/TP, no LRA)  │
                    │    → badge OK / WARN (sin FAIL)     │
                    └─────────────────────────────────────┘
```

**Estado actual (honesto):** en Modo 2 la fusión (paso 0) corre primero, con los
ajustes de Settings del lote (estrategia, crossover, % de original) — no hay
todavía una pasada de detectores *por fuente* que alimente el balance
automáticamente (esa idea, útil para casos como "enhanced con esses rotas A4 →
más original en esa banda", sigue en el backlog, ver §2.4). El análisis completo
(paso 1) corre sobre el **resultado de la fusión**, no sobre cada fuente por
separado.

Costo: pasa de 2 pasadas FFmpeg por archivo a 3–5 (fusión, analizar, medir loudness,
render, verificar; la verificación puede fusionarse en el render con `ebur128` en el
mismo grafo). Sigue siendo ~0.15–0.2× tiempo real.

### 2.3 Presets de plataforma (reemplaza el target fijo −16)

Propuesta de diseño original (para contexto). El objeto real, implementado en
`src/presets.js`, no tiene los campos `mono`/`note` — el mono se aplica siempre e
incondicionalmente vía `aformat=channel_layouts=mono` en `pipeline.js`, no es parte
del preset:

```js
// Diseño original — ver src/presets.js para los campos reales (i, tp, lra, label)
const DELIVERY_PRESETS = {
  platzi:  { i: -16, tp: -2.0, lra: 8, mono: true,  note: 'validar offset mono→video (§5)' },
  youtube: { i: -14, tp: -1.5, lra: 8, mono: true },
  podcast: { i: -16, tp: -1.0, lra: 8, mono: true },   // espec Apple
};
```

- Selector en la toolbar (junto al output dir). Default: `platzi`.
- **Cambio de política**: normalizar en ambas direcciones (hoy: "solo subir"). Para un
  curso lo que importa es que las 40 clases queden *idénticas*; si una clase vino 2 LU
  más caliente, hay que bajarla. Se mantiene "solo subir" como opción avanzada.
- `lra` del preset es *objetivo de control de calidad*: si la medición de entrada
  supera el LRA objetivo, se activa la compresión niveladora (etapa 4 del flujo); si
  ya viene denso, la compresión se salta (A14).

### 2.4 Fusión original + enhanced: el corazón del Modo 2

Es la práctica documentada para des-robotizar Adobe Podcast (mezclar el original
debajo del enhanced), elevada a etapa de primera clase: como el par llega con la voz
limpia al **100 %**, encontrar el balance ideal es responsabilidad de AudioPro, y
puede hacerlo mejor que un DAW manual porque es determinista y medible:

- **Emparejado**: matching por **nombre base sin extensión** + duración dentro de
  ±0.5 s (`PAIR_DURATION_TOLERANCE_SEC` en `pipeline.js`) — `adobe-podcast-batch`
  siempre exporta WAV aunque el original sea MP3/M4A (`X.mp3` ↔ `Enhanced/X.wav`).
  Reconocer su convención permite emparejar con solo arrastrar la carpeta (§3).
  **Implementado así, no con `axcorrelate`**: la verificación de alineación hoy es
  solo esa comparación de duración — si no coincide dentro de la tolerancia, el
  archivo cae a Modo 1 sobre el **original** (ver `pipeline.js` `processFile`, rama
  `durOk`: `workingPath` nunca se reasigna a `file.pairPath`, así que el enhanced
  no se toca en absoluto en ese caso — **posible bug de producto, no solo de docs**:
  probablemente tendría más sentido caer sobre el *enhanced* ya limpio en vez del
  original crudo; queda para decidir, no se cambió el comportamiento en esta pasada
  de auditoría). Una verificación real de coherencia de fase con `axcorrelate` (§6
  tiene el comando validado de forma aislada) sigue **pendiente de integrar**: hoy
  no detectaría un desalineamiento interno que no cambie la duración total.
- **Estrategia por defecto — fusión por bandas** (validado el grafo con `acrossover`
  LR 4º orden, recombinación plana ±0.2 dB): **graves (< ~200 Hz) del original**
  (cuerpo y pecho reales que la IA adelgaza) **+ medios/agudos del enhanced** (la
  limpieza que queremos). Crossover configurable.
- **Estrategia alternativa — cama global**: original completo a peso ajustable bajo el
  enhanced (restaura respiraciones, naturalidad, silencios reales). Un `amix` con
  pesos. Ambas estrategias se combinan (`bands_bed`): bandas + cama sutil encima.
- **Balance — hoy es un ajuste del usuario, no automático**: un control "Original:
  0–40 %" + selector de estrategia (bandas / cama / ambas) en Settings, fijo para
  todo el lote que se procese con esos ajustes. **No implementado todavía**: la idea
  original de este documento — correr los detectores (§1.4) sobre cada fuente
  *antes* de fusionar y ajustar el balance automáticamente (p. ej. enhanced con
  esses rotas A4 → más original en esa banda) — sigue en el backlog; ver también
  §2.2.
- Riesgo controlado: Adobe re-sintetiza → no hay coherencia de fase garantizada con el
  original. La fusión por bandas (espectros separados) minimiza el peinado; la cama se
  valida a oído con el A/B. Hoy, si la duración no coincide dentro de la tolerancia,
  la fusión se desactiva y el archivo se procesa como Modo 1 sobre el **original**
  (ver nota arriba sobre por qué probablemente debería ser sobre el enhanced) — y
  como se explica arriba, ni siquiera esa comparación de duración cubre un
  desalineamiento interno que no altere la duración total; una comprobación por
  `axcorrelate` cerraría ese hueco.

### 2.5 Limpieza local: el corazón del Modo 1

Sin Adobe upstream, AudioPro necesita su propia etapa de limpieza para grabaciones
crudas — pero **condicional y conservadora**, coherente con la decisión del proyecto
de no degradar material que ya está bien:

- **Motor: `arnndn` (RNNoise)** — denoise neuronal *nativo de FFmpeg*, sin Python ni
  procesos externos. **Validado en este entorno** (ffmpeg 6.1.1): con el modelo
  `somnolent-hogwash` (speech + recording noise, ~290 KB, dominio público) el piso de
  ruido de una señal de prueba bajó de −26.7 dB a −44.6 dB. Requiere 48 kHz (el
  pipeline ya trabaja a 48 k) y soporta `mix` para limpieza parcial (validado
  `mix=0.6` → piso −32.6 dB): menos agresivo = menos riesgo de voz acuosa.
- **Puerta de entrada por medición**: solo se activa si `Noise_floor` de entrada
  supera el umbral (propuesta inicial: > −55 dB). Material grabado en cabina limpia
  pasa intacto. El `mix` se escala con el exceso de ruido (poco ruido → mix 0.4;
  mucho → 0.9) en vez de todo-o-nada.
- **Complementos según flags**: hum (A8) se trata con notch — en la implementación
  real corre *después* del denoise, no antes (`pipeline.js`: `denoiseSpec` va antes
  de `repairChain` en la cadena); de-reverb no tiene solución FFmpeg decente — si la
  sala suena muy viva, hoy no hay aviso automático de "sala viva" ni recomendación
  de pasar a Modo 2 (ver nota de Fase 7 — sigue en el backlog).
- **Expectativa honesta**: RNNoise limpia ruido estacionario y algo de no
  estacionario; no compite con Enhance V2 en calidad de re-síntesis. El modelo
  `.rnnn` se agrega a `scripts/fetch-bin.*` con checksum, junto a ffmpeg/ffprobe.

### 2.6 Ajustes de la cadena de tono (sobre lo que ya existe)

- La EQ F6 con auto-fit espectral se conserva tal cual (es el corazón del sonido).
- El **shelf de aire pasa a ser condicional al rolloff** medido (A13).
- **De-esser**: migrar del corte estático opcional a `deesser`/`adynamicequalizer`
  (dinámico: solo actúa cuando hay sibilancia). Se activa solo si el detector A4 lo pide.
- **Compresión niveladora**: `acompressor` ratio 3:1, ataque 15 ms, release 250 ms
  (valores finales en `pipeline.js` — se ajustaron desde el 2.5:1/~150 ms de este
  diseño inicial durante la implementación) — entra solo si no está `FLAT_DYNAMICS`
  (LRA de entrada ya por debajo del objetivo).
- **Compresión paralela de cuerpo**: `asplit` + `acompressor` + `amix` (validado; ver
  `pipeline.js` `assembleGraph` para los parámetros finales de la rama comprimida,
  ligeramente distintos del ejemplo aislado en §6). Control único en UI: "Cuerpo"
  **0–50 %** (el store interno acepta hasta 100 pero el slider expuesto llega a 50 —
  no se validó a oído más allá de eso).
- **Limitador**: `alimiter` con techo del preset, siempre al final. `loudnorm` deja de
  ser responsable del techo.

---

## 3. Integración con `adobe-podcast-batch` (el eslabón upstream)

Repo revisado: [DanielGutierrezB/adobe-podcast-batch](https://github.com/DanielGutierrezB/adobe-podcast-batch)
— app Electron (macOS/Windows) que limpia audio **por lote** contra el endpoint
interno de Adobe Podcast (`phonos-server-flex.adobe.io`), con login embebido de
Adobe, 5 archivos en paralelo, manejo automático del límite de créditos (espera y
reanuda) y slider "Voz limpia %". Hallazgos que importan para AudioPro:

- **El motor es un módulo aislado y reutilizable**: `premiere-plugin/js/phonos.js`
  (~230 líneas, sin dependencias de Electron) expone `enhanceToFile(inPath, outPath,
  {token, model, cleanVoice, ...})` — sube, procesa, descarga. La orquestación del
  lote (`batch.js`, workers + compuerta de créditos compartida) tampoco depende de
  Electron. Están diseñados para ser embebidos.
- **Convención de salida**: `Enhanced/<nombre>.wav` junto al original
  (`pcm_s16le`). Con voz limpia < 100 %, la mezcla queda en `Enhanced/` y la voz
  100 % en `Enhanced/Clean voice/<nombre>.wav`; **al 100 % el archivo de
  `Enhanced/` ya es la voz limpia pura** — exactamente el par que necesita el
  Modo 2. El emparejado de AudioPro (§2.4) adopta esta convención tal cual.
- **Su blend dry/wet es `amix` full-band a 48 k mono** (peso fijo, sin bandas ni
  medición). Confirma la decisión del §2.1: pedir el 100 % y fusionar en AudioPro,
  donde hay crossover configurable y verificación de duración del par (detectores
  por fuente y verificación de fase/alineación reales siguen sin integrar, §2.4).
  El SOP para el equipo queda: *en `adobe-podcast-batch`, dejar "Voz limpia" al
  100 %*.
- **El token de Adobe es un IMS JWT** extraído del login embebido, guardado
  localmente cifrado (`safeStorage`). El manejo de créditos (429/`limits` → espera
  con cuenta regresiva) y la re-autenticación silenciosa ya están resueltos ahí.

### 3.1 "Todo en un solo proceso" — integración en dos niveles

**Nivel 1 — Handoff automático (sin token, sin riesgo, primero):** AudioPro
reconoce la estructura de carpetas de `adobe-podcast-batch`. Arrastras la carpeta
del lote → detecta `Enhanced/` → empareja original + limpio → Modo 2 en cadena para
todo el lote. El "proceso único" es: correr `adobe-podcast-batch` (que ya es
desatendido: cola + espera de créditos) y al terminar soltar la carpeta en AudioPro.
Cero acoplamiento entre las dos apps.

**Nivel 2 — Enhance embebido (la meta):** AudioPro incorpora `phonos.js` + la
compuerta de créditos de `batch.js` como dependencia (idealmente publicando el motor
como paquete compartido entre ambas apps, p. ej. `@daniel/phonos-client`, para no
duplicar el código que ya funciona). Flujo: arrastras **solo los originales crudos**
→ AudioPro sube a Adobe (token con el mismo login embebido), descarga la voz 100 %
limpia, fusiona (§2.4) y masteriza — una sola cola, un solo botón. Consideraciones:

- El pipeline de AudioPro pasa a tener una etapa 0 remota con esperas largas
  (créditos, cola de Adobe): la UI de cola ya distingue estados; habría que sumar
  los estados de `phonos` (`subiendo`, `procesando`, `esperando créditos`).
- Riesgo asumido: endpoint interno no oficial, puede cambiar sin aviso (ya
  documentado en el README de `adobe-podcast-batch`). Por eso el Nivel 1 se
  mantiene siempre como camino de respaldo, y el Modo 1 (solo original) como plan C.
- Login/token: mismo patrón probado (ventana `podcast.adobe.com` + `getAccessToken`
  en memoria + `safeStorage`); si ambas apps conviven, cada una guarda su token.

---

## 4. Plan de implementación por fases

Cada fase es un PR pequeño, testeable y útil por sí solo. Orden pensado para que el
valor llegue pronto: primero *saber* (medir), luego *no fallar* (verificar), luego
*sonar mejor* (dinámica/cuerpo), luego *reparar*, luego los dos modos (fusión y
limpieza local), y al final el enhance embebido.

### Fase 1 — Módulo de métricas y QC de entrada ✅ implementada
**Archivos:** `src/metrics.js` (nuevo), `src/pipeline.js` (llamada), `main.js` (evento IPC), renderer (mostrar).
- `analyzeFile(path)`: una pasada FFmpeg con `ebur128+astats+aspectralstats+silencedetect`
  + una pasada de bandas (`asplit` → bandpass múltiple + astats) → objeto `{ loudness,
  truePeak, lra, crest, noiseFloor, dcOffset, rolloff, bands, silences, flags[] }`.
- Implementar detectores A1, A8, A11, A12, A13, A14 (los deterministas) con umbrales
  en un solo objeto `QC_THRESHOLDS` comentado.
- UI: fila de archivo muestra chips con el código de flag tal cual (p. ej. `CLIP`,
  `HUM`, `NO_AIR`) y tooltip con el detalle medido.
- **Aceptación:** procesar los WAV sintéticos del corpus (Fase 9 seed) produce
  exactamente los flags esperados; cero falsos positivos sobre el corpus limpio.

### Fase 2 — Presets de plataforma + verificación de salida ✅ implementada
**Archivos:** `src/pipeline.js`, `main.js` (schema settings), renderer (selector).
- `DELIVERY_PRESETS`, selector UI, normalización bidireccional (con opción legacy).
- Post-render: re-medir I/TP con `ebur128` (`verifyOutput` en `pipeline.js`) y
  adjuntarlo como `verify: {i, tp, badge}` al evento `file:done` (no un evento
  `file:verified` separado, ni un campo `delta`, ni LRA). Badge de solo dos
  estados, `ok`/`warn` (no hay un tercer estado `fail`): `ok` si |I − target| ≤
  0.7 LU **y** TP ≤ techo + 0.3 dB; `warn` en cualquier otro caso, incluido el
  fallo de medición.
- **Aceptación:** los 3 presets aterrizan dentro de esas tolerancias sobre el
  corpus; el chip de verificación aparece en la fila del archivo y en el informe
  QC exportable.

### Fase 3 — Dinámica: nivelador + limitador ✅ implementada
**Archivos:** `src/pipeline.js`.
- `acompressor` condicional a LRA de entrada; `alimiter` siempre (techo del preset).
- Exponer "Compresión: auto / off" en settings.
- **Aceptación:** archivo con LRA 14 LU termina ≤ 8 LU sin bombeo audible (revisión
  A/B); archivo con LRA 5 LU pasa sin compresión (flag A14 respetado).

### Fase 4 — Cuerpo y presencia ✅ implementada
**Archivos:** `src/pipeline.js`, renderer (slider "Cuerpo").
- Rama paralela de cuerpo (asplit/acompressor/amix) con peso 0–0.5.
- Shelf de aire condicional al rolloff (A13). `aexciter` opcional detrás de un toggle
  "Presencia extra" (default off — primero validar a oído).
- **Aceptación:** con "Cuerpo" al 30 %, `cuerpo_ratio` del master sube ≥ 2 dB vs
  cuerpo 0 %, sin cambiar el LUFS integrado (±0.3) ni el TP.

### Fase 5 — Reparación condicional ✅ implementada (parcial — ver honestidad de estado)
**Archivos:** `src/metrics.js` (detectores A1/`CLIP`, A8/`HUM`, A11/`SILENCE_HEAD`+`SILENCE_TAIL`), `src/pipeline.js` (inserción condicional).
- Condicional de verdad: `adeclip` si A1 (`CLIP`), `bandreject` (notch + 2º armónico)
  si A8 (`HUM`), trim de cabeza/cola si A11 (`SILENCE_HEAD`/`SILENCE_TAIL`), de-esser
  dinámico si hay sibilancia medida (`SIBILANT`, o forzado en Settings).
- `adeclick` corre **sin condición, en todos los archivos** — no existe un detector
  directo de A9 (clicks de boca), así que en vez de esperar uno que puede que nunca
  llegue, se dejó siempre activo (parámetros por defecto, seguros para voz). Esto
  rompe la invariante "bit-a-bit idéntico si nada se detecta" para este filtro en
  particular — verificado localmente: incluso una señal limpia (seno sintético)
  cambia algunos bytes al pasar por `adeclick`, por falsos positivos mínimos de su
  propio detector interno. El resto de la cadena condicional sí respeta la invariante.
- **HPF dinámico si A7 — no implementado.** No hay detector de plosivos (A7); la
  frecuencia del HPF es un valor fijo de Settings (80 Hz por defecto), igual para
  todos los archivos, no un ajuste dinámico por archivo. Sigue en el backlog.
- Cada reparación condicional queda registrada en el log y en el informe del archivo.
- **Aceptación (ajustada a lo anterior):** corpus sintético con cada artefacto
  inyectado → el master sale sin el artefacto (métricas antes/después en el informe);
  los archivos limpios salen con la misma cadena condicional que Fase 4 **salvo
  `adeclick`**, que se inserta siempre.

### Fase 6 — Modo 2: emparejado + fusión con el original ✅ implementada
**Archivos:** `src/pipeline.js`, `src/pairing.js` (nuevo), `main.js`, renderer (emparejado + slider "Original").
- Emparejado por nombre/duración con reconocimiento de la convención
  `X.wav ↔ Enhanced/X.wav` de `adobe-podcast-batch` (§3): soltar la carpeta del lote
  activa Modo 2 automáticamente. Verificación por tolerancia de duración (±0.5 s);
  fallback a Modo 1 sobre el **original** si no coincide (ver honestidad de estado
  en §2.4 — probablemente debería caer sobre el enhanced en vez del original).
  (Verificación real de alineación/fase por `axcorrelate` sigue sin integrar, §2.4.)
- Estrategias de fusión: bandas (`acrossover`, default), cama (`amix`) y ambas
  combinadas (`bands_bed`). Slider "Original: 0–40 %" + selector de estrategia; el
  balance es un ajuste del usuario, no todavía sugerido por detectores de cada
  fuente (esa parte de §2.4 sigue en el backlog).
- **Aceptación:** con un par real (original + enhanced 100 % de Adobe), la fusión por
  bandas devuelve un master cuyos silencios contienen la respiración del original y
  cuyo `cuerpo_ratio` ≥ el del enhanced solo; sin comb audible en A/B; la carpeta
  `Enhanced/` de `adobe-podcast-batch` se empareja sin intervención manual.

### Fase 7 — Modo 1: limpieza local condicional ✅ implementada
**Archivos:** `src/pipeline.js`, `src/metrics.js` (gate por noise floor), `scripts/fetch-bin.sh` / `.ps1` (modelo `.rnnn`), renderer (indicador).
- `arnndn` (RNNoise, modelo `somnolent-hogwash` ~290 KB) insertado antes de la
  reparación solo si `Noise_floor` > umbral; `mix` escalado con el exceso de ruido
  (§2.5). **Corrección de orden**: en `pipeline.js` el denoise corre *antes* del
  notch de hum (denoise → reparación, que incluye el notch), no al revés como
  decía una versión anterior de este párrafo.
- **No implementado todavía**: el informe QC no compara piso de ruido antes/después
  ni tiene una recomendación "considerar Modo 2" — el evento `qc` solo lleva los
  flags (código + detalle) y el loudness de entrada. Sigue en el backlog si se
  quiere ese nivel de feedback en Modo 1.
- **Aceptación:** grabación cruda con ruido de fondo (corpus) baja su piso ≥ 10 dB
  sin voz acuosa audible en A/B; material limpio pasa **bit-a-bit idéntico** (gate
  cerrado, filtro ni siquiera se inserta).

### Fase 8 — UX de control de calidad ✅ implementada
**Archivos:** `renderer/js/eq-editor.js`, `renderer/js/app.js`, `src/spectrogram.js`
(nuevo), `src/qc-report.js` (nuevo), `main.js`/`preload.js` (IPC), `renderer/index.html`,
`renderer/styles/app.css`.
- ✅ Hecho: chips de flags QC por archivo (`renderer/js/app.js` → `renderFlagChips`),
  badge de modo ("Pair detected" / "Mode 2 · fused" / "Mode 1 · pair mismatch") y
  chip de verificación post-render
  (I/TP re-medidos, badge ok/warn) junto a cada archivo de la cola.
- ✅ Hecho: A/B con **nivel igualado** en el editor EQ — `analyzeSpectrum` (FFT offline,
  ya existente para el auto-fit) se reutiliza para calcular una ganancia de
  compensación entre la curva EQ y el espectro de la fuente (`computeGainCompensationDb`
  / `updateGainCompensation`), aplicada a un nodo `makeupGain` en el grafo de Web Audio
  y mostrada como lectura en vivo ("level-matched (+N dB)") junto al toggle Bypass.
  Se recalcula al cambiar de fuente y al mover cualquier banda.
- ✅ Hecho: A/B de tres vías en Modo 2 (`original` / `enhanced` / `fusión`) — selector
  de tres botones en la barra del editor EQ, visible solo si el archivo tiene par.
  "Fusión" pide un render on-demand vía IPC (`fusion:preview`, cacheado en `main.js`
  por ruta + hash de ajustes de fusión) y hace un hot-swap del `<audio>` preservando
  posición/estado de reproducción para comparar sin perder el punto de escucha.
- ✅ Hecho: espectrograma opcional por archivo — `src/spectrogram.js` genera un PNG con
  `showspectrumpic` vía IPC (`spectrogram:generate`), mostrado en un modal desde el
  menú contextual del archivo ("Ver espectrograma"); los temporales se limpian al
  cerrar el modal y al salir de la app.
- ✅ Hecho: exportar informe QC del lote en Markdown — `src/qc-report.js` construye
  una tabla resumen + detalle por archivo (flags, verificación I/TP, errores) a
  partir del estado de la cola; el botón "Exportar informe QC" en la barra de
  Processing abre el diálogo nativo de guardado vía IPC (`qc:saveReport`).
- Verificado con un smoke test de UI (Playwright sobre CDP contra la app Electron real
  bajo Xvfb): detección de par → toggle de tres vías por defecto en "Fusión" → resolución
  de la fusión → cambio a "Original" re-ajusta el auto-fit y la ganancia de compensación
  → arrastrar una banda real recalcula la ganancia en vivo (+4.9 dB → +4.1 dB tras subir
  una banda ~11.7 dB) → menú contextual → espectrograma → export de informe QC dispara
  el diálogo nativo.
- **Aceptación:** A/B no cambia de loudness percibido (medición: misma M máx ±0.5 LU) —
  cumplido: la ganancia de compensación se deriva del propio espectro de cada fuente,
  no de un valor fijo.

### Fase 9 — Corpus de validación y regresión ✅ implementada (corpus sintético; corpus real pendiente)
**Archivos:** `test/` (nuevo), `package.json` (script `npm test`), fixtures generadas con ffmpeg.
- ✅ Hecho: corpus sintético generado por script (`test/fixtures.js`, vía `lavfi`):
  limpio, ruidoso, hum, sibilante, recortado, sin aire, aplastado, silencios de
  cabeza/cola, DC offset. 33 tests (`node:test`) cubren cada detector, conformidad de
  presets, invariantes del render (duración, formato, LUFS/TP), emparejado Modo 2 y
  el gate del denoise Modo 1 — más Mode 1/Mode 2 end-to-end y cancelación. Corren con
  `npm test` (ver `.github/workflows/test.yml`, en cada push/PR a `main`).
- ⏳ Pendiente: **pedir a Daniel 5–10 clases reales en pares** (original + enhanced
  100 %) como corpus privado no versionado — sigue siendo la D4 abierta (§5); sin él
  los umbrales de `QC_THRESHOLDS` quedan calibrados contra el corpus sintético, no
  contra voz real.
- **Aceptación:** suite verde; añadir un artefacto nuevo al corpus rompe el test hasta
  implementar su detector.

### Fase 10 — "Un solo proceso": enhance embebido (Nivel 2 de §3.1) ⏳ no iniciada
**Archivos:** `src/enhance/` (motor phonos compartido), `main.js` (login Adobe + token), renderer (estados remotos en la cola).
- Incorporar `phonos.js` + compuerta de créditos de `batch.js` (idealmente como
  paquete compartido con `adobe-podcast-batch` para no bifurcar el motor).
- Flujo: arrastrar solo originales → subir a Adobe (5 en paralelo, espera de créditos
  automática) → descargar voz 100 % → Fase 6 (fusión) → master. Toggle "Enhance con
  Adobe" en la toolbar; sin token → se ofrece el login embebido.
- **Aceptación:** un lote de 3 originales crudos termina en 3 masters verificados sin
  intervención; si Adobe corta por créditos, la cola espera y reanuda sola; sin red o
  sin token, el lote degrada a Modo 1 con aviso.

**Dependencias:** 1 → 2 → 3 → 4 → 5 → {6, 7} (independientes entre sí); 8 y 9 pueden
avanzar en paralelo desde la Fase 2; 10 requiere 6 y la decisión D6 (§5).

---

## 5. Decisiones abiertas (responder antes o durante Fase 2)

- **D1 — Nivel Platzi**: ¿−16 LUFS mono está bien, o Platzi/producción pide otra cosa?
  **Experimento propuesto**: tomar una clase ya publicada en Platzi, medir su audio
  (`ffmpeg -i clase.mp4 -af ebur128 -f null -`) y fijar el target/offset del preset
  con ese dato real.
- **D2 — Mono → video**: confirmar cómo inserta producción el WAV en el video (¿dual-mono
  sin pan law? → el master mono debería apuntar ~3 LU más abajo). Mismo experimento de
  arriba lo responde.
- **D3 — SOP del equipo para Modo 2** *(reformulada: la decisión "100 % + original"
  ya está tomada)*: fijar por escrito que en `adobe-podcast-batch` el slider "Voz
  limpia" queda al **100 %** y que se conservan los originales junto a `Enhanced/`.
  Pregunta abierta: ¿agregar en `adobe-podcast-batch` un preset/lock "modo AudioPro"
  para que nadie lo mueva por accidente?
- **D4 — Corpus real**: necesito 5–10 pares (original + enhanced **al 100 %**) de
  profesores distintos (voz grave/aguda, con/sin acento marcado) para calibrar
  umbrales de detectores, defaults de "Cuerpo" y el balance por defecto de la fusión.
  Sin esto, los umbrales quedan en valores de literatura.
- **D5 — Alcance de "salida a video"**: ¿AudioPro debe exportar también AAC/MP4 listo
  para pegar en Premiere, o el WAV es siempre el entregable?
- **D6 — Enhance embebido (Fase 10)**: ¿de acuerdo con asumir el riesgo del endpoint
  interno dentro de AudioPro (mismo riesgo que ya corre `adobe-podcast-batch`)?
  ¿Extraemos `phonos.js` a un paquete compartido entre ambas apps, o copiamos el
  módulo y lo sincronizamos a mano? Recomendación: paquete compartido — un solo motor
  que arreglar cuando Adobe cambie algo.

---

## 6. Apéndice: comandos validados en este entorno (ffmpeg 6.1.1)

Todos ejecutados y verificados en su momento. Los de detección (loudness,
clipping, rolloff, hum, silencios) son la base directa de `src/metrics.js` y sus
parámetros siguen alineados. Los de reparación/dinámica/de-esser/fusión de más
abajo demuestran que la técnica funciona en este FFmpeg — **los parámetros finales
de producción se afinaron durante la implementación y viven en `src/pipeline.js` /
`src/fusion.js`, no necesariamente coinciden con estos ejemplos** (p. ej. la
compresión paralela de cuerpo real usa `threshold=-28dB:ratio=6:attack=8:release=280:makeup=8`,
no los valores del ejemplo aislado de abajo). Ante una duda sobre el comportamiento
actual, el código en `src/` es la fuente de verdad; este apéndice es el registro de
que la técnica es viable en ffmpeg, no una copia sincronizada de la configuración final.

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

# Fusión por bandas original+enhanced — Modo 2 (validado; recombinación plana ±0.2 dB)
ffmpeg -i original.wav -i enhanced.wav -filter_complex \
  "[0]acrossover=split=200:order=4th[olo][ohi];[1]acrossover=split=200:order=4th[elo][ehi];\
   [ohi]anullsink;[elo]anullsink;[olo][ehi]amix=inputs=2:normalize=0,alimiter=limit=0.891:level=false" out.wav

# Denoise local RNNoise — Modo 1 (validado: piso −26.7 → −44.6 dB; mix=0.6 → −32.6 dB)
# Modelo: rnnoise-models "somnolent-hogwash" (~290 KB, dominio público). Requiere 48 kHz.
ffmpeg -i in.wav -af "arnndn=m=sh.rnnn:mix=1" out.wav

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
- Código fuente de `adobe-podcast-batch` (github.com/DanielGutierrezB/adobe-podcast-batch):
  `phonos.js` (cliente Enhance), `batch.js` (workers + compuerta de créditos),
  `enhance.js` (convención `Enhanced/`), revisados para §3.
- RNNoise (Valin, 2018) y modelos `rnnoise-models` de GregorR (dominio público):
  motor del denoise local del Modo 1 vía `arnndn`.
