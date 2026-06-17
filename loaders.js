/* ============================================================================
 * loaders.js — chargeurs de nuages de points (sans Potree, sans three)
 * ----------------------------------------------------------------------------
 * Formats supportés :
 *   - .ply   : ASCII + binaire little/big-endian (parser maison)
 *   - .las   : LAS non compressé (parser maison, coords en double précision)
 *   - .laz   : LAS compressé (via loaders.gl, chargé à la demande depuis un CDN)
 *   - .npz   : archive numpy (via fflate) ; cherche xyz/points + rgb + scalaires
 *
 * Chaque loader renvoie un objet UNIFORME :
 *   {
 *     positions : Float64Array(N*3),   // coords absolues (double précision)
 *     colors    : Uint8Array(N*3)|null,// 0..255 ou null si absent
 *     scalars   : { name: Float32Array(N), ... },
 *     count     : N,
 *     source    : "ply" | "las" | "laz" | "npz"
 *   }
 * On garde les positions en Float64 ; le recentrage + conversion Float32 pour le
 * GPU est fait côté app.js (précision pour les grandes coordonnées type UTM).
 * ==========================================================================*/

/* ----------------------------- Dispatcher ----------------------------- */

export async function loadPointCloud(source, name) {
  // source : File (input) ou string (URL). name : nom de fichier pour l'extension.
  const fname = (name || (typeof source === "string" ? source : source.name) || "").toLowerCase();
  const ext = fname.split(".").pop();

  if (ext === "ply")  return parsePLY(await toArrayBuffer(source));
  if (ext === "las")  return parseLAS(await toArrayBuffer(source));
  if (ext === "laz")  return loadLAZ(source);              // loaders.gl
  if (ext === "npz")  return parseNPZ(await toArrayBuffer(source));
  throw new Error(`Extension non supportée : .${ext} (attendu ply/las/laz/npz)`);
}

async function toArrayBuffer(source) {
  if (typeof source === "string") {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`fetch ${source} → ${res.status}`);
    return res.arrayBuffer();
  }
  return source.arrayBuffer(); // File / Blob
}

/* ============================================================================
 * PLY (ASCII + binaire LE/BE)
 * ==========================================================================*/

const PLY_TYPES = {
  char:[1,"getInt8"],   int8:[1,"getInt8"],
  uchar:[1,"getUint8"], uint8:[1,"getUint8"],
  short:[2,"getInt16"], int16:[2,"getInt16"],
  ushort:[2,"getUint16"],uint16:[2,"getUint16"],
  int:[4,"getInt32"],   int32:[4,"getInt32"],
  uint:[4,"getUint32"], uint32:[4,"getUint32"],
  float:[4,"getFloat32"],float32:[4,"getFloat32"],
  double:[8,"getFloat64"],float64:[8,"getFloat64"],
};

export function parsePLY(buffer) {
  const bytes = new Uint8Array(buffer);

  // 1) Trouver la fin de l'en-tête ("end_header\n")
  const marker = "end_header";
  const headerStr = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 1 << 16)));
  const mIdx = headerStr.indexOf(marker);
  if (mIdx < 0) throw new Error("PLY : en-tête invalide");
  // début des données = après "end_header" + le \n qui suit
  let dataStart = mIdx + marker.length;
  while (bytes[dataStart] === 0x0d || bytes[dataStart] === 0x0a) dataStart++; // \r \n

  // 2) Parser l'en-tête
  const headerLines = headerStr.substring(0, mIdx).split(/\r?\n/);
  let format = "ascii";       // ascii | binary_little_endian | binary_big_endian
  let count = 0;
  let inVertex = false;
  const props = [];           // { name, type }
  for (const line of headerLines) {
    const t = line.trim().split(/\s+/);
    if (t[0] === "format") format = t[1];
    else if (t[0] === "element") {
      inVertex = (t[1] === "vertex");
      if (inVertex) count = parseInt(t[2], 10);
    } else if (t[0] === "property" && inVertex) {
      if (t[1] === "list") continue; // ignore les listes (faces)
      props.push({ type: t[1], name: t[2] });
    }
  }
  if (!count) throw new Error("PLY : aucun sommet");

  // 3) Index des propriétés utiles
  const lc = (s) => s.toLowerCase();
  const findProp = (names) => props.findIndex(p => names.includes(lc(p.name)));
  const ix = findProp(["x"]), iy = findProp(["y"]), iz = findProp(["z"]);
  if (ix < 0 || iy < 0 || iz < 0) throw new Error("PLY : x/y/z manquants");
  const ir = findProp(["red", "r"]), ig = findProp(["green", "g"]), ib = findProp(["blue", "b"]);
  const hasColor = ir >= 0 && ig >= 0 && ib >= 0;
  const colorIsFloat = hasColor && PLY_TYPES[props[ir].type][1].startsWith("getFloat");

  // propriétés scalaires = tout sauf x/y/z + rgb(a)
  const reserved = new Set(["x","y","z","red","green","blue","alpha","r","g","b","a"]);
  const scalarProps = props
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => !reserved.has(lc(p.name)));

  const positions = new Float64Array(count * 3);
  const colors = hasColor ? new Uint8Array(count * 3) : null;
  const scalars = {};
  for (const { p } of scalarProps) scalars[p.name] = new Float32Array(count);

  if (format === "ascii") {
    const txt = new TextDecoder("latin1").decode(bytes.subarray(dataStart));
    const lines = txt.split(/\r?\n/);
    let v = 0;
    for (const line of lines) {
      if (v >= count) break;
      const s = line.trim();
      if (!s) continue;
      const vals = s.split(/\s+/).map(Number);
      positions[v*3]   = vals[ix];
      positions[v*3+1] = vals[iy];
      positions[v*3+2] = vals[iz];
      if (hasColor) {
        const sc = colorIsFloat ? 255 : 1;
        colors[v*3]   = vals[ir] * sc;
        colors[v*3+1] = vals[ig] * sc;
        colors[v*3+2] = vals[ib] * sc;
      }
      for (const { p, i } of scalarProps) scalars[p.name][v] = vals[i];
      v++;
    }
  } else {
    // binaire
    const le = (format === "binary_little_endian");
    const dv = new DataView(buffer, dataStart);
    // offsets + stride
    let stride = 0;
    const offs = props.map(p => {
      const [sz] = PLY_TYPES[p.type];
      const o = stride; stride += sz; return o;
    });
    const get = (dvi, i, base) => {
      const [, fn] = PLY_TYPES[props[i].type];
      return dv[fn](base + offs[i], le);
    };
    for (let v = 0; v < count; v++) {
      const base = v * stride;
      positions[v*3]   = get(dv, ix, base);
      positions[v*3+1] = get(dv, iy, base);
      positions[v*3+2] = get(dv, iz, base);
      if (hasColor) {
        const sc = colorIsFloat ? 255 : 1;
        colors[v*3]   = get(dv, ir, base) * sc;
        colors[v*3+1] = get(dv, ig, base) * sc;
        colors[v*3+2] = get(dv, ib, base) * sc;
      }
      for (const { p, i } of scalarProps) scalars[p.name][v] = get(dv, i, base);
    }
  }

  return { positions, colors, scalars, count, source: "ply" };
}

/* ============================================================================
 * LAS (non compressé) — parser maison, coords en double précision
 * ==========================================================================*/

export function parseLAS(buffer) {
  const dv = new DataView(buffer);
  const sig = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (sig !== "LASF") throw new Error("LAS : signature invalide");

  const verMajor = dv.getUint8(24), verMinor = dv.getUint8(25);
  const pointDataOffset = dv.getUint32(96, true);
  const pointFormat = dv.getUint8(104) & 0x3f; // masque les bits de compression
  const pointLength = dv.getUint16(105, true);
  let count = dv.getUint32(107, true); // legacy
  // scales / offsets
  const sx = dv.getFloat64(131, true), sy = dv.getFloat64(139, true), sz = dv.getFloat64(147, true);
  const ox = dv.getFloat64(155, true), oy = dv.getFloat64(163, true), oz = dv.getFloat64(171, true);
  // LAS 1.4 : nombre de points sur 64 bits à l'offset 247
  if (verMajor === 1 && verMinor >= 4) {
    const lo = dv.getUint32(247, true), hi = dv.getUint32(251, true);
    const c64 = hi * 2 ** 32 + lo;
    if (c64 > 0) count = c64;
  }

  // Offset de la couleur RGB selon le format de point
  const RGB_OFFSET = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 };
  const rgbOff = RGB_OFFSET[pointFormat];
  const hasColor = rgbOff !== undefined;

  const positions = new Float64Array(count * 3);
  const colors = hasColor ? new Uint8Array(count * 3) : null;

  for (let i = 0; i < count; i++) {
    const base = pointDataOffset + i * pointLength;
    const X = dv.getInt32(base, true);
    const Y = dv.getInt32(base + 4, true);
    const Z = dv.getInt32(base + 8, true);
    positions[i*3]   = X * sx + ox;
    positions[i*3+1] = Y * sy + oy;
    positions[i*3+2] = Z * sz + oz;
    if (hasColor) {
      // RGB en uint16 (0..65535) → 0..255
      const r = dv.getUint16(base + rgbOff, true);
      const g = dv.getUint16(base + rgbOff + 2, true);
      const b = dv.getUint16(base + rgbOff + 4, true);
      colors[i*3]   = r > 255 ? r >> 8 : r;
      colors[i*3+1] = g > 255 ? g >> 8 : g;
      colors[i*3+2] = b > 255 ? b >> 8 : b;
    }
  }

  return { positions, colors, scalars: {}, count, source: "las" };
}

/* ============================================================================
 * LAZ (compressé) — via loaders.gl (chargé à la demande depuis esm.sh)
 * ==========================================================================*/

export async function loadLAZ(source) {
  const { parse } = await import("https://esm.sh/@loaders.gl/core@4.3.3");
  const { LASLoader } = await import("https://esm.sh/@loaders.gl/las@4.3.3");

  const buffer = await toArrayBuffer(source);
  const data = await parse(buffer, LASLoader);

  const pos = data.attributes.POSITION.value;            // Float32Array (N*3)
  const count = pos.length / 3;
  const positions = new Float64Array(pos.length);
  positions.set(pos);

  let colors = null;
  const col = data.attributes.COLOR_0 && data.attributes.COLOR_0.value;
  if (col) {
    const size = data.attributes.COLOR_0.size || 4;      // souvent RGBA
    colors = new Uint8Array(count * 3);
    const maxIs16 = col.BYTES_PER_ELEMENT === 2;
    for (let i = 0; i < count; i++) {
      let r = col[i*size], g = col[i*size+1], b = col[i*size+2];
      if (maxIs16) { r >>= 8; g >>= 8; b >>= 8; }
      colors[i*3] = r; colors[i*3+1] = g; colors[i*3+2] = b;
    }
  }
  return { positions, colors, scalars: {}, count, source: "laz" };
}

/* ============================================================================
 * NPZ (archive numpy) — via fflate, parse des .npy internes
 * --------------------------------------------------------------------------
 * Cherche les positions parmi : xyz, points, coords, vertices, positions (N,3)
 * Couleurs parmi : rgb, colors, color (N,3).  Tout array 1D de longueur N =
 * un champ scalaire (utilisable pour colorer).
 * ==========================================================================*/

export async function parseNPZ(buffer) {
  const fflate = await import("https://esm.sh/fflate@0.8.2");
  const files = fflate.unzipSync(new Uint8Array(buffer));

  const arrays = {};
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.endsWith(".npy")) continue;
    arrays[name.replace(/\.npy$/, "")] = parseNPY(bytes);
  }

  const keys = Object.keys(arrays);
  const find = (cands) => keys.find(k => cands.includes(k.toLowerCase()));

  const posKey = find(["xyz", "points", "coords", "vertices", "positions", "position"]);
  if (!posKey) {
    throw new Error(
      "NPZ : aucune position trouvée. Clés présentes = [" + keys.join(", ") + "]. " +
      "Attendu un tableau (N,3) nommé xyz/points/coords/vertices."
    );
  }
  const posArr = arrays[posKey];
  if (posArr.shape.length !== 2 || posArr.shape[1] !== 3)
    throw new Error(`NPZ : '${posKey}' doit être (N,3), trouvé ${posArr.shape}`);

  const count = posArr.shape[0];
  const positions = Float64Array.from(posArr.data);

  let colors = null;
  const colKey = find(["rgb", "colors", "color"]);
  if (colKey && arrays[colKey].shape[0] === count) {
    const c = arrays[colKey].data;
    colors = new Uint8Array(count * 3);
    // si flottant 0..1 → *255
    let isFloat = arrays[colKey].dtype.includes("f");
    for (let i = 0; i < count * 3; i++) colors[i] = isFloat ? c[i] * 255 : c[i];
  }

  const scalars = {};
  for (const k of keys) {
    if (k === posKey || k === colKey) continue;
    const a = arrays[k];
    if (a.shape.length === 1 && a.shape[0] === count) {
      scalars[k] = Float32Array.from(a.data);
    }
  }

  return { positions, colors, scalars, count, source: "npz" };
}

/** Parse un .npy en { data: TypedArray, shape:[...], dtype:"<f4" } */
function parseNPY(bytes) {
  const magic = String.fromCharCode(...bytes.subarray(1, 6));
  if (magic !== "NUMPY") throw new Error("NPY : magic invalide");
  const major = bytes[6];
  let headerLen, headerStart;
  if (major === 1) { headerLen = bytes[8] | (bytes[9] << 8); headerStart = 10; }
  else { headerLen = bytes[8] | (bytes[9]<<8) | (bytes[10]<<16) | (bytes[11]<<24); headerStart = 12; }

  const header = new TextDecoder("latin1").decode(bytes.subarray(headerStart, headerStart + headerLen));
  const descr = (header.match(/'descr'\s*:\s*'([^']+)'/) || [])[1];
  const shapeStr = (header.match(/'shape'\s*:\s*\(([^)]*)\)/) || [])[1] || "";
  const shape = shapeStr.split(",").map(s => s.trim()).filter(Boolean).map(Number);

  const dataStart = headerStart + headerLen;
  const le = descr[0] !== ">";
  const t = descr.slice(1); // ex "f4", "u1", "i8"
  const ab = bytes.buffer;
  const off = bytes.byteOffset + dataStart;
  const n = shape.reduce((a, b) => a * b, 1);

  let data;
  const dv = new DataView(ab, off);
  if (t === "u1" || t === "b1") data = new Uint8Array(ab, off, n);
  else if (t === "i1")          data = new Int8Array(ab, off, n);
  else if (t === "f4") { data = new Float32Array(n); for (let i=0;i<n;i++) data[i]=dv.getFloat32(i*4,le); }
  else if (t === "f8") { data = new Float64Array(n); for (let i=0;i<n;i++) data[i]=dv.getFloat64(i*8,le); }
  else if (t === "i4") { data = new Int32Array(n);   for (let i=0;i<n;i++) data[i]=dv.getInt32(i*4,le); }
  else if (t === "u4") { data = new Uint32Array(n);  for (let i=0;i<n;i++) data[i]=dv.getUint32(i*4,le); }
  else if (t === "i2") { data = new Int16Array(n);   for (let i=0;i<n;i++) data[i]=dv.getInt16(i*2,le); }
  else if (t === "u2") { data = new Uint16Array(n);  for (let i=0;i<n;i++) data[i]=dv.getUint16(i*2,le); }
  else if (t === "i8" || t === "u8") {              // 64 bits → on cast en f64 (suffisant pour labels)
    data = new Float64Array(n);
    for (let i=0;i<n;i++){ const lo=dv.getUint32(i*8,le), hi=dv.getUint32(i*8+(le?4:0),le); data[i]= (le? hi:lo)*2**32 + (le?lo:hi); }
  }
  else throw new Error("NPY : dtype non géré " + descr);

  return { data, shape, dtype: descr };
}
