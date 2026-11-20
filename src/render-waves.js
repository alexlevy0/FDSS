// Propagating waves on the fabric: a damped 2D wave equation simulated on
// the GPU in a small square texture covering the fabric's base plane
// (uv = (p + 1) / 2, the same mapping as the freq map), ping-ponged between
// two state buffers every substep, then resolved into a filterable "wave
// map" (height + gradient) that render-grid.js samples in its vertex shader.
//
// State per texel: height h (-1..1, "sim units") and vertical velocity v.
// One substep (symplectic Euler, so a velocity form: the frame dt can vary
// without breaking the integrator the way a (h, previous h) leapfrog does):
//   v' = (v + (c^2 * laplacian(h) - k * h) * dt) * exp(-(damping + sponge) * dt)
//   h' = h + v' * dt + sources
// The small restoring term k * h pulls the fabric back to its rest plane:
// without it the mean height is a conserved mode (the sources are all
// positive bumps and the border reflects), so the whole fabric would creep
// up kick after kick and never come back down in silence.
// The explicit scheme is stable for c * dt / dx <= 1 / sqrt(2) (5-point
// Laplacian in 2D): each frame is split into ceil(c dt / (CFL dx)) substeps,
// capped per quality tier; past the cap the simulation runs slower than
// real time instead of becoming unstable.
//
// Borders: the state is sampled with clamp-to-edge, a zero-gradient
// (reflecting) border, inside a sponge band whose extra damping absorbs
// most of a wave: what comes back is a soft echo, not a hard bounce.
// Energy clamp: h and v are clamped every substep, a soft limiter brakes
// texels moving further out past |h| = 0.6, and NaN is replaced by 0, so
// nothing can grow without bound or reach TAA / bloom.
//
// Sources are added to the height, spread over ATTACK seconds (so a kick
// swells in over a few frames instead of popping in one):
//   kick   a wide gaussian bump (low spatial frequencies dominate: a slow,
//          broad ring spreading out)
//   snare  a narrow line (gaussian across, long gaussian along it): a
//          plane-ish wave travelling sideways from it
//   drive  a very wide, gentle push / pull at the centre (bass changes)
// With no source the waves die out through the damping; once a CPU estimate
// of the remaining amplitude is negligible the buffers are cleared to exact
// zero and the passes are skipped until the next impulse (so silence costs
// nothing, and 16-bit / half-float rounding cannot leave a residual shimmer).
//
// Storage: the scene's HDR type (half float / float, see gpu-hdr.js) when
// the GPU can render it; otherwise uint8 RGBA, with h and v each packed in
// 16 bits (needs highp in the fragment shader, else the waves are off).
// The wave map is always encoded the same way, in 0..1, so one decoder
// works for both: see WAVE_GLSL.
import { FRAG_PRECISION } from './render-bloom'

const ATTACK = 0.05 // s over which an impulse is fed in
const CFL = 0.6 // c * dt / dx per substep (limit 1 / sqrt(2) ~ 0.707)
const MAX_DT = 0.05 // s, longest frame simulated (a stall does not jump ahead)
const VMAX = 32 // velocity clamp, sim height units / s
const SPONGE_WIDTH = 0.08 // uv, absorbing band along the borders
const SPONGE_DAMPING = 5 // 1 / s extra damping at the very edge
const REST_LEVEL = 0.003 // estimated amplitude under which the waves are cleared
const RESTORE = 4 // k, 1 / s^2: the mean height oscillates at ~0.3 Hz and damps

// gradient range of the wave map, in sim height units per base-plane unit
export const WAVE_GRAD_RANGE = 16

// GLSL decoder of the wave map (texture2D(waveMap, uv), uv = (p + 1) / 2):
//   x  height, -1..1 (world height = x * waveAmount * multiplier)
//   yz gradient d(height) / d(base-plane x, y), sim units per base-plane
//      unit (world slope = yz * waveAmount * multiplier)
// The encoding is (value * 127 + 128) / 255 so that 0 is exact in uint8.
export const WAVE_GLSL = `
      vec3 waveDecode(vec4 s) {
        vec3 e = (s.rgb * 255.0 - 128.0) / 127.0;
        return vec3(e.x, e.yz * ${WAVE_GRAD_RANGE.toFixed(1)});
      }
`

const PACK_GLSL = `
      // 16-bit fixed point in two uint8 channels; 32768 is exactly 0
      vec2 enc16(float x) {
        float n = clamp(floor(x * 32767.0 + 32768.5), 0.0, 65535.0);
        float hi = floor(n / 256.0);
        return vec2(hi, n - hi * 256.0) / 255.0;
      }
      float dec16(vec2 c) {
        float n = floor(c.x * 255.0 + 0.5) * 256.0 + floor(c.y * 255.0 + 0.5);
        return (n - 32768.0) / 32767.0;
      }
`

const VERT = `
  precision highp float;
  attribute vec2 position;
  void main() { gl_Position = vec4(position, 0, 1); }
`

const FULLSCREEN = [-1, -1, -1, 4, 4, -1]

function fragmentHighp (regl) {
  const gl = regl._gl
  if (!gl || !gl.getShaderPrecisionFormat) return true
  try {
    const f = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)
    return !!f && f.precision > 0
  } catch (e) {
    return false
  }
}

const finite = (x, fallback = 0) => (typeof x === 'number' && isFinite(x) ? x : fallback)

// opts: size (texels per side), type / hdr (from detectHdr)
export default function createRenderWaves (regl, opts = {}) {
  const hdrType = opts.hdr && opts.type && opts.type !== 'uint8' ? opts.type : null
  const packed = !hdrType
  // packing 16 bits needs > mediump precision in the fragment shader
  const supported = !packed || fragmentHighp(regl)
  const stateType = hdrType || 'uint8'
  let size = Math.max(16, Math.min(512, (opts.size || 256) | 0))

  const makeState = (n) => regl.framebuffer({
    color: regl.texture({
      width: n, height: n, type: stateType, min: 'nearest', mag: 'nearest', wrap: 'clamp'
    }),
    depth: false,
    stencil: false
  })
  const states = [makeState(size), makeState(size)]
  // the wave map: filterable, sampled by the grid's VERTEX shader. Always
  // RGBA8: it is encoded to 0..1 for the uint8 decoder anyway (WAVE_GLSL),
  // and float / half-float textures in the vertex stage (fetch, let alone
  // linear filtering) are unreliable on WebGL1 drivers even where
  // detectHdr found them fine in a fragment shader
  const map = regl.framebuffer({
    color: regl.texture({
      width: size, height: size, type: 'uint8', min: 'linear', mag: 'linear', wrap: 'clamp'
    }),
    depth: false,
    stencil: false
  })
  let current = 0 // index of the state holding the latest step

  const ZERO_STATE = packed ? [128 / 255, 0, 128 / 255, 0] : [0, 0, 0, 0]
  const ZERO_MAP = [128 / 255, 128 / 255, 128 / 255, 1]

  const defines = [
    packed ? '#define PACKED' : '',
    `#define VMAX ${VMAX.toFixed(1)}`,
    `#define SPONGE_WIDTH ${SPONGE_WIDTH.toFixed(4)}`,
    `#define SPONGE_DAMPING ${SPONGE_DAMPING.toFixed(4)}`,
    `#define RESTORE ${RESTORE.toFixed(4)}`
  ].join('\n')

  const LOAD_GLSL = `
      ${PACK_GLSL}
      // (h, v) of the texel at uv
      vec2 load(vec2 p) {
        vec4 s = texture2D(state, p);
        #ifdef PACKED
        return vec2(dec16(s.rg), dec16(s.ba) * VMAX);
        #else
        return s.rg;
        #endif
      }
  `

  const simulate = regl({
    vert: VERT,
    frag: `
      ${FRAG_PRECISION}
      ${defines}
      uniform sampler2D state;
      uniform float texel; // 1 / size
      uniform float dt; // s, this substep
      uniform float c2; // (wave speed / dx)^2, 1 / s^2
      uniform float damping; // 1 / s
      uniform vec4 kick; // x, y (uv), sigma (uv), height added this substep
      uniform vec4 snareLine; // x, y (uv), direction along the line
      uniform vec3 snareShape; // sigma across, sigma along (uv), height
      uniform vec4 drive; // x, y (uv), sigma (uv), height added this substep
      ${LOAD_GLSL}

      float gauss(vec2 d, float sigma) {
        return exp(-dot(d, d) / (2.0 * sigma * sigma));
      }

      void main() {
        vec2 uv = gl_FragCoord.xy * texel;
        vec2 c = load(uv);
        // clamp-to-edge: the border texel is its own neighbour (reflection)
        float lap = load(uv - vec2(texel, 0.0)).x + load(uv + vec2(texel, 0.0)).x +
          load(uv - vec2(0.0, texel)).x + load(uv + vec2(0.0, texel)).x - 4.0 * c.x;
        // sponge band along the borders
        vec2 e = min(uv, 1.0 - uv);
        float sponge = SPONGE_DAMPING * (1.0 - smoothstep(0.0, SPONGE_WIDTH, min(e.x, e.y)));
        float v = (c.y + (c2 * lap - RESTORE * c.x) * dt) * exp(-(damping + sponge) * dt);
        // soft limiter: brake what keeps moving outward past |h| = 0.6
        float over = smoothstep(0.6, 1.0, abs(c.x)) * step(0.0, v * c.x);
        v *= 1.0 - 0.5 * over;
        float h = c.x + v * dt;

        // sources (uniform branches: zero when idle)
        if (kick.w != 0.0) h += kick.w * gauss(uv - kick.xy, kick.z);
        if (snareShape.z != 0.0) {
          vec2 d = uv - snareLine.xy;
          float along = dot(d, snareLine.zw);
          float across = dot(d, vec2(-snareLine.w, snareLine.z));
          h += snareShape.z * exp(-across * across / (2.0 * snareShape.x * snareShape.x)
            - along * along / (2.0 * snareShape.y * snareShape.y));
        }
        if (drive.w != 0.0) h += drive.w * gauss(uv - drive.xy, drive.z);

        // energy clamp; NaN fails both comparisons and becomes 0
        h = abs(h) < 2.0 ? clamp(h, -1.0, 1.0) : 0.0;
        v = abs(v) < 2.0 * VMAX ? clamp(v, -VMAX, VMAX) : 0.0;
        #ifdef PACKED
        gl_FragColor = vec4(enc16(h), enc16(v / VMAX));
        #else
        gl_FragColor = vec4(h, v, 0.0, 1.0);
        #endif
      }
    `,
    attributes: { position: FULLSCREEN },
    uniforms: {
      state: regl.prop('state'),
      texel: regl.prop('texel'),
      dt: regl.prop('dt'),
      c2: regl.prop('c2'),
      damping: regl.prop('damping'),
      kick: regl.prop('kick'),
      snareLine: regl.prop('snareLine'),
      snareShape: regl.prop('snareShape'),
      drive: regl.prop('drive')
    },
    count: 3,
    depth: { enable: false },
    blend: { enable: false },
    framebuffer: regl.prop('fbo')
  })

  // height + central-difference gradient, encoded for linear filtering
  const resolve = regl({
    vert: VERT,
    frag: `
      ${FRAG_PRECISION}
      ${defines}
      uniform sampler2D state;
      uniform float texel;
      uniform float gradScale; // texel differences -> per base-plane unit
      ${LOAD_GLSL}
      vec3 enc(vec3 x) { return (clamp(x, -1.0, 1.0) * 127.0 + 128.0) / 255.0; }
      void main() {
        vec2 uv = gl_FragCoord.xy * texel;
        float h = load(uv).x;
        float gx = load(uv + vec2(texel, 0.0)).x - load(uv - vec2(texel, 0.0)).x;
        float gy = load(uv + vec2(0.0, texel)).x - load(uv - vec2(0.0, texel)).x;
        gl_FragColor = vec4(enc(vec3(h, vec2(gx, gy) * gradScale)), 1.0);
      }
    `,
    attributes: { position: FULLSCREEN },
    uniforms: {
      state: regl.prop('state'),
      texel: regl.prop('texel'),
      gradScale: regl.prop('gradScale')
    },
    count: 3,
    depth: { enable: false },
    blend: { enable: false },
    framebuffer: regl.prop('fbo')
  })

  // pending impulses: base-plane positions converted to uv, fed in over ATTACK
  const kickSrc = { x: 0.5, y: 0.5, amp: 0, remain: 0 }
  const snareSrc = { x: 0.5, y: 0.5, dx: 0, dy: 1, amp: 0, remain: 0 }
  let activity = 0 // CPU estimate of the largest amplitude still on the fabric
  let resting = true // buffers are exact zero and the passes are skipped

  function clearAll () {
    for (const s of states) regl.clear({ color: ZERO_STATE, framebuffer: s })
    regl.clear({ color: ZERO_MAP, framebuffer: map })
    resting = true
    activity = 0
  }
  clearAll()

  function setSize (n) {
    n = Math.max(16, Math.min(512, n | 0))
    if (n === size) return
    size = n
    for (const s of states) s.resize(n)
    map.resize(n)
    clearAll() // the old field cannot be resampled meaningfully: restart
  }

  // x, y: base plane (-1..1); amp: sim height (clamped 0..1)
  function kick (x, y, amp) {
    amp = Math.min(Math.max(finite(amp), 0), 1)
    if (amp <= 0) return
    kickSrc.x = Math.min(Math.max(finite(x) * 0.5 + 0.5, 0), 1)
    kickSrc.y = Math.min(Math.max(finite(y) * 0.5 + 0.5, 0), 1)
    kickSrc.amp = amp
    kickSrc.remain = ATTACK
    activity = Math.min(1, activity + amp)
  }

  // a line through (x, y) along (dirX, dirY), all on the base plane
  function snare (x, y, dirX, dirY, amp) {
    amp = Math.min(Math.max(finite(amp), 0), 1)
    if (amp <= 0) return
    // sanitised before use: a NaN direction would wipe the whole field
    const ux = finite(dirX)
    const uy = finite(dirY)
    const len = Math.hypot(ux, uy)
    snareSrc.dx = len > 1e-4 ? ux / len : 0
    snareSrc.dy = len > 1e-4 ? uy / len : 1
    snareSrc.x = Math.min(Math.max(finite(x) * 0.5 + 0.5, 0), 1)
    snareSrc.y = Math.min(Math.max(finite(y) * 0.5 + 0.5, 0), 1)
    snareSrc.amp = amp
    snareSrc.remain = ATTACK
    activity = Math.min(1, activity + amp)
  }

  // height a source adds during a substep of length h
  function feed (src, h) {
    if (src.remain <= 0) return 0
    const t = Math.min(h, src.remain)
    src.remain -= t
    return src.amp * t / ATTACK
  }

  const kickU = [0.5, 0.5, 0.09, 0]
  const snareLineU = [0.5, 0.5, 0, 1]
  const snareShapeU = [0.022, 0.3, 0]
  const driveU = [0.5, 0.5, 0.22, 0]
  const simProps = {
    state: null, fbo: null, texel: 1, dt: 0, c2: 0, damping: 1,
    kick: kickU, snareLine: snareLineU, snareShape: snareShapeU, drive: driveU
  }
  const resolveProps = { state: null, fbo: map, texel: 1, gradScale: 1 }

  // o.dt: s; o.speed: base-plane units / s; o.damping: 1 / s; o.drive:
  // height / s pushed at the centre (signed, gentle); o.maxSteps: substep
  // cap of the quality tier; o.size: texels per side for this tier;
  // o.enabled: false clears and skips; o.force: run the passes even at rest
  // (warm-up, so the shaders compile). Returns true while waves are live.
  function update (o) {
    if (!supported) return false
    if (!o.enabled) {
      kickSrc.remain = snareSrc.remain = 0
      if (!resting) clearAll()
      if (!o.force) return false
    }
    // the tier's resolution is applied at rest only: resizing restarts the
    // field (it cannot be resampled meaningfully), which would pop every
    // wave in flight each time the governor crosses a tier
    if (o.size && resting) setSize(o.size)

    const dt = Math.min(Math.max(finite(o.dt), 0), MAX_DT)
    const damping = Math.max(finite(o.damping, 1), 0.05)
    const drive = Math.min(Math.max(finite(o.drive), -2), 2)
    // decay of the amplitude estimate (v damping -> amplitude ~ exp(-d t / 2));
    // the drive keeps it up while it pushes
    activity = Math.min(1, activity * Math.exp(-0.5 * damping * dt) + Math.abs(drive) * dt)
    const pending = kickSrc.remain > 0 || snareSrc.remain > 0
    if (!pending && activity < REST_LEVEL && !o.force) {
      if (!resting) clearAll()
      return false
    }
    resting = false

    // substeps: CFL-safe for the wave speed in texels / s
    const cN = Math.max(finite(o.speed), 0) * 0.5 * size // uv / s * texels per uv
    const maxSteps = Math.max(1, Math.min(8, (o.maxSteps || 4) | 0))
    let steps = cN > 0 ? Math.ceil((cN * dt) / CFL) : 1
    let simDt = dt
    if (steps > maxSteps) {
      steps = maxSteps
      simDt = (steps * CFL) / cN // slower than real time, still stable
    }
    steps = Math.max(1, steps)
    const h = simDt / steps

    simProps.texel = 1 / size
    simProps.dt = h
    simProps.c2 = cN * cN
    simProps.damping = damping
    kickU[0] = kickSrc.x
    kickU[1] = kickSrc.y
    snareLineU[0] = snareSrc.x
    snareLineU[1] = snareSrc.y
    snareLineU[2] = snareSrc.dx
    snareLineU[3] = snareSrc.dy
    for (let i = 0; i < steps; i++) {
      kickU[3] = feed(kickSrc, h)
      snareShapeU[2] = feed(snareSrc, h)
      driveU[3] = drive * h
      simProps.state = states[current]
      simProps.fbo = states[1 - current]
      simulate(simProps)
      current = 1 - current
    }

    resolveProps.state = states[current]
    resolveProps.texel = 1 / size
    // (h(x + dx) - h(x - dx)) / (2 dx), dx = 2 / size base-plane units,
    // then into the encoded range
    resolveProps.gradScale = size / 4 / WAVE_GRAD_RANGE
    resolve(resolveProps)
    return true
  }

  return {
    update,
    kick,
    snare,
    reset: clearAll,
    // the wave map (sampler2D, decode with WAVE_GLSL)
    texture: map,
    supported,
    get active () { return !resting },
    get size () { return size },
    mode: supported ? (packed ? 'rgba8 packed' : stateType) : 'off (no highp)'
  }
}
