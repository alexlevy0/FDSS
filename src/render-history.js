import { paletteGLSL } from './palette'

// History terrain ("mix landscape"): the last ~16 s of spectra, drawn as
// concentric rings of ribbon lines around the grid. The newest row is a
// ring just outside the grid (radius `start` around the grid centre), older
// rows are larger rings (start + age * step, out to start + depth), fading
// with age and distance. Each ring carries its spectrum all the way around.
//
// Data: a ring buffer texture, ROWS x COLS, one row per 1/rate s. Each row
// is the mean of the log bands over that interval, resampled to COLS
// columns (max over each group of bands), written with texSubImage2D
// (regl texture.subimage). Float texture when OES_texture_float is there,
// otherwise uint8 (the values are 0..1 anyway). It is only read in the
// vertex shader, with NEAREST filtering at exact texel centres (no float
// linear filtering needed); the vertex shader interpolates between columns
// itself (SUB samples per column, so a ring of radius ~6 stays round).
//
// Geometry: static, per row: a filled strip from the line down to the base
// plane (black: occlusion, Unknown Pleasures style, the stack never piles
// up into a white mass) and the line itself as screen-space ribbon quads
// with analytic AA (same technique as render-grid.js). Columns are mirrored
// around the centre: the lowest band at the centre column, the highs at
// both ends, which meet at the ring's seam (same value, same point: no
// taper, no gap).
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
// from the eye (the area around the camera stays clear: the strips there
// are collapsed to zero height in the vertex shader, so they neither draw
// nor write depth, and no fragment shader discards), ribbons fade out
// before the history near plane (GPU clipping does the rest; no vertex is
// projected through w <= 0), and the rows between the eye and the grid
// (camera side, inside the eye's ground radius) are flattened, dimmed and
// cut to the newest few, their strips dropped, so low shots always see the
// grid clearly. Over the grid square itself (the newest rings cross its
// corners) the ridges are flat.
//
// Orientation: the lows (centre column) face away from the camera, on the
// far side, the most visible part. The direction follows the camera
// azimuth, smoothed (it lags behind fast drags; the ring just turns, it is
// never hidden while it lags); a hard cut snaps it.
//
// The rows scroll continuously (fractional offset between two writes), and
// stop while the audio is paused.

const TAU = Math.PI * 2
const AZIMUTH_FOLLOW = 1.5 // s, smoothing of the landscape direction
// history depth range: the near plane of this pass (world units of view
// depth: what is closer is clipped, already faded out), and the fill push
const DEPTH_NEAR = 0.5
const FILL_PUSH = 4 / 65536 // NDC: a couple of 16-bit depth steps

export default function createRenderHistory (regl, opts = {}) {
  const ROWS = Math.max(8, (opts.rows || 192) | 0)
  const COLS = Math.max(4, (opts.cols || 64) | 0)
  const SUB = Math.max(1, (opts.sub || 2) | 0) // samples per column
  const bandCount = Math.max(1, (opts.bandCount || 200) | 0)
  const NX = 2 * SUB * (COLS - 1) + 1 // samples around a ring (mirrored)
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
    #define SUB ${f1(SUB)}
    #define CENTER ${f1(SUB * (COLS - 1))}
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
    uniform float eyeR; // its ground distance from the grid centre
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

    // fractional column of sample i (mirrored: lows at the centre)
    float columnOf(float i) {
      return abs(i - CENTER) / SUB;
    }

    // unit ground direction of sample i: the lows (centre) along dirB,
    // both ends (the highs) meet on the opposite side
    vec2 radial(float i) {
      float th = PI * (i - CENTER) / CENTER;
      vec2 side = vec2(-dirB.y, dirB.x);
      return dirB * cos(th) + side * sin(th);
    }

    // 1 for ground points between the eye and the grid (camera side,
    // inside the eye's ground radius), 0 elsewhere
    float frontOf(vec2 g) {
      float r = length(g);
      float c = dot(g, eye.xy) / max(r * eyeR, 1e-4);
      return smoothstep(0.1, 0.8, c) * smoothstep(-0.25, 0.25, eyeR - r);
    }

    // 0 over the grid square ([-1, 1]^2), 1 past it: the newest rings
    // cross its corners, flat there
    float offGrid(vec2 g) {
      return smoothstep(1.0, 1.15, max(abs(g.x), abs(g.y)));
    }

    // ring point of sample i at fractional age a, lifted by f
    vec3 worldPoint(float i, float a, float f) {
      vec2 g = radial(i) * (startDist + a * rowStep);
      // flattened between the eye and the grid, and over the grid
      return vec3(g, f * heightScale * (1.0 - 0.6 * frontOf(g)) * offGrid(g));
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
      // where the strip occludes: geometry only (occlusion sets how much
      // of what it hides shows through, in the lines' second pass)
      float gate = smoothstep(0.0, 1.0, a) * (1.0 - frontOf(pc.xy)) *
        smoothstep(1.4, 3.0, distance(pc, eye)) *
        smoothstep(DEPTH_NEAR + 0.6, DEPTH_NEAR + 1.4, -vc.z);
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
      float ip = max(i - 1.0, 0.0);
      float inx = min(i + 1.0, LAST);
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
      float front = frontOf(pc.xy);
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
      // clear around the eye, gone before this pass's near plane, gone over
      // the grid square; between the eye and the grid (no strips there to
      // hide the stack) dimmed, and only the newest few rows kept
      opacity *= smoothstep(0.8, 2.0, eyeDist) * offGrid(pc.xy) *
        smoothstep(DEPTH_NEAR, DEPTH_NEAR + 0.5, depth) *
        (1.0 - 0.75 * front) * (1.0 - front * smoothstep(0.0, 8.0, a));

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
    eyeR: regl.prop('eyeR'),
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
  const shared = { dirB: new Float32Array(2), eye, depthAB: new Float32Array(2) }
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
  // row, over the same depth), view / projection (optional: skip the draw
  // when off screen), force, depthBuffer (false: the target has none, the
  // rings do not occlude each other).
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
    shared.eyeR = Math.hypot(eye[0], eye[1])
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
