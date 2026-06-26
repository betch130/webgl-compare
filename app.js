/* ============================================================================
 * app.js — Comparateur Before/After 3D, maison (three.js, sans Potree)
 * ----------------------------------------------------------------------------
 * UN seul renderer + UNE caméra partagée. Le split before/after est fait au
 * SCISSOR TEST : on rend la scène du bas en plein cadre, puis la scène du haut
 * uniquement à droite du slider. Caméra partagée ⇒ alignement parfait, aucune
 * synchronisation nécessaire.
 *
 * 4 calques chargés depuis des fichiers : T0, T1, T0_A, T1_A.
 * Formats : PLY / LAS / LAZ / NPZ (voir loaders.js).
 * ==========================================================================*/

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { loadPointCloud } from "./loaders.js";

/* ----------------------------- Configuration ----------------------------- */
const CFG = {
  // tentatives d'auto-chargement au démarrage (sinon : file pickers)
  autoload: {
    t0:  ["./pointclouds/t0.ply",   "./pointclouds/t0.las",   "./pointclouds/t0.laz",   "./pointclouds/t0.npz"],
    t1:  ["./pointclouds/t1.ply",   "./pointclouds/t1.las",   "./pointclouds/t1.laz",   "./pointclouds/t1.npz"],
    t0a: ["./pointclouds/t0_A.ply", "./pointclouds/t0_A.las", "./pointclouds/t0_A.laz", "./pointclouds/t0_A.npz"],
    t1a: ["./pointclouds/t1_A.ply", "./pointclouds/t1_A.las", "./pointclouds/t1_A.laz", "./pointclouds/t1_A.npz"],
  },
  pointSize: 2.0,
  bg: 0x0e1116,
};

/* 4 calques réels : T0, T1, T0_A, T1_A (chacun chargé depuis son propre fichier). */
const MODES = {
  raw:   { bottom: "T0",   top: "T1",   left: "T0",   right: "T1" },
  trans: { bottom: "T0_A", top: "T1_A", left: "T0_A", right: "T1_A" },
  t0:    { bottom: "T0",   top: "T0_A", left: "T0",   right: "T0_A" },
  t1:    { bottom: "T1",   top: "T1_A", left: "T1",   right: "T1_A" },
};

const COL_T0 = new THREE.Color(0x3b82f6);
const COL_T1 = new THREE.Color(0xef4444);
const COL_FIXED = new THREE.Color(0xdddddd);

/* ------------------------------- État global ------------------------------- */
const S = {
  renderer: null, camera: null, controls: null,
  scenes: {},                // name → THREE.Scene (une scène par layer)
  layers: {},                // name → { points, data, source, path }
  mode: "raw",
  colorMode: "rgb",
  askAssign: false,          // drag&drop : true = demander, false = auto
  pointSize: CFG.pointSize,
  sliderRatio: 0.5,          // slider vertical (x, 0..1 depuis la gauche)
  sliderRatioY: 0.5,         // slider horizontal (y, 0..1 depuis le haut) — mode quad
  offset: null,              // THREE.Vector3 (recentrage global, double→float)
  // mode "4 vues" à 2 nuages : slot choisi pour le label de chaque bande (haut/bas)
  quadLabels: { top: "T0", bottom: "T1" },
  // données brutes + chemins (4 fichiers réels).
  raw: { t0: null, t1: null, t0a: null, t1a: null },
};

/** Disposition des 4 quadrants selon le nombre de nuages chargés.
 *  4 nuages → quadrants distincts (comportement historique).
 *  2 nuages (T0, T1) → gauche=T0 / droite=T1 répétés en haut et en bas : la colonne
 *  montre les 2 nuages (slider vertical), la bande haut/bas ne porte que les labels. */
function quadLayout() {
  const has4 = !!(S.layers.T0_A && S.layers.T1_A);
  return has4
    ? { TL: "T0", TR: "T1", BL: "T0_A", BR: "T1_A" }
    : { TL: "T0", TR: "T1", BL: "T0",   BR: "T1"   };
}

/* ============================================================================
 * 2) CONSTRUCTION D'UN LAYER (THREE.Points)
 * ==========================================================================*/

/** Calcule le centre (Vector3) d'un Float64Array de positions. */
function centerOf(positions) {
  let minx=Infinity,miny=Infinity,minz=Infinity,maxx=-Infinity,maxy=-Infinity,maxz=-Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x=positions[i],y=positions[i+1],z=positions[i+2];
    if(x<minx)minx=x; if(y<miny)miny=y; if(z<minz)minz=z;
    if(x>maxx)maxx=x; if(y>maxy)maxy=y; if(z>maxz)maxz=z;
  }
  return new THREE.Vector3((minx+maxx)/2, (miny+maxy)/2, (minz+maxz)/2);
}

/** Construit un THREE.Points à partir des données chargées.
 *  Recentre par S.offset (fixé par le 1er nuage) et passe en Float32 pour le GPU. */
function buildPoints(data) {
  if (!S.offset) S.offset = centerOf(data.positions);
  const off = S.offset;
  const n = data.count;

  const pos32 = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos32[i*3]   = data.positions[i*3]   - off.x;
    pos32[i*3+1] = data.positions[i*3+1] - off.y;
    pos32[i*3+2] = data.positions[i*3+2] - off.z;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(pos32, 3));

  // Couleur RGB (si dispo) en attribut normalisé 0..1
  if (data.colors) {
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) col[i] = data.colors[i] / 255;
    geom.setAttribute("color", new THREE.BufferAttribute(col, 3));
  }
  geom.computeBoundingSphere();

  const mat = new THREE.PointsMaterial({
    size: S.pointSize,
    sizeAttenuation: false,         // taille constante à l'écran (overview)
    vertexColors: !!data.colors,
    color: data.colors ? 0xffffff : 0xbbbbbb,
  });

  const points = new THREE.Points(geom, mat);
  points.frustumCulled = false;     // on garde tout visible
  return points;
}

/** Charge un fichier/URL → données, construit le THREE.Points. */
async function makeLayer(name, sourceOrData) {
  const data = sourceOrData.positions ? sourceOrData : await loadPointCloud(sourceOrData, name);
  const points = buildPoints(data);
  S.layers[name] = { points, data, source: data.source, path: typeof sourceOrData === "string" ? sourceOrData : (sourceOrData.name || "(fichier)") };
}

/* ============================================================================
 * 3) (RE)CONSTRUIRE LES 4 LAYERS à partir de T0 et T1 bruts
 * ==========================================================================*/

async function rebuildLayers() {
  S.layers = {};
  S.offset = null; // recalculé sur le 1er nuage construit

  // T0 / T1 : toujours requis (déclencheurs de la reconstruction)
  await makeLayer("T0", S.raw.t0.data);
  await makeLayer("T1", S.raw.t1.data);
  S.layers.T0.path = S.raw.t0.path;
  S.layers.T1.path = S.raw.t1.path;

  // T0_A / T1_A : construits UNIQUEMENT si leur fichier est fourni (plus de synthèse)
  if (S.raw.t0a) { await makeLayer("T0_A", S.raw.t0a.data); S.layers.T0_A.path = S.raw.t0a.path; }
  if (S.raw.t1a) { await makeLayer("T1_A", S.raw.t1a.data); S.layers.T1_A.path = S.raw.t1a.path; }

  // Une scène dédiée par calque PRÉSENT (on choisit les scènes au rendu)
  S.scenes = {};
  for (const n of ["T0", "T1", "T0_A", "T1_A"]) {
    if (!S.layers[n]) continue;
    const sc = new THREE.Scene();
    sc.add(S.layers[n].points);
    S.scenes[n] = sc;
  }

  setMode(S.mode);
  fitView();
  updateDebug();
}

/* ============================================================================
 * 4) MODE DE COMPARAISON
 * ==========================================================================*/

/** Nom de fichier seul (sans chemin) d'un layer, "" si absent. */
function layerFileName(name) {
  const p = S.layers[name] && S.layers[name].path;
  return p ? p.split(/[\\/]/).pop() : "";
}

/** Chip de coin : juste le nom de fichier (le slot est porté par la légende du slider). */
function setLabel(id, slot) {
  const el = document.getElementById(id);
  const file = layerFileName(slot);
  el.style.display = file ? "" : "none";   // masqué tant que rien n'est chargé
  el.innerHTML = "";
  if (!file) return;
  const f = document.createElement("span");
  f.className = "ll-file"; f.textContent = file; f.title = slot + " — " + file;
  el.appendChild(f);
}

/** Une puce de légende de slider (texte + classe couleur). */
function capChip(text, cls) {
  const s = document.createElement("span");
  s.className = "cap-side" + (cls ? " " + cls : "");
  s.textContent = text;
  return s;
}

/** Texte d'un slot : nom de fichier si chargé, sinon le tag du slot en repli. */
function slotText(slot) { return layerFileName(slot) || slot; }

/** Remplit les 2 menus de choix de label (mode 4 vues à 2 nuages) avec les nuages
 *  chargés (texte = nom de fichier, valeur = slot), en conservant un choix valide. */
function populateBandPickers() {
  const loaded = ["T0", "T1", "T0_A", "T1_A"].filter((n) => S.layers[n]);
  for (const [id, key] of [["label-top-pick", "top"], ["label-bottom-pick", "bottom"]]) {
    const sel = document.getElementById(id);
    sel.innerHTML = "";
    for (const n of loaded) {
      const o = document.createElement("option");
      o.value = n; o.textContent = slotText(n);
      sel.appendChild(o);
    }
    const want = loaded.includes(S.quadLabels[key]) ? S.quadLabels[key] : (loaded[0] || "");
    S.quadLabels[key] = want; sel.value = want;
  }
}

/** Met à jour le texte affiché des deux bandes (haut/bas) depuis les slots choisis. */
function updateQuadBands() {
  document.getElementById("quad-band-top").textContent = slotText(S.quadLabels.top);
  document.getElementById("quad-band-bottom").textContent = slotText(S.quadLabels.bottom);
}

/** Légende attachée à chaque slider : ce qu'on voit de part et d'autre.
 *  Vertical → gauche/droite ; horizontal (quad) → haut/bas.
 *  Le texte est dérivé des noms de fichiers (repli : tag du slot). */
function setSliderCaptions(key) {
  const capV = document.getElementById("cap-v");
  const capH = document.getElementById("cap-h");
  capV.innerHTML = ""; capH.innerHTML = "";
  const epoch = (slot) => (slot.startsWith("T0") ? "t0" : "t1");

  if (key === "quad") {
    const has4 = !!(S.layers.T0_A && S.layers.T1_A);
    if (has4) {
      // 4 nuages : légendes historiques (tags de slot) — comportement inchangé
      capV.append(capChip("◀ T0", "t0"), capChip("T1 ▶", "t1"));
      capH.append(capChip("▲ T0 · T1", "raw"), capChip("T0_A · T1_A ▼", "acc"));
    } else {
      // 2 nuages : colonnes = les 2 nuages ; bandes haut/bas = labels choisis
      capV.append(capChip("◀ " + slotText("T0"), "t0"), capChip(slotText("T1") + " ▶", "t1"));
      capH.append(capChip("▲ " + slotText(S.quadLabels.top), "raw"),
                  capChip(slotText(S.quadLabels.bottom) + " ▼", "acc"));
    }
  } else {
    const m = MODES[key];
    capV.append(capChip("◀ " + slotText(m.left), epoch(m.left)),
                capChip(slotText(m.right) + " ▶", epoch(m.right)));
  }
}

function setMode(key) {
  if (!S.layers.T0) return;            // pas encore chargé
  S.mode = key;
  const stage = document.getElementById("stage");

  if (key === "quad") {
    const has4 = !!(S.layers.T0_A && S.layers.T1_A);
    const q = quadLayout();
    stage.classList.add("quad-mode");
    stage.classList.toggle("quad-2pc", !has4);   // 2 nuages : bandes étiquetées
    setLabel("label-tl", q.TL);
    setLabel("label-tr", q.TR);
    setLabel("label-bl", q.BL);
    setLabel("label-br", q.BR);
    if (!has4) { populateBandPickers(); updateQuadBands(); }
    document.getElementById("quad-ctl").classList.toggle("show", !has4);
  } else {
    // comparaison 2-à-2 classique
    stage.classList.remove("quad-mode");
    stage.classList.remove("quad-2pc");
    document.getElementById("quad-ctl").classList.remove("show");
    const m = MODES[key];
    setLabel("label-left",  m.left);
    setLabel("label-right", m.right);
  }

  setSliderCaptions(key);
  applyColorMode();
  updateDebug();
}

/* ============================================================================
 * 5) COULEURS
 * ==========================================================================*/

function setLayerColor(name, kind, color) {
  const L = S.layers[name];
  if (!L) return;
  const mat = L.points.material;
  if (kind === "rgb") {
    mat.vertexColors = !!L.data.colors;
    mat.color.set(L.data.colors ? 0xffffff : 0xbbbbbb);
  } else {
    mat.vertexColors = false;
    mat.color.copy(color);
  }
  mat.needsUpdate = true;
}

function applyColorMode() {
  // layers concernés : les 4 en mode quad, sinon la paire du mode — calques présents only
  const names = ((S.mode === "quad")
    ? ["T0", "T1", "T0_A", "T1_A"]
    : [MODES[S.mode].bottom, MODES[S.mode].top]).filter((n) => S.layers[n]);
  for (const n of names) {
    if (S.colorMode === "rgb")        setLayerColor(n, "rgb");
    else if (S.colorMode === "fixed") setLayerColor(n, "fixed", COL_FIXED);
    else                              setLayerColor(n, "fixed", n.startsWith("T0") ? COL_T0 : COL_T1);
  }
}

/* ============================================================================
 * 6) CAMÉRA / RENDU (scissor split)
 * ==========================================================================*/

function initThree() {
  const stage = document.getElementById("stage");
  S.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  S.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  S.renderer.setClearColor(CFG.bg, 1);
  S.renderer.autoClear = false;
  stage.appendChild(S.renderer.domElement);

  S.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1e7);
  S.camera.position.set(0, -50, 50);

  S.controls = new OrbitControls(S.camera, S.renderer.domElement);
  S.controls.enableDamping = true;
  S.controls.dampingFactor = 0.08;

  resize();
  window.addEventListener("resize", resize);
  // suit toute variation de taille du stage (layout flex, fullscreen, scroll…)
  if (window.ResizeObserver) new ResizeObserver(() => resize()).observe(stage);
  animate();
}

function resize() {
  const stage = document.getElementById("stage");
  const w = stage.clientWidth, h = stage.clientHeight;
  S.renderer.setSize(w, h, false);
  S.camera.aspect = w / Math.max(h, 1);
  S.camera.updateProjectionMatrix();
}

function animate() {
  requestAnimationFrame(animate);
  S.controls.update();
  if (!S.layers.T0) { S.renderer.clear(true, true, true); return; }
  if (S.mode === "quad") renderQuad();
  else renderSplit();
}

/** Rend une scène dans une région (coords three : origine en bas-à-gauche). */
function renderRegion(scene, x, y, w, h) {
  if (!scene || w <= 0 || h <= 0) return;   // scène absente (calque non chargé) : on saute
  S.renderer.setScissorTest(true);
  S.renderer.setViewport(0, 0, S.renderer.domElement.clientWidth, S.renderer.domElement.clientHeight);
  S.renderer.setScissor(x, y, w, h);
  S.renderer.clearDepth();
  S.renderer.render(scene, S.camera);
}

/** Comparaison 2-à-2 : bas plein cadre + haut révélé à droite du slider vertical. */
function renderSplit() {
  const w = S.renderer.domElement.clientWidth;
  const h = S.renderer.domElement.clientHeight;
  const m = MODES[S.mode];

  S.renderer.setScissorTest(false);
  S.renderer.setViewport(0, 0, w, h);
  S.renderer.clear(true, true, true);
  if (S.scenes[m.bottom]) S.renderer.render(S.scenes[m.bottom], S.camera);

  const sx = Math.round(S.sliderRatio * w);
  renderRegion(S.scenes[m.top], sx, 0, w - sx, h);
  S.renderer.setScissorTest(false);
}

/** 4 quadrants : slider vertical (x) + horizontal (y). */
function renderQuad() {
  const w = S.renderer.domElement.clientWidth;
  const h = S.renderer.domElement.clientHeight;
  const sx = Math.round(S.sliderRatio * w);          // depuis la gauche
  const syTop = Math.round(S.sliderRatioY * h);      // depuis le haut (DOM)

  // fond
  S.renderer.setScissorTest(false);
  S.renderer.setViewport(0, 0, w, h);
  S.renderer.clear(true, true, true);

  // three : y=0 en bas → la bande "haut" commence à y = h - syTop
  const q = quadLayout();
  renderRegion(S.scenes[q.TL], 0,  h - syTop, sx,     syTop);        // haut-gauche
  renderRegion(S.scenes[q.TR], sx, h - syTop, w - sx, syTop);        // haut-droite
  renderRegion(S.scenes[q.BL], 0,  0,         sx,     h - syTop);    // bas-gauche
  renderRegion(S.scenes[q.BR], sx, 0,         w - sx, h - syTop);    // bas-droite
  S.renderer.setScissorTest(false);
}

/** Cadre la caméra sur les nuages affichés. */
function fitView() {
  // cadre sur T0 (toujours présent) — valable aussi en mode quad
  const L = S.layers.T0;
  if (!L) return;
  const sph = L.points.geometry.boundingSphere;
  if (!sph) return;
  const r = sph.radius || 10;
  const c = sph.center;
  S.controls.target.copy(c);
  S.camera.near = r / 1000;
  S.camera.far  = r * 1000;
  S.camera.updateProjectionMatrix();
  // place la caméra en oblique
  S.camera.position.set(c.x + r * 1.2, c.y - r * 1.6, c.z + r * 1.2);
  S.controls.update();
}

/* ============================================================================
 * 7) SLIDER (souris + tactile, Pointer Events)
 * ==========================================================================*/

function setupSlider() {
  const stage = document.getElementById("stage");

  // Slider vertical (déplacement horizontal → révèle gauche/droite)
  setupOneSlider(
    document.getElementById("slider"),
    (e) => (e.clientX - stage.getBoundingClientRect().left) / stage.getBoundingClientRect().width,
    (r) => { S.sliderRatio = clamp01(r); document.getElementById("slider").style.left = pct(S.sliderRatio); }
  );

  // Slider horizontal (déplacement vertical → quadrants, mode quad)
  setupOneSlider(
    document.getElementById("slider-h"),
    (e) => (e.clientY - stage.getBoundingClientRect().top) / stage.getBoundingClientRect().height,
    (r) => { S.sliderRatioY = clamp01(r); document.getElementById("slider-h").style.top = pct(S.sliderRatioY); }
  );

  // positions initiales
  document.getElementById("slider").style.left = pct(S.sliderRatio);
  document.getElementById("slider-h").style.top = pct(S.sliderRatioY);
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const pct = (r) => (r * 100).toFixed(3) + "%";

/** Branche le drag (souris + tactile) sur un élément slider. */
function setupOneSlider(el, ratioFromEvent, apply) {
  let dragging = false;
  el.addEventListener("pointerdown", (e) => {
    dragging = true; el.setPointerCapture(e.pointerId);
    apply(ratioFromEvent(e)); e.preventDefault();
  });
  el.addEventListener("pointermove", (e) => {
    if (dragging) { apply(ratioFromEvent(e)); e.preventDefault(); }
  });
  const stop = (e) => { dragging = false; try { el.releasePointerCapture(e.pointerId); } catch (_) {} };
  el.addEventListener("pointerup", stop);
  el.addEventListener("pointercancel", stop);
}

/* ============================================================================
 * 8) UI (boutons, file pickers)
 * ==========================================================================*/

function setupUI() {
  document.getElementById("mode").addEventListener("change", (e) => setMode(e.target.value));

  document.getElementById("toolbar").addEventListener("click", (e) => {
    const btn = e.target.closest("button"); if (!btn) return;
    switch (btn.dataset.action) {
      case "reset": fitView(); break;
      case "rgb":   S.colorMode = "rgb";   applyColorMode(); updateDebug(); break;
      case "fixed": S.colorMode = "fixed"; applyColorMode(); updateDebug(); break;
      case "t0t1":  S.colorMode = "t0t1";  applyColorMode(); updateDebug(); break;
      case "size-plus":  setPointSize(S.pointSize * 1.4); break;
      case "size-minus": setPointSize(S.pointSize / 1.4); break;
      case "fullscreen": toggleFullscreen(); break;
    }
  });

  // File pickers (4 nuages réels)
  document.getElementById("file-t0").addEventListener("change",  (e) => onFile("t0",  e.target.files[0]));
  document.getElementById("file-t1").addEventListener("change",  (e) => onFile("t1",  e.target.files[0]));
  document.getElementById("file-t0a").addEventListener("change", (e) => onFile("t0a", e.target.files[0]));
  document.getElementById("file-t1a").addEventListener("change", (e) => onFile("t1a", e.target.files[0]));

  // Réglage drag&drop : demander l'assignation, ou auto
  document.getElementById("ask-assign").addEventListener("change", (e) => { S.askAssign = e.target.checked; });

  // Choix des labels de bande (mode 4 vues à 2 nuages)
  document.getElementById("label-top-pick").addEventListener("change", (e) => {
    S.quadLabels.top = e.target.value; updateQuadBands(); setSliderCaptions(S.mode);
  });
  document.getElementById("label-bottom-pick").addEventListener("change", (e) => {
    S.quadLabels.bottom = e.target.value; updateQuadBands(); setSliderCaptions(S.mode);
  });
}

async function onFile(which, file) {
  if (!file) return;                       // which ∈ t0 | t1 | t0a | t1a
  setStatus(`chargement ${file.name}…`);
  const data = await loadPointCloud(file, file.name);
  S.raw[which] = { data, path: file.name };
  // On (re)construit dès que T0 et T1 sont présents ; t0a/t1a sont pris en compte
  // automatiquement s'ils sont chargés (sinon les calques _A restent absents).
  if (S.raw.t0 && S.raw.t1) await rebuildLayers();
  else setStatus(`${which} chargé (${data.count.toLocaleString()} pts). Charge au moins T0 et T1.`);
}

function setPointSize(s) {
  S.pointSize = Math.max(0.5, Math.min(12, s));
  for (const k in S.layers) S.layers[k].points.material.size = S.pointSize;
  updateDebug();
}

function toggleFullscreen() {
  const card = document.getElementById("card");
  if (!document.fullscreenElement) card.requestFullscreen?.();
  else document.exitFullscreen?.();
}

/* ============================================================================
 * 8b) DRAG & DROP INTELLIGENT
 * --------------------------------------------------------------------------
 * Dépose 1 à 4 nuages n'importe où. Chaque fichier est assigné à un slot selon
 * son nom ; les fichiers non reconnus remplissent les slots vides dans l'ordre
 * T0, T1, T0_A, T1_A.
 * ==========================================================================*/

const SLOT_LABEL = { t0: "T0", t1: "T1", t0a: "T0_A", t1a: "T1_A" };

/** Devine le slot depuis le nom de fichier (null si inconnu). */
function classifySlot(name) {
  const n = name.toLowerCase().replace(/\.(ply|las|laz|npz)$/i, "");
  if (/(^|[^0-9])0[ _-]?a\b/.test(n) || /t0[ _-]?a/.test(n)) return "t0a";
  if (/(^|[^0-9])1[ _-]?a\b/.test(n) || /t1[ _-]?a/.test(n)) return "t1a";
  if (/t0|pointcloud0|cloud0|pc0|[ _-]0(\b|[ _.-])/.test(n)) return "t0";
  if (/t1|pointcloud1|cloud1|pc1|[ _-]1(\b|[ _.-])/.test(n)) return "t1";
  return null;
}

function hasFiles(e) {
  return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
}

/** Devine un mapping slot→fichier (nom + repli sur slots vides). */
function autoAssignMap(clouds) {
  const order = ["t0", "t1", "t0a", "t1a"];
  const map = {};
  for (const f of clouds) {
    let slot = classifySlot(f.name);
    if (slot && map[slot]) slot = null;
    if (!slot) slot = order.find(s => !map[s] && !S.raw[s]) || order.find(s => !map[s]);
    if (slot) map[slot] = f;
  }
  return map;
}

/** Charge un mapping slot→fichier. */
async function loadAssignments(map) {
  const order = ["t0", "t1", "t0a", "t1a"];
  const msgs = [];
  for (const slot of order) {
    const f = map[slot];
    if (!f) continue;
    try {
      const data = await loadPointCloud(f, f.name);
      S.raw[slot] = { data, path: f.name };
      msgs.push(`${SLOT_LABEL[slot]} ← ${f.name}`);
    } catch (e) {
      msgs.push(`⚠️ ${f.name} : ${e.message}`);
    }
  }
  if (S.raw.t0 && S.raw.t1) await rebuildLayers();
  setStatus("Assignation : " + (msgs.join("   |   ") || "(rien)") +
            (S.raw.t0 && S.raw.t1 ? "" : "  —  il faut au moins T0 et T1."));
}

/** Point d'entrée du drop : auto, ou ouverture du dialogue selon le réglage. */
function handleDrop(files) {
  const clouds = files.filter(f => /\.(ply|las|laz|npz)$/i.test(f.name));
  if (!clouds.length) { setStatus("Aucun fichier exploitable déposé."); return; }
  if (S.askAssign) openAssignDialog(clouds);
  else loadAssignments(autoAssignMap(clouds));
}

/** Boîte de dialogue : choisir le slot de chaque fichier (pré-rempli par la devinette). */
function openAssignDialog(clouds) {
  const modal = document.getElementById("assign-modal");
  const body = document.getElementById("assign-rows");
  const guess = autoAssignMap(clouds);
  const fileSlot = new Map();
  for (const s in guess) fileSlot.set(guess[s], s);

  const OPTS = [["t0","T0"],["t1","T1"],["t0a","T0_A"],["t1a","T1_A"],["","(ignorer)"]];
  body.innerHTML = "";
  clouds.forEach((f, i) => {
    const row = document.createElement("div");
    row.className = "assign-row";
    const name = document.createElement("span");
    name.className = "fname"; name.textContent = f.name;
    const sel = document.createElement("select");
    sel.dataset.idx = i;
    for (const [v, t] of OPTS) {
      const o = document.createElement("option");
      o.value = v; o.textContent = t; sel.appendChild(o);
    }
    sel.value = fileSlot.get(f) || "";
    row.append(name, sel);
    body.appendChild(row);
  });
  modal.classList.add("show");
  const ok = document.getElementById("assign-ok");
  const cancel = document.getElementById("assign-cancel");
  const close = () => { modal.classList.remove("show"); ok.onclick = cancel.onclick = null; };
  cancel.onclick = () => { close(); setStatus("Assignation annulée."); };
  ok.onclick = async () => {
    const map = {};
    body.querySelectorAll("select").forEach((sel) => {
      if (sel.value) map[sel.value] = clouds[+sel.dataset.idx];  // dernier gagne si doublon
    });
    close();
    await loadAssignments(map);
  };
}

function setupDragDrop() {
  const overlay = document.getElementById("drop-overlay");
  let depth = 0;                                   // compteur pour éviter le clignotement
  window.addEventListener("dragenter", (e) => { if (hasFiles(e)) { depth++; overlay.classList.add("show"); } });
  window.addEventListener("dragover",  (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) overlay.classList.remove("show"); });
  window.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; overlay.classList.remove("show");
    await handleDrop([...e.dataTransfer.files]);
  });
}

/* ============================================================================
 * 9) DEBUG
 * ==========================================================================*/

function setStatus(msg) { document.getElementById("debug").textContent = msg; }

function updateDebug() {
  const L = S.layers;
  const has4 = !!(L.T0_A && L.T1_A);
  const desc = (S.mode === "quad")
    ? (has4 ? "T0 | T1 | T0_A | T1_A (quadrants)" : "T0 | T1 (4 vues, 2 nuages — bandes étiquetées)")
    : `${MODES[S.mode].left}  ▸  ${MODES[S.mode].right}`;
  const out = [];
  out.push(`mode actif    : ${S.mode}  (${desc})`);
  out.push(`couleur       : ${S.colorMode}     taille point : ${S.pointSize.toFixed(2)} px`);
  out.push(`offset (recentrage) : ${S.offset ? `[${S.offset.x.toFixed(1)}, ${S.offset.y.toFixed(1)}, ${S.offset.z.toFixed(1)}]` : "—"}`);
  out.push("");
  out.push("layers :");
  for (const k of ["T0","T1","T0_A","T1_A"]) {
    if (L[k]) {
      const sc = Object.keys(L[k].data.scalars || {});
      out.push(`  ${k.padEnd(5)} : ${L[k].source.toUpperCase().padEnd(4)} ${String(L[k].data.count).padStart(9)} pts  ${L[k].path}` +
               "  (fichier)" +
               (sc.length ? `  scalaires=[${sc.join(",")}]` : ""));
    } else {
      out.push(`  ${k.padEnd(5)} : —  (non chargé)`);
    }
  }
  document.getElementById("debug").textContent = out.join("\n");
}

/* ============================================================================
 * 10) INIT + auto-chargement
 * ==========================================================================*/

async function tryAutoload() {
  // nuages t0/t1 (premier chemin qui répond)
  async function firstExisting(cands) {
    for (const u of cands) { try { if ((await fetch(u, { method: "HEAD" })).ok) return u; } catch (_){} }
    return null;
  }
  const t0 = await firstExisting(CFG.autoload.t0);
  const t1 = await firstExisting(CFG.autoload.t1);
  if (t0 && t1) {
    setStatus("auto-chargement…");
    S.raw.t0 = { data: await loadPointCloud(t0, t0), path: t0 };
    S.raw.t1 = { data: await loadPointCloud(t1, t1), path: t1 };
    // fichiers transformés explicites s'ils existent
    const t0a = await firstExisting(CFG.autoload.t0a);
    const t1a = await firstExisting(CFG.autoload.t1a);
    if (t0a) S.raw.t0a = { data: await loadPointCloud(t0a, t0a), path: t0a };
    if (t1a) S.raw.t1a = { data: await loadPointCloud(t1a, t1a), path: t1a };
    await rebuildLayers();
    return true;
  }
  return false;
}

async function init() {
  initThree();
  setupSlider();
  setupUI();
  setupDragDrop();
  try {
    const ok = await tryAutoload();
    if (!ok) setStatus("Prêt. Charge un nuage T0 et un nuage T1 (.ply/.las/.laz/.npz) via les boutons en haut.");
  } catch (e) {
    console.error(e);
    setStatus("ERREUR : " + e.message);
  }
}

window.addEventListener("DOMContentLoaded", init);
