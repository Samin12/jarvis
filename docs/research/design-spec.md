# Jarvis HUD — Design Spec (extracted from jarvis-hud-1.0.1)

Source: `/Users/saminyasar/Jarvis gpt/jarvis-hud-1.0.1/`
Files read: `app/globals.css`, `app/layout.tsx`, `components/HUD.tsx`, `components/GraphCore.tsx`, `components/EmberCore.tsx`, `components/DitherCore.tsx`, `components/ui/dithering-shader.tsx`, `components/OrbLab.tsx`, `lib/voiceClient.ts`.

This spec is complete enough to rebuild the aesthetic in a Vite + React app with no access to the original.

---

## 1. Design identity in one paragraph

"Nocturnal reactor-control." A near-black stage with a living 3D particle orb at center. There are **no panel boxes** — text floats directly on edge gradients ("scrims") over the orb. Structure comes from 1px hairlines; hierarchy comes from typography (giant display numerals + tiny tracked-out mono micro-labels). Every chrome accent on screen derives from **one CSS variable, `--accent-h`**, a hue that the orb writes to `document.documentElement` every frame as its color slowly voyages around the spectrum (~70s per lap). The chrome is a desaturated echo of the core. It is explicitly NOT Iron-Man blue: the resting family is warm terracotta/ember, but the hue travels.

---

## 2. Color palette — copy-pasteable CSS variables

```css
:root {
  /* --accent-h is written by the orb renderer every frame (0–360).
     ALL chrome accents derive from it. Default/boot value: 223. */
  --accent-h: 223;

  /* base */
  --bg:        oklch(0.13 0.004 270);   /* near-black, slightly cool */
  --ink:       oklch(0.9 0.004 270);    /* primary text */
  --ink-dim:   oklch(0.62 0.005 270);   /* secondary text */
  --ink-faint: oklch(0.43 0.004 270);   /* tertiary/labels */

  /* accent family — hue-linked to the orb */
  --ember:      hsl(var(--accent-h) 50% 62%);  /* the workhorse accent */
  --ember-hot:  hsl(var(--accent-h) 65% 72%);  /* brighter accent */
  --ember-deep: hsl(var(--accent-h) 55% 30%);  /* dark accent (gradients) */
  --white-hot:  hsl(var(--accent-h) 40% 90%);  /* near-white tinted accent */

  /* fixed semantic hues (do NOT follow the voyage) */
  --cobalt: oklch(0.62 0.17 265);  /* listening state */
  --ok:     var(--ember);
  --warn:   oklch(0.78 0.13 80);   /* stale data / speaking chip */
  --err:    oklch(0.62 0.22 30);   /* errors, failures */
  --mock:   oklch(0.48 0.01 50);   /* simulated/mock data */

  /* hairlines — accent-tinted, translucent */
  --line:       hsl(var(--accent-h) 50% 60% / 0.25);
  --line-faint: hsl(var(--accent-h) 50% 60% / 0.12);
}

::selection { background: var(--ember); color: var(--bg); }
```

Hex constants used inside the renderers (not CSS):

| Purpose | Value |
|---|---|
| GraphCore scene background | `#0a0909` |
| EmberCore / DitherCore scene background | `#0b0807` |
| GraphCore halo / bg glow sprite | `#1d3fb8` |
| GraphCore dust points | `#7a8cc8` |
| GraphCore floor grid lines | `#2f5ce0` |
| GraphCore nebula fog | `#16307a` |
| Ember accent (idle orb, dust) | `#d97757` |
| DitherCore mode colors | idle `#d97757`, working `#ffb347`, listening `#5577ff`, speaking `#ffc94a`, error `#ff4d3d` |
| EmberCore idle palette | cold `#5c1d0c`, hot `#e8703a`, white `#ffe3bd` |
| EmberCore working | cold `#8a3410`, hot `#ffb347`, white `#fff4e0` |
| EmberCore listening | cold `#0c2160`, hot `#4a6cfa`, white `#cfe0ff` |
| EmberCore speaking | cold `#6e430c`, hot `#ffc94a`, white `#fff2cc` |
| EmberCore error | cold `#5e0808`, hot `#ff4d3d`, white `#ffd9d4` |

GraphCore's error state locks the HSL hue to `0.015` (≈ 5.4° — red-orange).

### The hue-voyage mechanism (the signature trick)

Inside the orb's rAF loop:

```js
// hue: 0..1, starts at 0.62 (reference blue)
if (mode !== "error") hue = (hue + dt * (0.014 * feel.hueRate + level * 0.05)) % 1;
const h = mode === "error" ? 0.015 : hue;
const deg = Math.round(h * 360);
if (deg !== lastDeg) {           // write only on change
  lastDeg = deg;
  document.documentElement.style.setProperty("--accent-h", String(deg));
}
```

0.014/sec base rate ≈ 71s per full lap. Speech (`level`) nudges it faster. Every `hsl(var(--accent-h) …)` in the CSS follows automatically — panel borders, glows, hairlines, all of it breathes with the orb.

---

## 3. Typography

Loaded via `next/font/google` in the original (use Fontsource or `@font-face` in Vite):

```ts
Big_Shoulders  → CSS var --font-display   // condensed display, numerals & wordmark
Martian_Mono   → CSS var --font-mono      // everything else
```

```css
html, body {
  font-family: var(--font-mono), monospace;
  font-size: 11px;                 /* GLOBAL base is 11px */
  -webkit-font-smoothing: antialiased;
  background: var(--bg);
  color: var(--ink);
  overflow: hidden;                /* the HUD never scrolls */
  height: 100%;
}
```

Type scale (all mono unless noted "display" = Big Shoulders):

| Role | Font | Size | Weight | Tracking | Case | Color |
|---|---|---|---|---|---|---|
| Wordmark ("V.A.U.L.T.") | display | 34px | 600 | 0.34em | caps | --white-hot |
| Wordmark expansion line | mono | 7.5px | 400 | 0.3em | caps | --ink-faint |
| Clock HH:MM | display | 52px | 300 | 0.06em, tabular-nums | — | --ink |
| Clock :SS | display | 30px | 400 | — | — | --ember |
| Objective giant number | display | 84px | 500 | 0.02em, tabular-nums, line-height 0.95 | — | --white-hot |
| Vital / stat values | display | 30px | 500 | 0.04em, tabular-nums | — | --ink |
| Diag values | display | 15px | 500 | 0.05em | — | --ink |
| Section titles | mono | 8px | 500 | 0.32em | caps | --ember |
| Section tick (right of title) | mono | 7.5px | 400 | 0.08em | caps | --ink-faint |
| Micro-labels (vital label, obj-label) | mono | 8px | 400 | 0.2–0.34em | caps | --ink-dim / --ember |
| Feed / body rows | mono | 8.5–9.5px | 400 | normal–0.12em | — | --ink-dim |
| Tags (SIM, NOW, age) | mono | 7px | 400 | 0.1–0.18em | caps | varies |
| Buttons (transcript, clear) | mono | 8.5px | 400 | 0.28em | caps | --ink-dim |

Rule of thumb: **the smaller the text, the wider the tracking** (7–9px text carries 0.1–0.34em letter-spacing, always uppercase). Big numerals are `font-variant-numeric: tabular-nums` everywhere so they don't jitter when counting up.

---

## 4. Stage composition & layering (z-index map)

```
.stage            position:fixed; inset:0                    — root
  orb canvas      z-index: 1   (absolute, inset 0, fullscreen)
  .bg-vignette    (inside orb layer) radial-gradient(ellipse 75% 70% at 50% 44%,
                   transparent 55%, oklch(0.06 0.003 270 / 0.7) 100%)
  .scrim ×4       z-index: 2   — legibility gradients, pointer-events:none
  .hud grid       z-index: 5   — all panels
  .callout(s)     z-index: 5   — cards branching off the orb (position:fixed)
  .callout-clear  z-index: 6
  .transcript-btn z-index: 6   (fixed, left:28px bottom:28px)
  .grain          z-index: 11  — film grain, pointer-events:none
  .report-overlay z-index: 60  — modal doc/transcript viewer
```

### Scrims (the "no boxes" trick)

Text sits directly on the 3D scene; legibility comes from four edge gradients, not panels:

```css
.scrim { position:absolute; z-index:2; pointer-events:none; }
.scrim-l { inset:0 auto 0 0; width:30vw;
  background: linear-gradient(90deg, oklch(0.1 0.003 270 / 0.85), transparent); }
.scrim-r { inset:0 0 0 auto; width:30vw;
  background: linear-gradient(270deg, oklch(0.1 0.003 270 / 0.85), transparent); }
.scrim-b { inset:auto 0 0 0; height:32vh;
  background: linear-gradient(0deg, oklch(0.1 0.003 270 / 0.9), transparent); }
.scrim-t { inset:0 0 auto 0; height:14vh;
  background: linear-gradient(180deg, oklch(0.1 0.003 270 / 0.75), transparent); }
```

### Film grain (the "scanline" texture)

One fixed overlay using an inline SVG turbulence tile at 4.5% opacity — this is what gives the whole screen its analog CRT feel:

```css
.grain {
  position:absolute; inset:0; z-index:11; pointer-events:none; opacity:0.045;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E");
}
```

There is no literal scanline animation; the "alive screen" feel = grain + hue voyage + blinking dots + the dither shader's ~10fps grain re-roll (see §7).

### Glow language

- Status dots: `box-shadow: 0 0 6–8px currentColor` on 3–4px circles.
- Panel highlight (voice-hot): border + inset glow + `text-shadow: 0 0 12px hsl(var(--accent-h) 70% 62% / 0.55)` on the title.
- Callout cards: `box-shadow: 0 0 24px hsl(var(--accent-h) 60% 55% / 0.18)`.
- Report panel: `box-shadow: 0 0 60px hsl(var(--accent-h) 60% 50% / 0.18)`.
- The orb's glow is real UnrealBloom post-processing, not CSS.

---

## 5. HUD grid layout

```css
.hud {
  position:absolute; inset:0; z-index:5;
  display:grid;
  grid-template-columns: 320px 1fr 320px;   /* left rail · orb · right rail */
  grid-template-rows: auto 1fr auto;        /* topbar · body · objective */
  gap: 24px;
  padding: 28px 36px 26px;
  pointer-events: none;                     /* panels re-enable */
}
.hud > * { pointer-events:auto; min-height:0; }
.hud-top    { grid-column: 1 / -1; }        /* full-width top bar */
.hud-left,
.hud-right  { display:flex; flex-direction:column; gap:30px; min-height:0; }
.hud-center { pointer-events:none; display:flex; align-items:flex-end;
              justify-content:center; padding-bottom:28px; }
.hud-bottom { grid-column: 1 / -1; display:flex; justify-content:center; align-items:end; }
```

Panel placement (each panel is a `<section class="block">`, no visual box):

- **Top bar** (3-col grid `1fr auto 1fr`): wordmark+expansion (left), status chips (center), giant clock + date (right).
- **Left rail** (320px): System Vitals (metric rows with sparklines) → Directives (checkbox top-3) → Documents trail.
- **Right rail** (320px): Command Deck (2-col button grid) → Schedule → Audio I/O (36-bar wave) → AI Wire headlines.
- **Bottom center**: Primary Objective — 84px number, 2px gradient progress bar, sub-stats row.
- **Center**: reserved for the orb + up to 4 "callout" cards anchored around it.

Section headings are purely typographic with a fading hairline:

```css
.sec-title { display:flex; align-items:baseline; gap:10px;
  font-size:8px; font-weight:500; letter-spacing:0.32em;
  text-transform:uppercase; color:var(--ember); margin-bottom:14px; }
.sec-title::after { content:""; flex:1; height:1px; align-self:center;
  background: linear-gradient(90deg, var(--line), transparent); }
```

Vital rows: grid `1fr auto`, areas `label/delta · value · spark`, separated by `1px solid var(--line-faint)`; label row has a status dot + age tag; value is a display-font count-up; below sits a 16px-tall SVG sparkline (`viewBox 0 0 100 16`, stroke currentColor 1.2, endpoint dot r=1.8, `preserveAspectRatio="none"`).

---

## 6. Boot choreography

Two-phase ignition: chrome cascades in first, then the orb blooms out of black LAST.

**Phase 1 — panel stagger.** Every panel gets class `.boot-stagger` plus an inline `animation-delay`:

```css
.boot-stagger { opacity:0; animation: boot-in 0.65s cubic-bezier(0.22,1,0.36,1) forwards; }
@keyframes boot-in {
  0%   { opacity:0; transform:translateY(12px); filter:blur(6px); }
  100% { opacity:1; transform:none; filter:blur(0); }
}
```

Delays used (seconds): topbar 0.05 → vitals 0.10 → directives 0.18 → command deck / documents 0.26 → schedule 0.34 → audio I/O 0.42 → AI wire 0.50 → objective 0.58.

**CRITICAL GOTCHA:** never put a second `animation` on a `.boot-stagger` element — it cancels `boot-in … forwards` and the panel stays at `opacity:0`. Any looping pulse goes on a `::before` overlay instead.

**Phase 2 — core ignition.** The orb container starts invisible and ignites at 0.65s (right as the cascade finishes) with overshoot-then-settle brightness, like a reactor lighting:

```css
.graph-core { opacity:0;
  animation: core-ignite 1.4s cubic-bezier(0.22,1,0.36,1) 0.65s forwards; }
@keyframes core-ignite {
  0%   { opacity:0; transform:scale(0.88); filter:blur(16px) brightness(2.2); }
  55%  { opacity:1; filter:blur(3px) brightness(1.35); }
  100% { opacity:1; transform:none; filter:blur(0) brightness(1); }
}
```

The easing `cubic-bezier(0.22, 1, 0.36, 1)` (easeOutQuint-ish) is the house curve — used for boot, ignite, callouts, progress bars.

Numbers animate with a JS count-up: 1400ms, easing `1 - (1-p)^4`, driven by rAF.

`@media (prefers-reduced-motion: reduce)` collapses all animation durations to 0.01ms.

---

## 7. The orb — rendering techniques

Three interchangeable cores exist. **GraphCore is the shipped centerpiece.** All are WebGL (no SVG, no 2D canvas except one generated glow texture).

### 7a. GraphCore (primary) — Three.js volumetric knowledge-graph

Stack: `three` + `EffectComposer` + `RenderPass` + `UnrealBloomPass` + `OutputPass`. Renderer: `antialias:false`, `pixelRatio = min(devicePixelRatio, 1.75)`. Camera: perspective 45°, at `(0, 0, 5.7)`, looking at `(0, 0.32, 0)`. The whole cloud group sits at `y = +0.32` (slightly above center, clear of the bottom objective).

Structure:

1. **Nodes** — 2200 points in a center-dense sphere of radius 1.5. Positions: uniform direction × radius `r = pow(random(), 0.45) * 1.5` (the 0.45 exponent packs points toward the center). Rendered as a `THREE.Points` with a custom ShaderMaterial, `AdditiveBlending`, `depthWrite:false`, `transparent`.
2. **Edges** — each node linked to its 2 nearest neighbors (O(n²) once at init; dedupe pairs). `LineSegments` with `LineBasicMaterial`, opacity ~0.14, additive. Every frame the edge positions are copied from the drifted node positions so links follow.
3. **Halo** — one sprite with a canvas-generated radial glow texture (256px, white core → transparent; stops at 0/0.25/0.6/1 with alpha 1/0.4/0.08/0), additive, opacity 0.09 base, scale 3.0.
4. **Background layers** (toggle key `b`: flat / depth / grid / nebula): big glow sprite at z −2.2 scale 9 opacity 0.07; 420 dust points strictly behind z < −2.5, size 0.018, opacity 0.35, slow z-roll `t*0.008`; a perspective floor grid at y −2.4 (half-width 11, step 0.55, opacity 0.13); a 20×11.5 fbm-noise fog plane at z −3.2 (4-octave value noise, scrolls `(t*0.018, −t*0.011)`, edge-faded, alpha ×0.34).
5. **Bloom** — `UnrealBloomPass(resolution, strength 0.45, radius 0.5, threshold 0.2)`; strength animates to `0.45 + level*0.35` while speaking.

Node vertex shader (key lines):

```glsl
vR = length(position) / 1.50;                       // 0 center → 1 rim
float big = step(0.86, fract(aSeed * 7.13));        // 14% are "hub" nodes
gl_PointSize = (0.5 + big * 0.8) * (58.0 / -mv.z);  // perspective-scaled
```

Node fragment shader (the whole look, in pseudocode):

```glsl
alpha = smoothstep(0.5, 0.22, dist(gl_PointCoord, center));   // soft disc
col   = mix(uInner, uOuter, smoothstep(0.0, 0.95, vR));       // bright core → deep rim
// speaking shimmer: each node offsets ±~40° around the accent hue
off   = (fract(vSeed*3.17)-0.5)*0.22 + 0.04*sin(uTime*0.9 + vSeed*31.0);
col   = mix(col, hsl2rgb(vec3(fract(uHue+off), 0.8, 0.62)), uLevel*0.55);
// white-hot center bleach (applied AFTER shimmer so the heart stays white)
col   = mix(col, vec3(1.0), 0.85 * (1.0 - smoothstep(0.05, 0.5, vR)));
// per-node twinkle on its own clock
alpha *= 0.3 + 0.7*(0.5 + 0.5*sin(uTime*(1.0 + vSeed*2.5) + vSeed*43.0));
// speech ripple: brightness waves travel outward from center per syllable
alpha *= 1.0 + uLevel*0.45*sin(vR*9.0 - uTime*5.5);
gl_FragColor = vec4(col, clamp(alpha,0,1) * 0.55 * uBoost);
```

Palette per frame (lerped at 0.06/frame toward targets): `uInner = HSL(h, 0.65, 0.84)`, `uOuter = HSL(h, 0.85, 0.45)`, edges `HSL(h, 0.8, 0.55)`.

Animation loop (pseudocode — this is the copy-pasteable behavior contract):

```
feel = FEELS[mode]           // idle {speed 1, boost 1, hueRate 1}
                             // working {1.7, 1.25, 2.2}
                             // listening {1.2, 1.1, 0.6}
                             // speaking {1.3, 1.15, 1}
                             // error {1.8, 1.2, 0} (hue frozen on red)
targetLevel = (mode == speaking) ? (realRMS ?? fakeSpeechLevel()) : 0
level += (targetLevel - level) * (rising ? 0.5 : 0.12)   // fast attack, slow release
speed += (feel.speed - speed) * 0.03
simT  += dt * speed          // speed-INTEGRATED clock: mode flips change velocity,
                             // never position (avoids rotation snapping)
hue voyage + CSS var write   (see §2)
per-node drift: live[i] = base[i] + amp[i] * sin(simT * freq[i] + phase[i])
                (amp 0.04–0.09, freq 0.3–0.85 per axis, random phase)
copy node endpoints into edge buffer; mark both attributes needsUpdate
uBoost = feel.boost * (1 + level * 0.6)          // whole-cloud speech pulse
edgeOpacity = 0.11 + 0.05*sin(t*0.7) + level*0.22
haloOpacity = 0.08 + level*0.1
cloud.rotation.y = simT * 0.1
cloud.rotation.x = sin(t*0.07)*0.08 + mouseY*0.25
bloom.strength   = 0.45 + level*0.35
// mouse parallax: target = ((mx/w - .5)*0.6, (my/h - .5)*0.4)
camera.x += (target.x*1.1 - camera.x) * 0.04
camera.y += (-target.y*0.7 - camera.y) * 0.04
camera.lookAt(0, 0.32, 0)
```

Synthetic speech envelope used when no real audio (also used by DitherCore/OrbLab):

```js
function fakeSpeechLevel() {
  const t = performance.now() * 0.001;
  const gate = Math.sin(t * 0.9) > -0.6 ? 1 : 0.08;              // pauses
  const syl  = (0.45 + 0.55*Math.sin(t*6.1)) * (0.4 + 0.6*Math.sin(t*2.3)); // syllables
  return gate * Math.max(0, syl);
}
```

### 7b. DitherCore (alternate centerpiece) — WebGL2 fullscreen dither shader

A single fullscreen-quad WebGL2 fragment shader (no Three.js) drawing a 1-bit-dithered lambert-lit sphere. Square wrapper (shader has no aspect correction):

```css
.dither-core { position:absolute; top:45%; left:50%;
  width:min(74vh, 46vw); aspect-ratio:1; transform:translate(-50%,-50%); z-index:1; }
```

Props: `shape="sphere"`, `type="random"`, `colorBack="#0b0807"`, `colorFront=MODE_COLOR[mode]`, `pxSize=2`, `speed=MODE_SPEED[mode]` (idle 0.9, working 2.4, listening 1.4, speaking 1.8, error 3.2).

Sphere + dithering pseudocode (the essential algorithm):

```glsl
// pixelize: snap frag coords to a pxSize grid (pxSize = 2 * devicePixelRatio)
uv = (floor((fragCoord - .5*res) / px) * px) / res;  uv *= 2.32;   // headroom for swell
// speech: equator swell — gaussian bulge in y, amplitude 0.14 * level
swell = 1. + 0.14 * u_level * exp(-6. * uv.y * uv.y);
sp = uv / swell;
d  = 1. - dot(sp, sp);                    // inside sphere if d > 0
pos = vec3(sp, sqrt(max(d, 0.)));         // implicit sphere normal
lightPos = normalize(vec3(cos(1.5*t), .8, sin(1.25*t)));   // orbiting light
shade = .5 + .5 * dot(lightPos, pos);
shade += 0.12 * u_level * sin(14.*length(sp) - 8.*u_time); // ripple rings on speech
shade *= 1. + 0.22 * u_level;                              // louder = brighter
shade *= step(0., d);                                      // clip to silhouette
// dithering ("random" type): white-noise threshold, re-rolled per pixel
dither = step(hash21(noiseUv), shade) - .5;                // or Bayer 2/4/8 matrix
res1bit = step(.5, shade + dither);                        // 1-bit output
color = colorFront * res1bit + colorBack * (1 - res1bit);
```

Implementation notes from the component: shader compiles ONCE; color/speed/pxSize are live uniforms read from refs each frame (no re-init pop on mode change); front/back colors ease at 0.06/frame; time accumulates `t += dtMs * 0.001 * speed` so speed changes never jump phase; canvas resizes via ResizeObserver, dpr capped at 2. The OrbLab variant (`components/OrbLab.tsx`) additionally re-rolls the dither grain at ~10fps (`noiseUv = px + floor(t*10.)*13.7`) — "living grain" — and demonstrates 10 idle behaviors (breath, turbulent morph, heartbeat pulse+ring, speech waveform, scan band, binary lights, erode, contour bands, corona flares, cursor gaze + blink) selectable by an int uniform, all in one program rendered per-tile with scissor.

### 7c. EmberCore (alternate) — structured Three.js reactor

Four layers, all additive-blended Points with custom shaders + simplex noise, over `#0b0807`, camera 42° at (0, 0.3, 5.4):

- **nucleus**: 3200 points, volume cloud r=0.52 falloff 0.65; noise-displaced (`snoise(pos*4 + t)`, 10% amplitude); audio inflates it (`p *= 1 + uAudio*0.30*rr`); color `mix(hot, white, heat²)` — white-hot heart.
- **shell**: 4200 points on a fibonacci sphere r=1.42; breathes along normals (3.5% noise + `uAudio*0.08`); rim-lit (`vRim = 1-|viewNormal.z|`, `pow(rim, 2.2)` → `mix(cold, hot, rim)`); latitude bands `0.55+0.45*sin(nrm.y*18)`; spectral shimmer `0.5+0.5*cos(2π(t+seed)+{0,.33,.67})` scaled by mode shimmer.
- **ring**: 3600 points, Kepler accretion disc r 1.75–3.0 (density falls outward), thickness gaussian ±0.045, angular velocity `w = 0.55 * r^-1.5 * (0.6 + activity*0.9)` computed in the vertex shader; group tilted `(0.42, 0, −0.14)`.
- **skeleton**: `EdgesGeometry(Icosahedron(0.98, 1))` wireframe, opacity 0.07, counter-rotating.
- 900 far dust points; bloom `UnrealBloomPass(strength 0.9, radius 0.65, threshold 0.0)`; `bloom.strength = (0.85 + activity*0.5 + audio*0.8) * strobe` where error strobes `0.45 + 0.55*max(sin(t*9),0)`.
- Mode palettes lerp at 0.04/frame; audio smooths at 0.25; activity at 0.03.

---

## 8. State visualization (idle / working / listening / speaking / error)

`CoreMode = "idle" | "working" | "listening" | "speaking" | "error"`.

Auto-derivation (HUD.tsx): fetch error → `error`; push-to-talk held OR wake-window open → `listening`; TTS audio playing → `speaking`; runner busy → `working`; else `idle`. Keyboard override 1–5, `0`/Esc back to auto.

**Chrome (top bar mode chip)** — `core · {mode}` with a glowing dot (`.status-dot` 4px, `background:currentColor; box-shadow:0 0 8px currentColor`):

```css
.mode-idle      { color: var(--ember); }
.mode-working   { color: var(--white-hot); }
.mode-listening { color: var(--cobalt); }   /* blue = listening, everywhere */
.mode-speaking  { color: var(--warn); }
.mode-error     { color: var(--err); animation: blip 0.8s ease-in-out infinite; }
@keyframes blip { 0%,100% { opacity:0.25; } 50% { opacity:1; } }
```

**Orb**: mode maps to speed/brightness/hue-rate (GraphCore `FEELS`, §7a) or full palettes (EmberCore/DitherCore). Listening slows the hue voyage (0.6×) and, in the Ember/Dither palettes, goes cobalt-blue. Error = red lock + strobe/blip. Speaking = the audio envelope drives node shimmer, outward brightness ripples, bloom swell, halo swell — a whole-cloud pulse, deliberately **not** a center flash.

**Audio I/O wave** — 36 flex `<i>` bars in a 26px-tall row, each with `--i` index:

```css
.wave i { flex:1; background:var(--ember); opacity:0.55; height:1px; transition:height .3s; }
.wave.live i { animation: wave 1.1s ease-in-out infinite;
               animation-delay: calc(var(--i) * -0.085s); }
.wave.live i:nth-child(3n) { background:var(--ember-hot); animation-duration:0.9s; }
.wave.live i:nth-child(5n) { animation-duration:1.6s; }
@keyframes wave { 0%,100% { height:8%; } 50% { height:85%; } }
/* standby: low slow breathing */
.wave.idle i { animation: wave-idle 3.4s ease-in-out infinite;
               animation-delay: calc(var(--i) * -0.19s); opacity:0.3; }
@keyframes wave-idle { 0%,100% { height:5%; } 50% { height:16%; } }
.wave.cobalt i { background: var(--cobalt); }   /* while listening */
```

**Voice-hot panel choreography** — when the assistant's reply references a panel, that panel gets `.voice-hot` for the duration of speech (+2s grace): title turns bright accent with text-glow, and a `::before` overlay (`inset:-10px -14px`) draws a 1px accent border + top radial wash + inset glow, pulsing:

```css
@keyframes voice-hot-pulse { 0%,100% { opacity:0.55; } 50% { opacity:1; } }
```

**Real speech envelope** (voiceClient.ts): TTS `<audio>` element → `MediaElementSource` → "sheen" chain → `AnalyserNode` (fftSize 1024, smoothingTimeConstant 0.4) → destination. Per frame: `rms = sqrt(mean(((byte-128)/128)²))`, returned as `min(rms * 3.2, 1)`. Consumers ease it with fast-attack 0.5 / soft-release 0.12. The sheen chain (the "Jarvis in the helmet" timbre): highpass 90Hz → peaking 3200Hz +2.5dB Q0.8 → dry gain 1.0 + convolver (0.18s noise impulse, decay 2.8) wet 0.12 → analyser. Utterances queue; browser autoplay requires one click/keypress to unlock; barge-in (Esc / wake word / opening the mic) kills current playback and queue.

---

## 9. Callout cards + transcript UI (the "ring" around the orb)

### Callouts — cards branching off the core

Up to 4 cards anchored around the orb at fixed slots: `slot-0` top-right (`left:66%; top:17vh`), `slot-1` top-left (`34%/17vh`), `slot-2` lower-right (`66%/70vh`), `slot-3` lower-left (`34%/70vh`). Eviction: oldest non-working card yields its slot.

Each callout = two hairline branch segments + a card, choreographed in sequence:

1. `.br-a` horizontal hairline (1px × 4vw) grows OUT from the core side — `scaleX` 0→1 in 0.3s at t+0.05s.
2. `.br-b` vertical riser (1px × 7vh) grows into the card's edge midpoint — `scaleY` 0.24s at t+0.36s.
3. `.callout-box` materializes at t+0.5s: `callout-in 0.4s` (scale 0.85→1, blur 5px→0, fade).
4. Label **types on** at t+0.8s: `max-width:0 → 200px` with `steps(20, end)` over 0.6s (typewriter without JS).
5. File/meta line fades in at t+1.35s.

```css
.callout .br { position:absolute; background:var(--line);
  box-shadow: 0 0 6px hsl(var(--accent-h) 55% 60% / 0.3); }
.callout-box { display:flex; align-items:center; gap:10px;
  min-width:160px; max-width:215px; padding:9px 10px 9px 12px;
  background: oklch(0.15 0.005 270 / 0.92);
  border:1px solid var(--line); border-left:2px solid var(--ember);
  backdrop-filter: blur(4px);
  box-shadow: 0 0 24px hsl(var(--accent-h) 60% 55% / 0.18); }
.callout-dot { width:7px; height:7px; border:1px solid var(--ember);
  transform: rotate(45deg);                       /* diamond */
  background: hsl(var(--accent-h) 60% 60% / 0.35);
  animation: voice-hot-pulse 1.6s ease-in-out infinite; }
```

Card anatomy: pulsing diamond dot · label (9.5px caps 0.24em, --white-hot) over filename (8px, --ink-faint, ellipsized) · `×` dismiss. Task variant adds a 2px progress bar (`--ember` fill + glow, `width` transitions 1s linear toward elapsed/eta capped 95%; no ETA → 35%-wide indeterminate sweep 1.6s) and a stopwatch line (`0:42 · working`). Done → left border + dot + bar go `--ok`; failed → `--err`. Timed reveals: callouts pop as speech reaches their sentence, scheduled at ~13 chars/sec from utterance start.

### Transcript / report overlay

Bottom-left fixed button (`TRANSCRIPT`, 8.5px caps 0.28em, 1px `--line` border, `padding:6px 14px`; hover → `--white-hot` text + `--ember` border). Opens the same overlay used for documents:

```css
.report-overlay { position:fixed; inset:0; z-index:60;
  display:flex; align-items:center; justify-content:center;
  background: oklch(0.08 0.01 270 / 0.38);   /* light dim — orb stays visible */
  backdrop-filter: blur(1.5px); }
.report-panel { width:min(720px, 86vw); max-height:78vh;
  display:flex; flex-direction:column;
  background: oklch(0.13 0.012 270 / 0.96);
  border:1px solid hsl(var(--accent-h) 60% 62% / 0.35);
  box-shadow: 0 0 60px hsl(var(--accent-h) 60% 50% / 0.18); }
```

Head: title (11px caps 0.22em `--ember`) · path (8px `--ink-faint`, ellipsized) · optional action button (hover turns `--err` — destructive) · `×`. Body: 11px mono, line-height 1.7; h2–h5 restyled as 10px caps accent labels; links `--cobalt`; code `--ember-hot`; hr = `--line` hairline. Esc closes.

### Feed lines (telemetry/mini-transcript)

Bottom-anchored column (`justify-content:flex-end`), 8.5px, line-height 1.6, each row `[hh:mm:ss] text` with the timestamp in `--ink-faint`; classes `.ok` → `--ember`, `.err` → `--err`, `.sys` → `--ink`. New lines animate in:

```css
@keyframes tline-in { from { opacity:0; transform:translateY(4px); } to { opacity:1; } }
```

Rows are `white-space:nowrap; overflow:hidden; text-overflow:ellipsis`. Feed keeps the last ~30 lines. Voice lines are logged as `you · {transcript}` (sys) and `jarvis · {reply}` (ok).

---

## 10. Interaction details worth copying

- **Hold Space** = push-to-talk (min hold 350ms / min blob 1KB to filter accidental taps); **Esc** = barge-in stop + close overlay; keys **1–5/0** = mode override; **b** cycles orb background (flat/depth/grid/nebula).
- Mouse parallax on the orb only (±0.6/±0.4 normalized, eased 0.04) — HUD chrome never moves.
- Deck buttons: transparent, hairline-bottom rows; hover reveals a `→` arrow sliding in and a faint warm wash `oklch(0.67 0.13 40 / 0.08)`; fired state blinks `blip 1.2s` and label swaps to "QUEUED" with a 15s cooldown.
- Progress bars are always 2px tall, `--line-faint` track, gradient fill `linear-gradient(90deg, var(--ember-deep), var(--ember-hot), var(--white-hot))`, width transition `1.6s cubic-bezier(0.22,1,0.36,1)`.
- Data-freshness language: age tags (`7m`, `3h`, `2d`) turn `--warn` when stale; stale vitals dim to 0.45 opacity; mock data gets a bordered 7px `SIM` tag in `--mock`.
- Everything checkbox-like uses `■`/`□` glyphs; bullets are `▸` in `--ember`.

---

## 11. Vite + React rebuild checklist

1. **Deps**: `three` (+ examples/jsm postprocessing), fonts via `@fontsource/big-shoulders` + `@fontsource/martian-mono` (map to `--font-display` / `--font-mono`).
2. Drop in the `:root` variable block (§2), base `html,body` rules (§3), scrims + grain + vignette (§4), grid (§5), boot keyframes (§6).
3. Port GraphCore nearly verbatim (§7a) — it's self-contained: one `useEffect`, refs for mode/bgMode/getLevel so the loop never re-inits; dispose everything on unmount. Have it write `--accent-h` to `document.documentElement`.
4. Wire mode from app state (§8) and a `getLevel()` that reads an AnalyserNode RMS off whatever TTS audio element you use (fallback: `fakeSpeechLevel()`).
5. Panels are plain sections with `.boot-stagger` + staggered inline delays. Remember: no second animation on those nodes; pulses live on `::before`.
6. Callout/overlay CSS is pure copy-paste (§9); callout state machine: max 4 slots, dedupe by target, task→doc morph in place.
7. Global font-size is 11px and the app is `overflow:hidden` fullscreen — design assumes a desktop viewport, min ~1280px wide (two fixed 320px rails).
