import { paletteGLSL } from './palette'

// History terrain ("mix landscape"): the last ~16 s of spectra, drawn as
// concentric rings of ribbon lines around the grid. The newest row is a
// ring just outside the grid (radius `start` around the grid centre), older
// rows are larger rings (start + age * step, out to start + depth), fading
// with age and distance. Each ring carries its spectrum twice around.
//
// Data: a ring buffer texture, ROWS x COLS, one row per 1/rate s. Each row
// is the mean of the log bands over that interval, resampled to COLS
// columns (max over each group of bands), written with texSubImage2D
// (regl texture.subimage). Float texture when OES_texture_float is there,
// otherwise uint8 (the values are 0..1 anyway). It is only read in the
// vertex shader, with NEAREST filtering at exact texel centres (no float
// linear filtering needed); the vertex shader interpolates between columns
// itself (SUB samples per column and per repeat, so a ring of radius ~6
// stays round).
//
// Geometry: static, per row: a filled strip from the line down to the base
// plane (black: occlusion, Unknown Pleasures style, the stack never piles
// up into a white mass) and the line itself as screen-space ribbon quads
// with analytic AA (same technique as render-grid.js). The spectrum runs
// twice around the ring, mirrored (lows -> highs -> lows -> highs -> lows):
// the lows on the far side AND on the camera side, the highs on the left
// and right. The profile is continuous everywhere, and the ring's seam (in
// the middle of the far-side lows: first and last sample, same value, same
// point) takes its ribbon tangent across the seam (no kink, no gap).
//
// Occlusion: with rings, painter's order by row is wrong on the camera
// side (older rows are nearer there) and the eye usually stands inside the
// rings. So this pass has its own depth (the caller attaches a depth buffer
// to the scene target and clears only depth before calling draw()). Two
// programs: the strips first (depth test + write, newest rows first so the
// hidden older ones fail an early depth test, pushed very slightly back so
// their own line is never z-fought away), then the lines (depth test only,
// no write: AA fringes and faded lines never punch holes). The lines are
// drawn twice: depth 'less' at full opacity (in front of every strip), and
// 'gequal' at 1 - occlusion (behind a strip), so `occlusion` grades how
// much of an older ridge shows through a newer one; at 1 the second pass is
// skipped. The depth range is the history's own (affine near/far around
// the rings, in place of the scene projection's 0.01 .. 1000), so a 16-bit
// buffer resolves rows ~0.03 apart.
//
// Camera inside the landscape: lines and strips fade with the distance
// from the eye, over a small clear zone (the strips there are collapsed
// to zero height in the vertex shader, so they neither draw nor write
// depth, and no fragment shader discards), and ribbons fade out before the
// history near plane (GPU clipping does the rest; no vertex is projected
// through w <= 0). Over the grid square itself (the newest rings cross its
// corners) the ridges are flat.
//
// Keeping the grid clear: only where a ring point actually covers the
// grid on screen AND stands in front of it is it flattened, dimmed and cut
// to the newest few rows, its strip dropped (no black slab over the
// fabric). Everywhere else, the camera side included, the rings draw and
// occlude in full. Two tests, multiplied:
// - on screen: the fabric's volume (the square, its corners cut to an
//   octagon inside the newest ring (what lies past it is under the rings,
//   flat), narrowing to a well's throat at the bottom, from the deepest
//   well to the highest shape plus the peaks: see draw()'s gridBox) is
//   clipped to the front of the camera, projected on the CPU each frame,
//   and bounded by a 16-sided polygon (the max along 16 fixed screen
//   directions, in units of half the screen height: within ~2 % of the
//   exact convex hull); the vertex shader takes its signed distance to
//   that polygon (16 dot products);
// - in front: the line of sight from the eye through the point enters the
//   fabric's column (that octagon, any height) only past the point. A ray
//   test against 4 slabs per vertex, exact for every part of the fabric
//   (the rings beside the grid, whose line of sight crosses the fabric's
//   near corner before reaching them, are behind it and left alone; from
//   above the grid, eye inside the column, nothing is in front).
//
// Orientation: the lows face away from the camera (far side) and toward
// it (camera side), the highs to the sides. The direction follows the
// camera azimuth, smoothed (it lags behind fast drags; the ring just
// turns, it is never hidden while it lags); a hard cut snaps it.
//
// The rows scroll continuously (fractional offset between two writes), and
// stop while the audio is paused.

const TAU = Math.PI * 2
const AZIMUTH_FOLLOW = 1.5 // s, smoothing of the landscape direction
// history depth range: the near plane of this pass (world units of view
// depth: what is closer is clipped, already faded out), and the fill push
const DEPTH_NEAR = 0.5
const FILL_PUSH = 4 / 65536 // NDC: a couple of 16-bit depth steps
// view depth (world units) under which a corner of the grid box counts as
// behind the camera (its box edges are clipped there)
const COVER_NEAR = 0.05
// the 16 screen directions of the footprint polygon
const COVER_DIRS = 16
const coverCos = new Float32Array(COVER_DIRS)
const coverSin = new Float32Array(COVER_DIRS)
for (let k = 0; k < COVER_DIRS; k++) {
  coverCos[k] = Math.cos((k * TAU) / COVER_DIRS)
  coverSin[k] = Math.sin((k * TAU) / COVER_DIRS)
}
const glslVec4 = (a, k) => `vec4(${[0, 1, 2, 3].map((j) => a[k + j].toFixed(7)).join(', ')})`

export default function createRenderHistory (regl, opts = {}) {
  const ROWS = Math.max(8, (opts.rows || 192) | 0)
  const COLS = Math.max(4, (opts.cols || 64) | 0)
  // samples per column, per repeat of the spectrum (>= 1: a sample's
  // neighbours stay within the 4 columns the line shader fetches)
  const SUB = Math.max(1, Number(opts.sub) || 2)
  const bandCount = Math.max(1, (opts.bandCount || 200) | 0)
  const QUARTER = Math.max(1, Math.round(SUB * (COLS - 1))) // samples, lows to highs
  const NX = 4 * QUARTER + 1 // samples around a ring (twice the spectrum, mirrored)
  const SEGS = NX - 1

  const limits = regl.limits
  const supported = limits.maxVertexTextureUnits >= 1 && ROWS <= limits.maxTextureSize
  const useFloat = supported && regl.hasExtension('oes_texture_float')

  // ---- recording (always runs, even when not drawn) -------------------------
  const bandSum = new Float64Array(bandCount)
  let sumTime = 0
  let acc = 0 // s since the last row was written
  let head = 0 // texture row of the newest spectrum
  const rowData = useFloat ? new Float32Array(COLS * 4) : new Uint8Array(COLS * 4)
  // band range of each column: low bands are narrow in Hz but the log bands
  // are already perceptual, so an even split is fine
  const colLo = new Int32Array(COLS)
  const colHi = new Int32Array(COLS)
  for (let c = 0; c < COLS; c++) {
    colLo[c] = Math.floor((c * bandCount) / COLS)
    colHi[c] = Math.max(colLo[c] + 1, Math.floor(((c + 1) * bandCount) / COLS))
  }

  let texture = null
  if (supported) {
    texture = regl.texture({
      width: COLS,
      height: ROWS,
      data: useFloat ? new Float32Array(COLS * ROWS * 4) : new Uint8Array(COLS * ROWS * 4),
      format: 'rgba',
      type: useFloat ? 'float' : 'uint8',
      min: 'nearest',
      mag: 'nearest',
      wrap: 'clamp',
      mipmap: false
    })
  }

  function writeRow () {
    const t = sumTime > 1e-6 ? sumTime : 1
    for (let c = 0; c < COLS; c++) {
      let m = 0
      for (let b = colLo[c]; b < colHi[c] && b < bandCount; b++) {
        const v = bandSum[b] / t
        if (v > m) m = v
      }
      // NaN / Inf guard: never let a bad value into the texture
      if (!(m === m) || m < 0) m = 0
      if (m > 1) m = 1
      if (useFloat) rowData[c * 4] = m
      else rowData[c * 4] = Math.round(m * 255)
    }
    bandSum.fill(0)
    sumTime = 0
    head = (head + 1) % ROWS
    if (texture) texture.subimage({ data: rowData, width: COLS, height: 1 }, 0, head)
  }

  let scroll = 0 // 0..1, fraction of the interval since the last write
  // smoothed direction of the lows (away from the camera), and the eye
  let azimuth = 0
  let azimuthReady = false
  const eye = new Float32Array(3)

  // o: dt, features (bands), running (audio playing), view (matrix),
  // seconds (history length), snap (true on a hard camera cut: jump to the
  // new azimuth)
  function update (o) {
    const dt = Math.min(Math.max(o.dt || 0, 0), 0.25)
    const interval = Math.max(2, o.seconds || 16) / ROWS
    if (o.running && o.features && o.features.bands) {
      const bands = o.features.bands
      const n = Math.min(bands.length, bandCount)
      for (let b = 0; b < n; b++) {
        const v = bands[b]
        if (v === v) bandSum[b] += v * dt
      }
      sumTime += dt
      acc += dt
      // a long frame writes a few rows at most (the rest is dropped)
      let writes = 0
      while (acc >= interval && writes < 4) {
        writeRow()
        acc -= interval
        writes++
      }
      if (acc >= interval) acc = 0
    }
    scroll = Math.min(Math.max(acc / interval, 0), 1)

    // camera eye: -R^T t (column-major view matrix)
    const v = o.view
    if (v) {
      const ex = -(v[0] * v[12] + v[1] * v[13] + v[2] * v[14])
      const ey = -(v[4] * v[12] + v[5] * v[13] + v[6] * v[14])
      const ez = -(v[8] * v[12] + v[9] * v[13] + v[10] * v[14])
      if (ex === ex && ey === ey && ez === ez) {
        eye[0] = ex; eye[1] = ey; eye[2] = ez
      }
      if (Math.hypot(ex, ey) > 0.05) {
        const target = Math.atan2(-ey, -ex)
        // snap: a camera cut, the landscape turns with it at once
        if (!azimuthReady || o.snap) {
          azimuth = target
          azimuthReady = true
        }
        let diff = target - azimuth
        diff -= TAU * Math.round(diff / TAU)
        azimuth += diff * (1 - Math.exp(-dt / AZIMUTH_FOLLOW))
        azimuth -= TAU * Math.round(azimuth / TAU)
        if (!(azimuth === azimuth)) azimuth = 0
      }
    }
  }

  if (!supported) {
    return {
      update,
      draw () {},
      destroy () {},
      rows: ROWS,
      cols: COLS,
      mode: 'unsupported (no vertex texture fetch)'
    }
  }

  // ---- static geometry -------------------------------------------------------
  // vertex: (sample index, row slot (0 = oldest), side, end)
  //   fill: end = 0, side -1 = base, +1 = top of the ridge
  //   line: end = +1 first sample of its segment, -1 second; side -1 / +1
  const vertsPerRow = 2 * NX + 4 * SEGS
  const indicesPerRow = 6 * SEGS // per part (fill or line)
  const data = new Float32Array(ROWS * vertsPerRow * 4)
  let k = 0
  for (let r = 0; r < ROWS; r++) {
    for (let i = 0; i < NX; i++) {
      data[k++] = i; data[k++] = r; data[k++] = -1; data[k++] = 0
      data[k++] = i; data[k++] = r; data[k++] = 1; data[k++] = 0
    }
    for (let q = 0; q < SEGS; q++) {
      data[k++] = q; data[k++] = r; data[k++] = -1; data[k++] = 1
      data[k++] = q; data[k++] = r; data[k++] = 1; data[k++] = 1
      data[k++] = q + 1; data[k++] = r; data[k++] = -1; data[k++] = -1
      data[k++] = q + 1; data[k++] = r; data[k++] = 1; data[k++] = -1
    }
  }
  const vertexBuffer = regl.buffer(data)

  // relative index buffers for a chunk of rows (16-bit indices), per part
  // (fills, lines): every row, and every other row (the governor's reduced
  // level: fewer rows over the same depth, the newest row always kept). An
  // even chunk size keeps the row parity the same in every chunk.
  // The fills list their rows newest first (with depth write, the hidden
  // older fills then fail an early depth test), the lines oldest first.
  let rowsPerChunk = Math.max(1, Math.min(ROWS, Math.floor(65536 / vertsPerRow)))
  if (rowsPerChunk >= 2 && rowsPerChunk < ROWS) rowsPerChunk -= rowsPerChunk % 2
  const strideParity = (ROWS - 1) % 2 // in-chunk parity of the rows kept at stride 2
  const elements = (part, stride) => regl.elements({
    data: rowIndices(part, stride, stride === 1 ? 0 : strideParity),
    primitive: 'triangles',
    type: 'uint16'
  })
  const fillFull = elements(0, 1)
  const fillHalf = elements(0, 2)
  const lineFull = elements(1, 1)
  const lineHalf = elements(1, 2)
  // rows of a chunk of `rowsHere` rows drawn at this stride
  const rowsDrawn = (rowsHere, stride) =>
    stride === 1 ? rowsHere : Math.max(0, Math.ceil((rowsHere - strideParity) / 2))

  function rowIndices (part, stride, offset) {
    const indices = new Uint16Array(Math.ceil(rowsPerChunk / stride) * indicesPerRow)
    let n = 0
    const rows = []
    for (let r = offset; r < rowsPerChunk; r += stride) rows.push(r)
    if (part === 0) rows.reverse()
    for (const r of rows) {
      const base = r * vertsPerRow
      if (part === 0) {
        for (let i = 0; i < SEGS; i++) {
          const b0 = base + i * 2
          indices[n++] = b0
          indices[n++] = b0 + 1
          indices[n++] = b0 + 2
          indices[n++] = b0 + 1
          indices[n++] = b0 + 3
          indices[n++] = b0 + 2
        }
      } else {
        const lb = base + 2 * NX
        for (let q = 0; q < SEGS; q++) {
          const b = lb + q * 4
          indices[n++] = b
          indices[n++] = b + 1
          indices[n++] = b + 2
          indices[n++] = b + 1
          indices[n++] = b + 3
          indices[n++] = b + 2
        }
      }
    }
    return indices.subarray(0, n)
  }

  // chunks: first row, rows, and their attribute descriptor (built once)
  const chunks = []
  for (let r = 0; r < ROWS; r += rowsPerChunk) {
    chunks.push({
      row: r,
      rows: Math.min(rowsPerChunk, ROWS - r),
      attr: { buffer: vertexBuffer, offset: r * vertsPerRow * 16, size: 4 }
    })
  }

  const f1 = (x) => x.toFixed(1)
  const defines = `
    #define ROWS ${f1(ROWS)}
    #define COLS ${f1(COLS)}
    #define QUARTER ${f1(QUARTER)}
    #define LAST ${f1(NX - 1)}
    #define DEPTH_NEAR ${DEPTH_NEAR.toFixed(3)}
    #define FILL_PUSH ${FILL_PUSH.toExponential(6)}
  `

  // shared by both parts (FILL defined for the fills)
  const vertCommon = `
    precision highp float;
    ${defines}
    attribute vec4 vert;
    uniform sampler2D history;
    uniform mat4 projection;
    uniform mat4 view;
    uniform float head;
    uniform float scroll;
    uniform vec2 dirB; // unit, along the ground: where the lows face
    uniform vec3 eye; // world position of the camera
    // the grid's screen footprint: max along the 16 screen directions
    // k * 22.5 deg (k = 0..3 in coverA, 4..7 in coverB...), in units of
    // half the screen height
    uniform vec4 coverA;
    uniform vec4 coverB;
    uniform vec4 coverC;
    uniform vec4 coverD;
    // the fabric's column (world, around the z axis): half widths of the
    // octagon along x / y (x) and along the diagonals (y)
    uniform vec2 gridColumn;
    uniform float startDist;
    uniform float rowStep;
    uniform float heightScale;
    uniform float floorV; // contrast floor
    uniform float amount;
    uniform float occlusion;
    uniform vec2 depthAB; // this pass's clip z = A * view z + B

    varying vec4 fragColor;

    const float PI = 3.14159265;
    const float NEAR = 0.05;

    float columnValue(float col, float row) {
      float v = texture2D(history, vec2((col + 0.5) / COLS, (row + 0.5) / ROWS)).r;
      // NaN guard (v != v)
      return v == v ? v : 0.0;
    }

    // contrast floor: quiet stays flat
    float shaped(float v) {
      float f = clamp((v - floorV) / max(1.0 - floorV, 0.001), 0.0, 1.0);
      return pow(f, 1.3);
    }

    float rowOf(float age) {
      float row = head - age;
      return row + ROWS * step(row, -0.5);
    }

    // fractional column of sample i: a triangle wave, twice around the
    // ring (lows at samples 0, 2Q, 4Q: dirB and -dirB; highs at Q, 3Q).
    // At a multiple of 2Q, mod() may round to 0 or 2Q: both give column 0
    float columnOf(float i) {
      return (QUARTER - abs(mod(i, 2.0 * QUARTER) - QUARTER)) * (COLS - 1.0) / QUARTER;
    }

    // unit ground direction of sample i: the far-side lows along dirB,
    // the camera-side lows along -dirB, the highs to the sides
    vec2 radial(float i) {
      float th = 2.0 * PI * i / LAST;
      vec2 side = vec2(-dirB.y, dirB.x);
      return dirB * cos(th) + side * sin(th);
    }

    // signed distance of screen point s to the footprint polygon (>= the
    // true distance outside it: exact along the edges, larger past the
    // corners; negative inside)
    float footprintDist(vec2 s) {
      vec4 d = max(
        max(s.x * ${glslVec4(coverCos, 0)} + s.y * ${glslVec4(coverSin, 0)} - coverA,
            s.x * ${glslVec4(coverCos, 4)} + s.y * ${glslVec4(coverSin, 4)} - coverB),
        max(s.x * ${glslVec4(coverCos, 8)} + s.y * ${glslVec4(coverSin, 8)} - coverC,
            s.x * ${glslVec4(coverCos, 12)} + s.y * ${glslVec4(coverSin, 12)} - coverD));
      return max(max(d.x, d.y), max(d.z, d.w));
    }

    // how far (world units) world point p stands in front of the fabric's
    // column along the line of sight: the ray eye -> p enters the octagon
    // (4 slabs: x, y and the two diagonals) at t = tIn, p is at t = 1.
    // 0 when the ray enters before p (p beside or behind the fabric, or
    // the eye inside the column) or misses it (parallel rays included)
    float inFront(vec3 p) {
      vec3 d = p - eye;
      const float R2 = 0.70710678;
      vec4 nd = vec4(d.x, d.y, (d.x + d.y) * R2, (d.x - d.y) * R2);
      vec4 ne = vec4(eye.x, eye.y, (eye.x + eye.y) * R2, (eye.x - eye.y) * R2);
      vec4 h = gridColumn.xxyy;
      // no division by 0: a parallel ray gets a huge t of the right sign
      vec4 inv = (step(0.0, nd) * 2.0 - 1.0) / max(abs(nd), vec4(1e-5));
      vec4 t0 = (-h - ne) * inv;
      vec4 t1 = (h - ne) * inv;
      vec4 tn = min(t0, t1);
      vec4 tf = max(t0, t1);
      float tIn = max(max(tn.x, tn.y), max(tn.z, tn.w));
      float tOut = min(min(tf.x, tf.y), min(tf.z, tf.w));
      return tIn < tOut ? (tIn - 1.0) * length(d) : 0.0;
    }

    // how much a ring point (world p, view v) covers the grid on screen
    // and stands in front of it: 1 inside the grid's screen footprint
    // (fading over 3 % of the screen height around it) and clearly in
    // front of the fabric along its line of sight
    float coverOf(vec3 p, vec3 v) {
      vec4 c = projection * vec4(v, 1.0);
      vec2 s = c.xy / max(c.w, NEAR) * vec2(projection[1][1] / projection[0][0], 1.0);
      return (1.0 - smoothstep(0.0, 0.06, footprintDist(s))) *
        smoothstep(0.0, 0.3, inFront(p));
    }

    // 0 over the grid square ([-1, 1]^2), 1 past it: the newest rings
    // cross its corners, flat there
    float offGrid(vec2 g) {
      return smoothstep(1.0, 1.15, max(abs(g.x), abs(g.y)));
    }

    // ring point of sample i at fractional age a, lifted by f (flat over
    // the grid square)
    vec3 worldPoint(float i, float a, float f) {
      vec2 g = radial(i) * (startDist + a * rowStep);
      return vec3(g, f * heightScale * offGrid(g));
    }

    // flattening where a point covers the grid (the line and its strip
    // use the same factor: the strip's top stays on the line)
    float flatten(float cover) {
      return 1.0 - 0.65 * cover;
    }

    // clip position with this pass's own depth range
    vec4 toClip(vec3 v) {
      vec4 c = projection * vec4(v, 1.0);
      c.z = depthAB.x * v.z + depthAB.y;
      return c;
    }
  `

  // occluding strips: black, from the ridge down to the base plane. Not
  // drawn near the eye, before the near plane, nor between the eye and the
  // grid (no black slab over the view): there the strip is collapsed to
  // zero height in the vertex shader (no fragment, no depth write; no
  // discard, so tiled GPUs keep their early depth test). Clipped by the GPU
  const fillVert = `
    ${vertCommon}
    void main() {
      float i = vert.x;
      float age = ROWS - 1.0 - vert.y;
      float a = age + scroll;
      float row = rowOf(age);
      float c = columnOf(i);
      float c0 = floor(c);
      float fc = shaped(mix(columnValue(c0, row),
        columnValue(min(c0 + 1.0, COLS - 1.0), row), c - c0));
      vec3 pc = worldPoint(i, a, fc);
      vec3 vc = (view * vec4(pc, 1.0)).xyz;
      // the cover test on the full ridge (the top is the part nearest to
      // the grid on screen), then flattened as the line is
      float cover = coverOf(pc, vc);
      pc.z *= flatten(cover);
      vc = (view * vec4(pc, 1.0)).xyz;
      // where the strip occludes: geometry only (occlusion sets how much
      // of what it hides shows through, in the lines' second pass); not
      // over the grid, not in the clear zone around the eye
      float gate = smoothstep(0.0, 1.0, a) * (1.0 - cover) *
        smoothstep(0.7, 1.6, distance(pc, eye)) *
        smoothstep(DEPTH_NEAR + 0.3, DEPTH_NEAR + 0.9, -vc.z);
      vec3 p = pc;
      if (vert.z < 0.0) p.z = 0.0;
      else p.z *= smoothstep(0.4, 0.6, gate);
      gl_Position = toClip((view * vec4(p, 1.0)).xyz);
      gl_Position.z += FILL_PUSH * gl_Position.w;
      fragColor = vec4(0.0, 0.0, 0.0, clamp(occlusion * amount * smoothstep(0.4, 1.0, gate), 0.0, 1.0));
    }
  `

  // the line: screen-space ribbon quads with analytic AA
  const lineVert = `
    ${vertCommon}
    uniform float rowStride; // 1, or 2 when every other row is drawn
    uniform float brightness;
    uniform float baseLevel;
    uniform float lineWidth; // device px
    uniform float fadePow;
    uniform float fogAmount;
    uniform float hiddenGain; // 1, or 1 - occlusion behind a strip
    uniform vec2 halfResolution;
    ${paletteGLSL}

    varying vec2 edge; // x: signed px from the centre line, y: half core

    const float AA_MARGIN = 1.0;

    // component k (0..3) of v
    float pick(vec4 v, float k) {
      vec4 s = step(vec4(0.5, 1.5, 2.5, 3.5), vec4(k));
      return dot(v, vec4(1.0 - s.x, s.x - s.y, s.y - s.z, s.z));
    }

    // value at fractional column x, from the 4 columns base .. base + 3
    float valueFrom(vec4 cols, float base, float x) {
      float xi = floor(x);
      float k = xi - base;
      return shaped(mix(pick(cols, k), pick(cols, k + 1.0), x - xi));
    }

    // screen position, for directions only: never through w <= 0
    vec2 toScreen(vec3 v) {
      vec4 c = projection * vec4(v.xy, min(v.z, -NEAR), 1.0);
      return c.xy / c.w * halfResolution;
    }

    void main() {
      float i = vert.x;
      float age = ROWS - 1.0 - vert.y;
      float a = age + scroll;
      float row = rowOf(age);
      // neighbours wrap across the seam (first and last sample are the
      // same point): the ribbon turns there without a kink
      float ip = i - 1.0 + LAST * step(i, 0.5);
      float inx = i + 1.0 - LAST * step(LAST - 0.5, i);
      // the sample and its two neighbours span at most 4 columns: fetch
      // them once (one row of the history texture)
      float xc = columnOf(i);
      float base = floor(xc) - 1.0;
      vec4 cols = vec4(
        columnValue(max(base, 0.0), row),
        columnValue(base + 1.0, row),
        columnValue(min(base + 2.0, COLS - 1.0), row),
        columnValue(min(base + 3.0, COLS - 1.0), row));
      float fc = valueFrom(cols, base, xc);
      vec3 pc = worldPoint(i, a, fc);
      vec3 pp = worldPoint(ip, a, valueFrom(cols, base, columnOf(ip)));
      vec3 pn = worldPoint(inx, a, valueFrom(cols, base, columnOf(inx)));
      // over the grid on screen and in front of it: flattened (same factor
      // as its strip; the neighbours, for the tangent only, take it too)
      float cover = coverOf(pc, (view * vec4(pc, 1.0)).xyz);
      float flatK = flatten(cover);
      pc.z *= flatK;
      pp.z *= flatK;
      pn.z *= flatK;
      float eyeDist = distance(pc, eye);

      // fades: in over the first row, out with age
      float ageN = a / ROWS;
      float fade = smoothstep(0.0, 1.0, a) * pow(max(1.0 - ageN, 0.0), fadePow);

      vec3 c = (view * vec4(pc, 1.0)).xyz;
      vec3 prev = (view * vec4(pp, 1.0)).xyz;
      vec3 next = (view * vec4(pn, 1.0)).xyz;
      float depth = -c.z;

      // distance fog, relative to the depth of the grid centre
      float centerDepth = max(-view[3].z, NEAR);
      float fog = fogAmount * smoothstep(centerDepth + startDist * 0.5,
        centerDepth + startDist + rowStep * ROWS, depth);

      // rows crowd together in the distance: dim them by their spacing
      // on screen (dense lines pile up into a white mass). The view is
      // affine: the ground point under pc is c minus its lift along the
      // view's z column, and the next drawn ring is one step further out
      // along the same radius
      vec3 g0 = c - pc.z * view[2].xyz;
      vec3 g1 = g0 + (view * vec4(radial(i) * (rowStep * rowStride), 0.0, 0.0)).xyz;
      float spacing = length(toScreen(g1) - toScreen(g0));
      float density = clamp(spacing / 3.0, 0.08, 1.0);

      float peak = smoothstep(0.25, 1.0, fc);
      vec3 rgb = palette(mix(0.1, 0.9, fc)) * brightness * (1.0 + 0.35 * peak);
      rgb *= 1.0 - 0.5 * fog;
      float opacity = clamp(baseLevel + 1.3 * smoothstep(0.0, 0.7, fc), 0.0, 0.95);
      opacity *= amount * fade * (1.0 - fog) * density * hiddenGain;
      // clear around the eye (a small zone), gone before this pass's near
      // plane, gone over the grid square; where it covers the grid on
      // screen, in front of it (no strips there to hide the stack): dimmed,
      // and only the newest few rows kept
      opacity *= smoothstep(0.6, 1.6, eyeDist) * offGrid(pc.xy) *
        smoothstep(DEPTH_NEAR + 0.2, DEPTH_NEAR + 0.7, depth) *
        (1.0 - 0.75 * cover) * (1.0 - cover * smoothstep(0.0, 8.0, a));

      float w = lineWidth * mix(1.0, 1.6, peak);
      w *= pow(clamp(centerDepth / max(depth, NEAR), 0.35, 3.0), 0.5);
      float core = max(w, 1.0);
      opacity *= clamp(w / core, 0.0, 1.0);

      vec2 d = toScreen(next) - toScreen(prev);
      float len = length(d);
      vec2 tangent = len > 1e-4 ? d / len : vec2(1.0, 0.0);
      vec2 normal = vec2(-tangent.y, tangent.x);
      float halfExtent = 0.5 * core + AA_MARGIN;
      vec4 clip = toClip(c);
      // behind the near plane the offset is clipped away with the vertex
      clip.xy += normal * (vert.z * halfExtent) / halfResolution * max(clip.w, NEAR);

      fragColor = vec4(rgb, clamp(opacity, 0.0, 1.0));
      edge = vec2(vert.z * halfExtent, 0.5 * core);
      gl_Position = clip;
    }
  `

  const fragHead = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif
    varying vec4 fragColor;
  `

  const halfRes = new Float32Array(2)
  const uniforms = {
    history: texture,
    head: () => head,
    scroll: () => scroll,
    dirB: regl.prop('dirB'),
    eye: regl.prop('eye'),
    coverA: regl.prop('coverA'),
    coverB: regl.prop('coverB'),
    coverC: regl.prop('coverC'),
    coverD: regl.prop('coverD'),
    gridColumn: regl.prop('gridColumn'),
    startDist: regl.prop('startDist'),
    rowStep: regl.prop('rowStep'),
    rowStride: regl.prop('rowStride'),
    heightScale: regl.prop('heightScale'),
    floorV: regl.prop('floorV'),
    amount: regl.prop('amount'),
    brightness: regl.prop('brightness'),
    occlusion: regl.prop('occlusion'),
    baseLevel: regl.prop('baseLevel'),
    lineWidth: regl.prop('lineWidth'),
    fadePow: regl.prop('fadePow'),
    fogAmount: regl.prop('fogAmount'),
    hiddenGain: regl.prop('hiddenGain'),
    depthAB: regl.prop('depthAB'),
    paletteA: regl.prop('paletteA'),
    paletteB: regl.prop('paletteB'),
    paletteC: regl.prop('paletteC'),
    paletteD: regl.prop('paletteD'),
    paletteShift: regl.prop('paletteShift'),
    halfResolution: ({ viewportWidth, viewportHeight }) => {
      halfRes[0] = Math.max(1, viewportWidth) * 0.5
      halfRes[1] = Math.max(1, viewportHeight) * 0.5
      return halfRes
    }
  }
  const common = {
    attributes: { vert: regl.prop('attr') },
    uniforms,
    blend: {
      enable: true,
      // colour over, alpha of the scene untouched (no accumulation in HDR)
      func: { srcRGB: 'src alpha', dstRGB: 'one minus src alpha', srcAlpha: 0, dstAlpha: 1 },
      equation: { rgb: 'add', alpha: 'add' }
    },
    elements: regl.prop('elements'),
    offset: regl.prop('offset'),
    count: regl.prop('count')
  }

  // own depth (see the header): the strips test and write it
  const fillCommand = regl(Object.assign({
    vert: fillVert,
    frag: `${fragHead}
      void main() { gl_FragColor = fragColor; }
    `,
    depth: { enable: true, func: 'less', mask: true }
  }, common))

  // the lines only test it: 'less' for what is in front of every strip,
  // 'gequal' for what is behind one (drawn at hiddenGain)
  const lineCommand = regl(Object.assign({
    vert: lineVert,
    frag: `${fragHead}
      varying vec2 edge;
      void main() {
        float coverage = clamp(edge.y + 0.5 - abs(edge.x), 0.0, 1.0);
        float alpha = fragColor.a * coverage;
        if (alpha < 0.002) discard;
        gl_FragColor = vec4(fragColor.rgb, alpha);
      }
    `,
    depth: { enable: true, func: regl.prop('depthFunc'), mask: false }
  }, common))

  const fin = (x, d) => (typeof x === 'number' && isFinite(x) ? x : d)
  const shared = {
    dirB: new Float32Array(2),
    eye,
    depthAB: new Float32Array(2),
    coverA: new Float32Array(4),
    coverB: new Float32Array(4),
    coverC: new Float32Array(4),
    coverD: new Float32Array(4),
    gridColumn: new Float32Array(2)
  }
  const fillBatch = []
  const lineBatch = []
  const fillProps = [] // reused per-chunk props (no per-frame allocation)
  const lineProps = []

  // frustum test of the landscape's bounding box (8 corners of the square
  // around the outer ring), in clip space with the unjittered view /
  // projection: true when every corner is outside the same clip plane (the
  // plane tests are linear, so this stays conservative with corners behind
  // the eye, and never skips while the eye is inside the rings)
  const corner = new Float32Array(4)
  function outside (view, proj, radius) {
    let mask = 63
    for (let k = 0; k < 8; k++) {
      const wx = k & 1 ? radius : -radius
      const wy = k & 2 ? radius : -radius
      const wz = k & 4 ? shared.heightScale : 0
      // clip = proj * view * (wx, wy, wz, 1), column-major
      for (let r = 0; r < 4; r++) {
        corner[r] = view[r] * wx + view[4 + r] * wy + view[8 + r] * wz + view[12 + r]
      }
      const vx = corner[0]
      const vy = corner[1]
      const vz = corner[2]
      const vw = corner[3]
      const cx = proj[0] * vx + proj[4] * vy + proj[8] * vz + proj[12] * vw
      const cy = proj[1] * vx + proj[5] * vy + proj[9] * vz + proj[13] * vw
      const cz = proj[2] * vx + proj[6] * vy + proj[10] * vz + proj[14] * vw
      const cw = proj[3] * vx + proj[7] * vy + proj[11] * vz + proj[15] * vw
      let m = 0
      if (cx < -cw) m |= 1
      if (cx > cw) m |= 2
      if (cy < -cw) m |= 4
      if (cy > cw) m |= 8
      if (cz < -cw) m |= 16
      if (cz > cw) m |= 32
      mask &= m
      if (!mask) return false
    }
    return mask !== 0
  }

  // the grid's screen footprint (see the header): the volume from the
  // octagon of half side halfLo at zLo to the one of half side half at zHi
  // (a well narrows toward its bottom), each square's corners cut at
  // radius `cap` (inside the newest ring), in view space, clipped to view
  // depth >= COVER_NEAR, projected, and bounded along the 16 screen
  // directions into shared.coverA .. coverD (units of half the screen
  // height, x scaled by the aspect); shared.gridColumn: the top octagon.
  // Nothing in front of the camera: an empty footprint (covers nothing)
  const boxView = new Float32Array(16 * 3)
  const boxDepth = new Float32Array(16)
  const coverMax = new Float32Array(COVER_DIRS)
  // the 24 edges, as pairs of point indices (0..7: the bottom octagon,
  // counterclockwise, 8..15: the top one)
  const BOX_EDGES = new Int32Array(48)
  for (let k = 0; k < 8; k++) {
    BOX_EDGES[k * 6] = k; BOX_EDGES[k * 6 + 1] = (k + 1) % 8
    BOX_EDGES[k * 6 + 2] = 8 + k; BOX_EDGES[k * 6 + 3] = 8 + (k + 1) % 8
    BOX_EDGES[k * 6 + 4] = k; BOX_EDGES[k * 6 + 5] = 8 + k
  }
  // octagon vertex k (counterclockwise from (h, c)) of the square of half
  // side h cut along |x| + |y| = h + c (c = h: no cut, the vertices pair
  // up on the corners): x = XH * h + XC * c, y = YH * h + YC * c
  const XH = [1, 0, 0, -1, -1, 0, 0, 1]
  const XC = [0, 1, -1, 0, 0, -1, 1, 0]
  const YH = [0, 1, 1, 0, 0, -1, -1, 0]
  const YC = [1, 0, 0, 1, -1, 0, 0, -1]
  // the diagonal cut of the square of half side h at radius cap
  const cutOf = (h, cap) => cap >= h * Math.SQRT2 ? 2 * h : h + Math.sqrt(Math.max(cap * cap - h * h, 0))
  function coverPoint (proj, x, y, z) {
    const cx = proj[0] * x + proj[4] * y + proj[8] * z + proj[12]
    const cy = proj[1] * x + proj[5] * y + proj[9] * z + proj[13]
    const cw = proj[3] * x + proj[7] * y + proj[11] * z + proj[15]
    if (!(cw > 1e-6)) return
    const aspect = Math.abs(proj[0]) > 1e-9 ? proj[5] / proj[0] : 1
    const sx = (cx / cw) * aspect
    const sy = cy / cw
    if (!(sx === sx && sy === sy)) return
    for (let k = 0; k < COVER_DIRS; k++) {
      const d = coverCos[k] * sx + coverSin[k] * sy
      if (d > coverMax[k]) coverMax[k] = d
    }
  }
  function footprint (view, proj, box, cap) {
    coverMax.fill(-1e4)
    shared.gridColumn[0] = 0
    shared.gridColumn[1] = 0
    if (view && proj) {
      const half = Math.max(0.1, fin(box && box[0], 1.02))
      const zLo = fin(box && box[1], 0)
      const zHi = Math.max(zLo, fin(box && box[2], 0.35))
      const halfLo = Math.min(half, Math.max(0.1, fin(box && box[4], half)))
      // the corners past the newest ring are under the rings (flat there)
      const capR = Math.max(0.1, fin(cap, half * Math.SQRT2))
      const sHi = cutOf(half, capR)
      const sLo = cutOf(halfLo, capR)
      shared.gridColumn[0] = half
      shared.gridColumn[1] = sHi * Math.SQRT1_2
      for (let k = 0; k < 16; k++) {
        const top = k >= 8
        const h = top ? half : halfLo
        const sc = top ? sHi : sLo
        const j = k & 7
        const wx = XH[j] * h + XC[j] * (sc - h)
        const wy = YH[j] * h + YC[j] * (sc - h)
        const wz = top ? zHi : zLo
        for (let r = 0; r < 3; r++) {
          boxView[k * 3 + r] = view[r] * wx + view[4 + r] * wy + view[8 + r] * wz + view[12 + r]
        }
        boxDepth[k] = -boxView[k * 3 + 2]
        if (boxDepth[k] >= COVER_NEAR) {
          coverPoint(proj, boxView[k * 3], boxView[k * 3 + 1], boxView[k * 3 + 2])
        }
      }
      // edges crossing the near limit: their crossing point
      for (let e = 0; e < 48; e += 2) {
        const i0 = BOX_EDGES[e]
        const i1 = BOX_EDGES[e + 1]
        const d0 = boxDepth[i0] - COVER_NEAR
        const d1 = boxDepth[i1] - COVER_NEAR
        if ((d0 >= 0) === (d1 >= 0)) continue
        const t = d0 / (d0 - d1)
        coverPoint(proj,
          boxView[i0 * 3] + (boxView[i1 * 3] - boxView[i0 * 3]) * t,
          boxView[i0 * 3 + 1] + (boxView[i1 * 3 + 1] - boxView[i0 * 3 + 1]) * t,
          -COVER_NEAR)
      }
    }
    for (let k = 0; k < 4; k++) {
      shared.coverA[k] = coverMax[k]
      shared.coverB[k] = coverMax[4 + k]
      shared.coverC[k] = coverMax[8 + k]
      shared.coverD[k] = coverMax[12 + k]
    }
  }

  // fills one item of a batch (props reused)
  function item (list, props, n, chunk, part, stride) {
    if (!props[n]) props[n] = {}
    const cp = Object.assign(props[n], shared)
    const rows = rowsDrawn(chunk.rows, stride)
    cp.attr = chunk.attr
    cp.count = rows * indicesPerRow
    if (part === 0) {
      // newest first: a partial chunk is the tail of the list
      cp.elements = stride === 2 ? fillHalf : fillFull
      cp.offset = (rowsDrawn(rowsPerChunk, stride) - rows) * indicesPerRow
    } else {
      cp.elements = stride === 2 ? lineHalf : lineFull
      cp.offset = 0
    }
    list.push(cp)
    return cp
  }

  // p: amount (0..1), palette (uniforms), height (world), start (radius of
  // the newest ring), depth (world distance from the newest ring to the
  // oldest), floor (contrast floor 0..1), brightness, occlusion (0: the
  // strips hide nothing, 1: what they cover is gone), base (opacity of flat
  // lines), lineWidth (device px), fadePow, fog, share (< 0.75: every other
  // row, over the same depth), view / projection (skip the draw when off
  // screen; without them no ring point counts as covering the grid), force,
  // depthBuffer (false: the target has none, the rings do not occlude each
  // other), gridBox ([half, zLo, zHi, centre z, halfLo]: the fabric's
  // bounding volume, half its side at the top, its height range including
  // the 3D shape and the peaks, the height of its centre, and half its side
  // at the bottom).
  // The target's depth must be cleared (depth only) before this draw.
  function draw (p) {
    const amount = Math.max(0, fin(p.amount, 0))
    // force: draw even when invisible (warm-up: compiles the shaders)
    if (amount <= 1e-3 && !p.force) return
    const share = Math.min(Math.max(fin(p.share, 1), 0), 1)
    const stride = share < 0.75 && rowsPerChunk >= 2 ? 2 : 1
    const pal = p.palette
    shared.dirB[0] = Math.cos(azimuth)
    shared.dirB[1] = Math.sin(azimuth)
    shared.startDist = Math.max(0, fin(p.start, 1.25))
    shared.rowStep = Math.max(0.001, fin(p.depth, 5)) / ROWS
    shared.rowStride = stride
    shared.heightScale = Math.max(0, fin(p.height, 0.3))
    shared.floorV = Math.min(Math.max(fin(p.floor, 0.55), 0), 0.98)
    shared.amount = Math.min(amount, 1)
    shared.brightness = Math.max(0, fin(p.brightness, 0.5))
    const occlusion = Math.min(Math.max(fin(p.occlusion, 0.85), 0), 1)
    shared.occlusion = occlusion
    shared.baseLevel = Math.min(Math.max(fin(p.base, 0.02), 0), 1)
    shared.lineWidth = Math.max(0.1, fin(p.lineWidth, 1))
    shared.fadePow = Math.max(0.1, fin(p.fadePow, 1.5))
    shared.fogAmount = Math.min(Math.max(fin(p.fog, 0.5), 0), 1)
    shared.paletteA = pal.paletteA
    shared.paletteB = pal.paletteB
    shared.paletteC = pal.paletteC
    shared.paletteD = pal.paletteD
    shared.paletteShift = pal.paletteShift
    // outer radius (the oldest ring, scrolled by up to one more row)
    const radius = shared.startDist + shared.rowStep * (ROWS + 1)
    // this pass's depth range: from its near plane to past the farthest
    // ring point (an affine z, like a projection with these near / far)
    const n = DEPTH_NEAR
    const f = Math.max(n + 1, Math.hypot(eye[0], eye[1], eye[2]) + radius + shared.heightScale + 1)
    shared.depthAB[0] = -(f + n) / (f - n)
    shared.depthAB[1] = (-2 * f * n) / (f - n)
    // off screen (e.g. the 'top' shot looking down inside the rings)
    if (!p.force && p.view && p.projection && outside(p.view, p.projection, radius)) return
    // the octagon's corners stop just inside the newest ring
    footprint(p.view, p.projection, p.gridBox, shared.startDist - 0.05)

    // strips: only when they hide something (or for the warm-up)
    const strips = occlusion > 0.01 || p.force
    // the lines hidden behind a strip, at 1 - occlusion: only with a
    // depth buffer (without one every line passes both tests)
    const hidden = (occlusion < 0.99 && strips && p.depthBuffer !== false) || p.force

    fillBatch.length = 0
    lineBatch.length = 0
    if (strips) {
      // newest chunk first (front to back for the early depth test)
      let c = 0
      for (let j = chunks.length - 1; j >= 0; j--) {
        if (rowsDrawn(chunks[j].rows, stride) > 0) item(fillBatch, fillProps, c++, chunks[j], 0, stride)
      }
    }
    let c = 0
    for (let pass = 0; pass < (hidden ? 2 : 1); pass++) {
      // oldest chunk first (the lines blend over each other)
      for (let j = 0; j < chunks.length; j++) {
        if (rowsDrawn(chunks[j].rows, stride) <= 0) continue
        const cp = item(lineBatch, lineProps, c++, chunks[j], 1, stride)
        cp.depthFunc = pass === 0 ? 'less' : 'gequal'
        cp.hiddenGain = pass === 0 ? 1 : 1 - occlusion
      }
    }
    if (fillBatch.length) fillCommand(fillBatch)
    if (lineBatch.length) lineCommand(lineBatch)
  }

  function destroy () {
    const free = (res) => { try { if (res) res.destroy() } catch (e) {} }
    free(texture)
    free(vertexBuffer)
    free(fillFull)
    free(fillHalf)
    free(lineFull)
    free(lineHalf)
  }

  return {
    update,
    draw,
    destroy,
    rows: ROWS,
    cols: COLS,
    mode: useFloat ? 'float' : 'uint8'
  }
}
