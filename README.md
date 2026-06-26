# Webgl-compare

A lightweight, dependency-light **web viewer to compare 3D point clouds** with a
draggable *before/after* slider — and a 4-quadrant mode to inspect four clouds at
once. Built with **vanilla JavaScript + three.js** (no Potree, no build step).

It loads **PLY, LAS, LAZ and NPZ** directly in the browser, and is designed for
**LiDAR change-detection** workflows: compare two epochs (T0 / T1) and their
aligned counterparts (T0_A / T1_A), each loaded as a file, side by side.

> The UI labels are in French; the code is fully commented (French). Everything
> else is language-agnostic.

<!-- Replace with a real screenshot or GIF once you run it -->
<!-- ![screenshot](docs/screenshot.png) -->

---

## ✨ Features

- 🪟 **Before/after slider** — pixel-perfect split using a single renderer + one
  shared camera (no camera-sync drift).
- 🔳 **4-view mode (adaptive)** — with **4 clouds**: four quadrants (T0, T1, T0_A,
  T1_A) via vertical **and** horizontal sliders. With **2 clouds**: left/right shows
  the two clouds while top/bottom become two labeled bands you choose.
- 🪄 **Smart drag & drop** — drop 1–4 clouds anywhere; files are auto-assigned to
  `T0 / T1 / T0_A / T1_A` by name, with fallback to the next empty slot.
- 📦 **Direct loaders** for `.ply` (ASCII + binary, little/big-endian), `.las`
  (uncompressed, double-precision coords), `.laz` (compressed) and `.npz`
  (NumPy archive).
- 🎨 **Color modes** — original RGB, flat color, or *T0 blue / T1 red*.
- 🧭 **Orbit controls**, point-size control, reset view, fullscreen.
- 🐛 **Debug panel** — active mode, recenter offset, point counts, detected scalar
  fields, file paths.
- 🚀 **Big-data friendly** — global recentering for UTM-scale precision, screen-
  space point size, lean scenes.

---

## 🚀 Quick start

A static HTTP server is required (ES modules + `fetch`):

```bash
git clone https://github.com/betch130/Webgl-compare.git
cd Webgl-compare
python -m http.server 8080
```

Open <http://localhost:8080/>, then load a cloud into **T0** and another into
**T1** with the file buttons.

> First load needs internet: three.js (and, only for LAZ/NPZ, loaders.gl / fflate)
> are fetched from a CDN. For PLY/LAS only, no CDN call beyond three.js — see
> [Offline use](#-offline-use).

---

## 📥 Loading data

**Drag & drop** (recommended): drop one or several files anywhere on the page.
Each cloud is auto-assigned to a slot from its filename (`t0`, `t1`, `t0_A`,
`t1_A`, also `pointCloud0/1`, `pc0/1`, …); anything unrecognized fills the next
empty slot in order.

> Tick **“Demander l'assignation”** to get a dialog after each drop where you
> choose the slot for every file (pre-filled with the smart guess) — otherwise
> assignment is fully automatic.

**Buttons** `T0`, `T1`, `T0_A`, `T1_A` accept any `.ply / .las / .laz / .npz`.
Every cloud is loaded **as-is** from its file (no in-app transform).

- Load **all four** files → 4-view mode shows four quadrants.
- Load **only T0 and T1** → the two-up modes work, and 4-view mode switches to the
  *labeled-bands* layout (left/right = the two clouds, top/bottom = two chosen labels).

**Auto-load**: drop files named `t0.*`, `t1.*`, `t0_A.*`, `t1_A.*` into
`pointclouds/` and they load on startup.

### Supported formats

| Format | Notes |
|--------|-------|
| **PLY** | ASCII + binary, **little- and big-endian**. Reads `x,y,z`, `red/green/blue` (or `r,g,b`), and **every other property as a scalar field**. |
| **LAS** | Uncompressed. Custom parser keeping **double-precision** coordinates (LAS scale/offset honored). RGB for point formats 2/3/5/7/8/10. |
| **LAZ** | Compressed, decoded via [loaders.gl](https://loaders.gl) (lazy-loaded from CDN). |
| **NPZ** | NumPy archive. Positions from `xyz`/`points`/`coords`/`vertices` **(N,3)**; color from `rgb`/`colors` **(N,3)**; any 1-D array of length N becomes a scalar field. |

> ℹ️ An NPZ must contain coordinates (`xyz`). NPZ files that store only labels/
> masks (no coordinates) cannot be displayed on their own.

---

## 🧭 Comparison modes

Pick a mode from the dropdown.

**Two-up (vertical slider):**

| Mode | Left | Right |
|------|------|-------|
| `T0 ⇄ T1` | T0 | T1 |
| `T0_A ⇄ T1_A` | T0_A | T1_A |
| `T0 ⇄ T0_A` | T0 | T0_A |
| `T1 ⇄ T1_A` | T1 | T1_A |

**4-view (vertical + horizontal slider) — adaptive to the number of clouds:**

*With 4 clouds — quadrants:*

```
┌───────────┬───────────┐
│    T0     │    T1     │
├───────────┼───────────┤   ← drag horizontal slider ↕
│   T0_A    │   T1_A    │
└───────────┴───────────┘
        ↑ drag vertical slider ↔
```

*With 2 clouds — labeled bands:* left/right shows the two clouds (vertical slider),
while the top and bottom bands carry two labels picked from the loaded files (two
dropdowns appear in the toolbar).

```
┌────── label (top) ──────┐
│     T0     │     T1     │
├────────────┼────────────┤   ← horizontal slider = band divider
│     T0     │     T1     │
└───── label (bottom) ────┘
        ↑ vertical slider compares the two clouds ↔
```

All views share one camera, so they stay perfectly aligned while you orbit/zoom.

Controls: **left-drag** rotate · **wheel** zoom · **right-drag** pan ·
**drag handles** to move sliders (mouse + touch).

---

## 🧠 How it works

Instead of two stacked viewers with synchronized cameras, this app uses **one
`WebGLRenderer`, one camera, and the WebGL scissor test**:

1. Each layer lives in its own lightweight `THREE.Scene`.
2. The renderer draws each scene into a rectangular region (left/right halves, or
   four quadrants) clipped by `scissor`.
3. Because the **camera is shared**, all regions are inherently aligned — no
   per-frame sync, no drift.

Coordinates are recentered by a global offset (the first cloud's bounding-box
center) before being uploaded as `Float32` — this avoids the precision jitter you
get when feeding raw UTM coordinates to the GPU.

---

## ⚡ Performance / large datasets

- Global recentering + `Float32` upload (no UTM jitter).
- `sizeAttenuation: false` (constant screen-space points), `frustumCulled: false`.
- One renderer; scenes hold a single `THREE.Points` each.
- Millions of points are fine on a modern GPU. For very large clouds, decimate at
  export time or add a load-time subsample in `makeLayer()` (keep 1 point in *k*).

---

## 🔌 Offline use

By default three.js / loaders.gl / fflate come from a CDN. To run fully offline:

1. Vendor three r160 (`three.module.js` + `examples/jsm/`) into `vendor/three/`
   and update the `importmap` in `index.html`.
2. For LAZ: `npm i @loaders.gl/core @loaders.gl/las` and replace the
   `https://esm.sh/...` imports in `loaders.js` with local paths.
3. For NPZ: same with `fflate`.

If you only use **PLY** and **LAS**, both are parsed in-house — the sole remote
dependency is three.js.

---

## 🛠️ Troubleshooting — clouds don't overlap

1. **Align upstream** — alignment is no longer done in the app. If T0 and T1 have
   different origins (UTM tiles), bake the registration into the exported
   `T0_A` / `T1_A` clouds, or convert everything to a shared origin before loading.
2. **Identity check** — pick `T0 ⇄ T0_A`; if `T0_A` is the aligned T0, the two
   halves should match where they overlap.
3. **Wrong file** — the debug panel lists each layer's format, point count, path
   and detected scalar fields.

---

## 🎨 Customization

| What | Where (`app.js`) |
|------|------------------|
| T0 / T1 colors | `COL_T0`, `COL_T1` |
| Default / range point size | `CFG.pointSize`, `setPointSize()` |
| Slider reveal direction | `setScissor(...)` in `renderSplit()` |
| 4-view layout (2 vs 4 clouds) | `quadLayout()` |
| Scalar-field coloring | scalars are already loaded in `layer.data.scalars` |

---

## 📁 Project structure

```
.
├── index.html        # page, import map (three.js), file pickers, sliders
├── style.css         # UI styling
├── app.js            # viewer: camera, scissor split, modes, sliders, UI
├── loaders.js        # PLY / LAS / LAZ / NPZ → unified format
├── pointclouds/      # optional auto-loaded t0.* / t1.* / t0_A.* / t1_A.*
└── README.md
```

---

## 🌐 Browser support

Any modern browser with WebGL2 and ES-module support (Chrome, Edge, Firefox,
Safari). Touch is supported for sliders.

---

## 🤝 Contributing

Issues and PRs welcome. Keep it dependency-light and framework-free.

---

## 📄 License

MIT © 2026 Kibalou Betchaleel BANAKINAO — see [`LICENSE`](LICENSE).

## 🙏 Acknowledgements

- [three.js](https://threejs.org/) — rendering
- [loaders.gl](https://loaders.gl/) — LAS/LAZ decoding
- [fflate](https://github.com/101arrowz/fflate) — NPZ (zip) decompression
