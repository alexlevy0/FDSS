import { paletteGLSL } from './palette'

// History terrain ("mix landscape"): the last ~16 s of spectra, drawn as a
// stack of ribbon lines receding behind the grid toward the horizon. The
// newest row sits just past the far edge of the grid (as seen from the
// camera), older rows further away, fading with age and distance.
//
// Data: a ring buffer texture, ROWS x COLS, one row per 1/rate s. Each row
// is the mean of the log bands over that interval, resampled to COLS
// columns (max over each group of bands), written with texSubImage2D
// (regl texture.subimage). Float texture when OES_texture_float is there,
// otherwise uint8 (the values are 0..1 anyway). It is only read in the
// vertex shader, with NEAREST filtering at exact texel centres (no float
// linear filtering needed).
//
// Geometry: static, per row (oldest first, so one draw call paints back to
// front): a filled strip from each line down to the base plane, painted
// black (occlusion: older ridges hide behind newer ones, Unknown Pleasures
// style, and the stack never piles up into a white mass), then the line
// itself as screen-space ribbon quads with analytic AA (same technique as
// render-grid.js). Columns are mirrored around the centre: the lowest band
// in the middle, the highs on both sides, tapered flat at the ends.
//
// Orientation: the landscape lies on the far side of the grid from the
// camera. Its direction follows the camera azimuth, smoothed (it lags
// behind fast user drags and fades out while it lags, so it is never drawn
// in front of the grid with a wrong painter's order).
//
// The rows scroll continuously (fractional offset between two writes), and
// stop while the audio is paused.

const TAU = Math.PI * 2
const AZIMUTH_FOLLOW = 1.5 // s, smoothing of the landscape direction

export default function createRenderHistory (regl, opts = {}) {
  const ROWS = Math.max(8, (opts.rows || 192) | 0)
  const COLS = Math.max(4, (opts.cols || 64) | 0)
  const bandCount = Math.max(1, (opts.bandCount || 200) | 0)
  const NX = COLS * 2 - 1 // samples along a row (mirrored columns)
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
  // smoothed direction (away from the camera) and how well it is settled
  let azimuth = 0
  let azimuthReady = false
  let settled = 0

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

    // camera azimuth: eye = -R^T t (column-major view matrix)
    const v = o.view
    if (v) {
      const ex = -(v[0] * v[12] + v[1] * v[13] + v[2] * v[14])
      const ey = -(v[4] * v[12] + v[5] * v[13] + v[6] * v[14])
      if (Math.hypot(ex, ey) > 0.05) {
        const target = Math.atan2(-ey, -ex)
        // snap: a camera cut, the landscape jumps with it instead of
        // fading out while it catches up
        if (!azimuthReady || o.snap) {
          azimuth = target
          azimuthReady = true
        }
        let diff = target - azimuth
        diff -= TAU * Math.round(diff / TAU)
        azimuth += diff * (1 - Math.exp(-dt / AZIMUTH_FOLLOW))
        azimuth -= TAU * Math.round(azimuth / TAU)
        diff = target - azimuth
        diff -= TAU * Math.round(diff / TAU)
        // fades out while it lags more than ~45 degrees behind the camera
        const c = Math.cos(diff)
        const x = Math.min(1, Math.max(0, (c - 0.6) / 0.3))
        settled = x * x * (3 - 2 * x)
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
  const indicesPerRow = 6 * SEGS * 2
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

  // relative index buffers for a chunk of rows (16-bit indices): every row,
  // and every other row (the governor's reduced level: fewer rows over the
  // same depth, the newest row always kept). An even chunk size keeps the
  // row parity the same in every chunk.
  let rowsPerChunk = Math.max(1, Math.min(ROWS, Math.floor(65536 / vertsPerRow)))
  if (rowsPerChunk >= 2 && rowsPerChunk < ROWS) rowsPerChunk -= rowsPerChunk % 2
  const strideParity = (ROWS - 1) % 2 // in-chunk parity of the rows kept at stride 2
  const elementsFull = regl.elements({ data: rowIndices(1, 0), primitive: 'triangles', type: 'uint16' })
  const elementsHalf = regl.elements({ data: rowIndices(2, strideParity), primitive: 'triangles', type: 'uint16' })
  // rows of a chunk of `rowsHere` rows drawn at this stride
  const rowsDrawn = (rowsHere, stride) =>
    stride === 1 ? rowsHere : Math.max(0, Math.ceil((rowsHere - strideParity) / 2))

  function rowIndices (stride, offset) {
    const indices = new Uint16Array(Math.ceil(rowsPerChunk / stride) * indicesPerRow)
    let n = 0
    for (let r = offset; r < rowsPerChunk; r += stride) {
      const base = r * vertsPerRow
      // fill first (painted under this row's line)
      for (let i = 0; i < SEGS; i++) {
        const b0 = base + i * 2
        indices[n++] = b0
        indices[n++] = b0 + 1
        indices[n++] = b0 + 2
        indices[n++] = b0 + 1
        indices[n++] = b0 + 3
        indices[n++] = b0 + 2
      }
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
    return indices.subarray(0, n)
  }

  const f1 = (x) => x.toFixed(1)
  const defines = `
    #define ROWS ${f1(ROWS)}
    #define COLS ${f1(COLS)}
    #define CENTER ${f1(COLS - 1)}
    #define LAST ${f1(NX - 1)}
  `

  const command = regl({
    vert: `
      precision highp float;
      ${defines}
      attribute vec4 vert;
      uniform sampler2D history;
      uniform mat4 projection;
      uniform mat4 view;
      uniform float head;
      uniform float scroll;
      uniform vec2 dirB; // unit, along the ground away from the camera
      uniform float startDist;
      uniform float rowStep;
      uniform float rowStride; // 1, or 2 when every other row is drawn
      uniform float halfWidth;
      uniform float spread;
      uniform float heightScale;
      uniform float floorV; // contrast floor
      uniform float amount;
      uniform float brightness;
      uniform float occlusion;
      uniform float baseLevel;
      uniform float lineWidth; // device px
      uniform float fadePow;
      uniform float fogAmount;
      uniform vec2 halfResolution;
      ${paletteGLSL}

      varying vec4 fragColor;
      varying vec2 edge; // x: signed px from the centre line, y: half core

      const float NEAR = 0.05;
      const float AA_MARGIN = 1.0;

      float valueAt(float i, float age) {
        float col = abs(i - CENTER);
        float row = head - age;
        row += ROWS * step(row, -0.5);
        vec4 s = texture2D(history, vec2((col + 0.5) / COLS, (row + 0.5) / ROWS));
        float v = s.r;
        // NaN guard (v != v), then the contrast floor: quiet stays flat
        if (!(v == v)) v = 0.0;
        float f = clamp((v - floorV) / max(1.0 - floorV, 0.001), 0.0, 1.0);
        return pow(f, 1.3);
      }

      // ground position of sample i at fractional age a, and its lift
      vec3 worldPoint(float i, float a, float f) {
        float d = startDist + a * rowStep;
        float x = (i - CENTER) / CENTER;
        float hw = halfWidth + spread * (d - startDist);
        float taper = 1.0 - smoothstep(0.72, 1.0, abs(x));
        vec2 side = vec2(-dirB.y, dirB.x);
        vec2 p = dirB * d + side * (x * hw);
        return vec3(p, f * heightScale * taper);
      }

      // never project through w <= 0 (should not happen: the landscape
      // stays on the far side; this only keeps it finite)
      vec3 clampNear(vec3 v) {
        return vec3(v.xy, min(v.z, -NEAR));
      }

      vec3 toView(vec3 p) {
        return clampNear((view * vec4(p, 1.0)).xyz);
      }

      vec2 toScreen(vec3 v) {
        vec4 c = projection * vec4(v, 1.0);
        return c.xy / c.w * halfResolution;
      }

      void main() {
        float i = vert.x;
        float age = ROWS - 1.0 - vert.y;
        float a = age + scroll;
        float fc = valueAt(i, age);
        vec3 pc = worldPoint(i, a, fc);

        // fades: in over the first row, out with age, faded by fog
        float ageN = a / ROWS;
        float fadeIn = smoothstep(0.0, 1.0, a);
        float fade = fadeIn * pow(max(1.0 - ageN, 0.0), fadePow);

        if (vert.w == 0.0) {
          // occluding strip: black, from the ridge down to the base plane
          vec3 p = pc;
          if (vert.z < 0.0) p.z = 0.0;
          vec3 v = toView(p);
          gl_Position = projection * vec4(v, 1.0);
          fragColor = vec4(0.0, 0.0, 0.0, clamp(occlusion * amount * fadeIn, 0.0, 1.0));
          edge = vec2(0.0, 1000.0);
          return;
        }

        float ip = max(i - 1.0, 0.0);
        float inx = min(i + 1.0, LAST);
        vec3 pp = worldPoint(ip, a, valueAt(ip, age));
        vec3 pn = worldPoint(inx, a, valueAt(inx, age));
        vec3 cRaw = (view * vec4(pc, 1.0)).xyz;
        vec3 c = clampNear(cRaw);
        vec3 prev = toView(pp);
        vec3 next = toView(pn);

        // distance fog, relative to the depth of the grid centre
        float depth = -c.z;
        float centerDepth = max(-view[3].z, NEAR);
        float fog = fogAmount * smoothstep(centerDepth + startDist * 0.5,
          centerDepth + startDist + rowStep * ROWS, depth);

        // rows crowd together in the distance: dim them by their spacing
        // on screen (dense lines pile up into a white mass). The view is
        // affine: the ground point under pc is cRaw minus its lift along
        // the view's z column, and the next drawn row is one step of
        // worldPoint() further (d += step, hw += spread * step)
        vec3 g0 = cRaw - pc.z * view[2].xyz;
        float stepD = rowStep * rowStride;
        vec2 side = vec2(-dirB.y, dirB.x);
        float x = (i - CENTER) / CENTER;
        vec3 g1 = g0 + (view * vec4((dirB + side * (x * spread)) * stepD, 0.0, 0.0)).xyz;
        float spacing = length(toScreen(clampNear(g1)) - toScreen(clampNear(g0)));
        float density = clamp(spacing / 3.0, 0.08, 1.0);

        float peak = smoothstep(0.25, 1.0, fc);
        vec3 rgb = palette(mix(0.1, 0.9, fc)) * brightness * (1.0 + 0.35 * peak);
        rgb *= 1.0 - 0.5 * fog;
        float opacity = clamp(baseLevel + 1.3 * smoothstep(0.0, 0.7, fc), 0.0, 0.95);
        opacity *= amount * fade * (1.0 - fog) * density;

        float w = lineWidth * mix(1.0, 1.6, peak);
        w *= pow(clamp(centerDepth / depth, 0.35, 3.0), 0.5);
        float core = max(w, 1.0);
        opacity *= clamp(w / core, 0.0, 1.0);

        vec2 d = toScreen(next) - toScreen(prev);
        float len = length(d);
        vec2 tangent = len > 1e-4 ? d / len : vec2(1.0, 0.0);
        vec2 normal = vec2(-tangent.y, tangent.x);
        float halfExtent = 0.5 * core + AA_MARGIN;
        vec4 clip = projection * vec4(c, 1.0);
        clip.xy += normal * (vert.z * halfExtent) / halfResolution * clip.w;

        fragColor = vec4(rgb, clamp(opacity, 0.0, 1.0));
        edge = vec2(vert.z * halfExtent, 0.5 * core);
        gl_Position = clip;
      }
    `,
    frag: `
      #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
      #else
      precision mediump float;
      #endif
      varying vec4 fragColor;
      varying vec2 edge;
      void main() {
        float coverage = clamp(edge.y + 0.5 - abs(edge.x), 0.0, 1.0);
        gl_FragColor = vec4(fragColor.rgb, fragColor.a * coverage);
      }
    `,
    attributes: {
      vert: (ctx, props) => ({ buffer: vertexBuffer, offset: props.vertex * 16, size: 4 })
    },
    uniforms: {
      history: texture,
      head: () => head,
      scroll: () => scroll,
      dirB: regl.prop('dirB'),
      startDist: regl.prop('startDist'),
      rowStep: regl.prop('rowStep'),
      rowStride: regl.prop('rowStride'),
      halfWidth: regl.prop('halfWidth'),
      spread: regl.prop('spread'),
      heightScale: regl.prop('heightScale'),
      floorV: regl.prop('floorV'),
      amount: regl.prop('amount'),
      brightness: regl.prop('brightness'),
      occlusion: regl.prop('occlusion'),
      baseLevel: regl.prop('baseLevel'),
      lineWidth: regl.prop('lineWidth'),
      fadePow: regl.prop('fadePow'),
      fogAmount: regl.prop('fogAmount'),
      paletteA: regl.prop('paletteA'),
      paletteB: regl.prop('paletteB'),
      paletteC: regl.prop('paletteC'),
      paletteD: regl.prop('paletteD'),
      paletteShift: regl.prop('paletteShift'),
      halfResolution: ({ viewportWidth, viewportHeight }) =>
        [Math.max(1, viewportWidth) * 0.5, Math.max(1, viewportHeight) * 0.5]
    },
    blend: {
      enable: true,
      // colour over, alpha of the scene untouched (no accumulation in HDR)
      func: { srcRGB: 'src alpha', dstRGB: 'one minus src alpha', srcAlpha: 0, dstAlpha: 1 },
      equation: { rgb: 'add', alpha: 'add' }
    },
    depth: { enable: false },
    elements: regl.prop('elements'),
    count: regl.prop('count')
  })

  const fin = (x, d) => (typeof x === 'number' && isFinite(x) ? x : d)
  const shared = { dirB: new Float32Array(2) }
  const batch = []
  const chunkProps = [] // reused per-chunk props (no per-frame allocation)

  // frustum test of the landscape's bounding box (8 corners), in clip space
  // with the unjittered view / projection: true when every corner is
  // outside the same clip plane (the landscape is off screen)
  const corner = new Float32Array(4)
  function outside (view, proj) {
    const dx = shared.dirB[0]
    const dy = shared.dirB[1]
    let mask = 63
    for (let k = 0; k < 8; k++) {
      const far = k & 1
      const d = shared.startDist + (far ? shared.rowStep * ROWS : 0)
      const hw = shared.halfWidth + shared.spread * (d - shared.startDist)
      const sx = k & 2 ? hw : -hw
      const wx = dx * d - dy * sx
      const wy = dy * d + dx * sx
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

  // p: amount (0..1), palette (uniforms), height (world), start (distance of
  // the newest row from the centre), depth (world length of the stack),
  // width (half width at the newest row), spread (extra half width per unit
  // of distance), floor (contrast floor 0..1), brightness, occlusion,
  // base (opacity of flat lines), lineWidth (device px), fadePow, fog,
  // share (< 0.75: every other row, over the same depth), view /
  // projection (optional: skip the draw when off screen), force
  function draw (p) {
    const amount = Math.max(0, fin(p.amount, 0)) * settled
    // force: draw even when invisible (warm-up: compiles the shader)
    if (amount <= 1e-3 && !p.force) return
    const share = Math.min(Math.max(fin(p.share, 1), 0), 1)
    const stride = share < 0.75 && rowsPerChunk >= 2 ? 2 : 1
    const pal = p.palette
    shared.dirB[0] = Math.cos(azimuth)
    shared.dirB[1] = Math.sin(azimuth)
    shared.startDist = Math.max(0, fin(p.start, 1.2))
    shared.rowStep = Math.max(0.001, fin(p.depth, 5)) / ROWS
    shared.rowStride = stride
    shared.halfWidth = Math.max(0.05, fin(p.width, 1.3))
    shared.spread = Math.max(0, fin(p.spread, 0.35))
    shared.heightScale = Math.max(0, fin(p.height, 0.3))
    shared.floorV = Math.min(Math.max(fin(p.floor, 0.55), 0), 0.98)
    shared.amount = Math.min(amount, 1)
    shared.brightness = Math.max(0, fin(p.brightness, 0.5))
    shared.occlusion = Math.min(Math.max(fin(p.occlusion, 0.85), 0), 1)
    shared.baseLevel = Math.min(Math.max(fin(p.base, 0.02), 0), 1)
    shared.lineWidth = Math.max(0.1, fin(p.lineWidth, 1))
    shared.fadePow = Math.max(0.1, fin(p.fadePow, 1.5))
    shared.fogAmount = Math.min(Math.max(fin(p.fog, 0.5), 0), 1)
    shared.paletteA = pal.paletteA
    shared.paletteB = pal.paletteB
    shared.paletteC = pal.paletteC
    shared.paletteD = pal.paletteD
    shared.paletteShift = pal.paletteShift
    // off screen (e.g. the 'top' shot looking down at the grid): skip it
    if (!p.force && p.view && p.projection && outside(p.view, p.projection)) return
    batch.length = 0
    let c = 0
    for (let r = 0; r < ROWS; r += rowsPerChunk) {
      const rows = rowsDrawn(Math.min(rowsPerChunk, ROWS - r), stride)
      if (rows <= 0) continue
      if (!chunkProps[c]) chunkProps[c] = {}
      const cp = Object.assign(chunkProps[c++], shared)
      cp.vertex = r * vertsPerRow
      cp.count = rows * indicesPerRow
      cp.elements = stride === 2 ? elementsHalf : elementsFull
      batch.push(cp)
    }
    // oldest chunk first (painter's order)
    command(batch)
  }

  function destroy () {
    const free = (res) => { try { if (res) res.destroy() } catch (e) {} }
    free(texture)
    free(vertexBuffer)
    free(elementsFull)
    free(elementsHalf)
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
