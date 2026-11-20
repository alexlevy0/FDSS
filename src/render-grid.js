import { createSpring } from 'spring-animator'
import { paletteGLSL } from './palette'
import { WAVE_GLSL } from './render-waves'

// The grid is 2 * (gridLines - 1) lines, alternating x / y axis, drawn as
// screen-space ribbons: every segment is a quad (4 vertices, 2 triangles
// through an index buffer) expanded in the vertex shader perpendicular to
// the projected line, with a width in pixels and analytic anti-aliasing in
// the fragment shader (distance to the centre line -> coverage -> alpha).
// The geometry is static on the GPU: each vertex only carries (line index,
// t, side, which end of its segment it is). The only thing that moves is one
// spring offset per line, simulated on the CPU (a few hundred springs) and
// uploaded once per frame:
//  - as a 1-row texture when the GPU can sample 2 textures in the vertex
//    shader (frequencyVals + offsets). Float texture if OES_texture_float is
//    enabled, otherwise the value is packed in 16 bits (R = high byte,
//    G = low byte) and decoded in the shader;
//  - otherwise as a per-vertex attribute (dynamic buffer) as a fallback.
//
// Vertices are not shared between segments: each quad knows the other end
// of its own segment, so a segment crossing the camera's near plane can be
// clipped in view space (the end behind slides onto the near plane) and a
// segment fully behind collapses to nothing, instead of projecting through
// w <= 0. The ribbon normal still comes from the central difference at each
// sample, identical for the two quads that meet there, so joints have no
// gaps or overlaps.
//
// WebGL1 only guarantees 16-bit indices: the lines are drawn in chunks of
// at most 65536 vertices, all sharing one index buffer (relative indices)
// and pointing their attributes at the chunk's first vertex.

const DEFAULT_SEGMENTS = 100 // segments per line
const OFFSET_RANGE = 4.0 // packed offsets cover -4..4 (springs stay in -2..2)
const VERTS_PER_SEGMENT = 4

let previous = null // GPU resources of the previous instance (setup on resize)

// Alternate forms of the grid. Every vertex position is a blend of the four
// forms with the formWeights uniform (summing to 1), computed in the vertex
// shader from the same static geometry:
//   grid     the orthogonal lines (line offset = x or y, t along the line)
//   circles  concentric rings (offset -> radius, t -> angle); the y-axis
//            lines sit half a ring between the x-axis ones
//   radial   spokes from the centre (offset -> angle, t -> radius)
//   points   every segment shrinks to a round dot at a fixed pseudo-random
//            spot of the disc (the lines break into dashes, then fly apart)
// The state lives at module level so a rebuild (gridLines / segments) keeps
// the current form.
export const GRID_FORMS = ['grid', 'circles', 'radial', 'points']
const formState = {
  weights: [1, 0, 0, 0],
  from: [1, 0, 0, 0],
  target: 0,
  t: 1,
  duration: 5
}

function setForm (name, duration = 5) {
  const index = GRID_FORMS.indexOf(name)
  if (index < 0) return
  if (index === formState.target) return
  for (let i = 0; i < 4; i++) formState.from[i] = formState.weights[i]
  formState.target = index
  formState.duration = Math.max(0, duration)
  formState.t = formState.duration > 0 ? 0 : 1
  if (formState.t >= 1) stepForm(0)
}

function stepForm (dt) {
  if (formState.t >= 1 && formState.weights[formState.target] === 1) return
  formState.t = Math.min(1, formState.t + dt / Math.max(formState.duration, 1e-3))
  const x = formState.t
  const s = x * x * x * (x * (x * 6 - 15) + 10) // smootherstep
  for (let i = 0; i < 4; i++) {
    const to = i === formState.target ? 1 : 0
    formState.weights[i] = formState.from[i] + (to - formState.from[i]) * s
  }
}

// 3D shapes of the fabric, on top of the flat forms above: the base plane
// (whatever form is on it) bends into a surface, every base-plane point p
// landing on a point of the surface, and the audio height (frequencies,
// waves, snare lift) is applied along that surface's normal, so the
// fabric still moves on a ball as it does on the plane. Same scheme as the
// forms: weights (flat + one per shape, summing to 1) eased from wherever
// they are toward the target shape; the vertex shader blends the positions
// (and the analytic normals, for the displacement direction).
// All four shapes are polar maps of the plane (azimuth of p -> around the
// shape's vertical axis, |p| -> along its profile) with the same
// orientation as the plane, so a blend between any two never folds the
// sheet through itself: the plane's centre goes to the bottom of the well,
// the top of the dome / sphere, the inner rim of the torus.
//   tunnel  a funnel sinking below the floor: a deep narrow well flaring
//           out to a wide rim, seen from above (reflection off: see index)
//   dome    a spherical cap, the corners on the floor (breathes: curvature)
//   sphere  a ball resting on the floor, the corners at its bottom pole
//   torus   a ring lying on the floor, slowly turning (spin)
// Module level like the forms, so a rebuild keeps the current shape.
export const GRID_SHAPES = ['flat', 'tunnel', 'dome', 'sphere', 'torus']
const SHAPE = {
  tunnelRadius: 0.45, // radius of the well's narrow part
  tunnelFlare: 0.9, // flare of the rim (x t^3)
  tunnelDepth: 1.8, // depth of the well's bottom below the floor
  domeCurve: 0.55, // rad of arc per base-plane unit (radius 1 / curve)
  sphereRadius: 0.7,
  torusRadius: 0.75, // major radius
  torusTube: 0.32 // radius of the tube
}
// polar angle of the sphere per base-plane unit: the corners (|p| = sqrt 2)
// reach (almost) the bottom pole
const SPHERE_K = Math.PI * 0.98 / Math.SQRT2
// camera framing per shape (camera.setFrame): height of the look-at point
// (the shape's centre), extra eye height, factor on the roaming path radius.
// The well is looked down into from higher and closer, the ball and the
// ring from a little further out, around their centre
const SHAPE_FRAMING = {
  tunnel: [-0.3, 0.9, 0.8],
  dome: [0.2, 0.25, 1.05],
  sphere: [0.7, 0.6, 1.3],
  torus: [0.3, 0.35, 1.12]
}
const shapeState = {
  weights: [1, 0, 0, 0, 0],
  from: [1, 0, 0, 0, 0],
  target: 0,
  t: 1,
  duration: 8
}

function setShape (name, duration = 8) {
  const index = GRID_SHAPES.indexOf(name)
  if (index < 0 || index === shapeState.target) return
  for (let i = 0; i < 5; i++) shapeState.from[i] = shapeState.weights[i]
  shapeState.target = index
  shapeState.duration = Math.max(0, duration || 0)
  shapeState.t = shapeState.duration > 0 ? 0 : 1
  // a snap (duration 0, the hard cuts of a drop) lands at once
  if (shapeState.t >= 1) stepShape(0, true)
}

function stepShape (dt, force) {
  if (!force && shapeState.t >= 1 && shapeState.weights[shapeState.target] === 1) return
  dt = Math.min(Math.max(dt || 0, 0), 0.25)
  shapeState.t = Math.min(1, shapeState.t + dt / Math.max(shapeState.duration, 1e-3))
  const x = shapeState.t
  const s = x * x * x * (x * (x * 6 - 15) + 10) // smootherstep: no pop at either end
  for (let i = 0; i < 5; i++) {
    const to = i === shapeState.target ? 1 : 0
    shapeState.weights[i] = shapeState.from[i] + (to - shapeState.from[i]) * s
  }
}

// effective shape weights (tunnel, dome, sphere, torus) x amount (0..1)
export function shapeWeights (out, amount) {
  const a = Math.min(Math.max(Number(amount) || 0, 0), 1)
  for (let i = 0; i < 4; i++) out[i] = shapeState.weights[i + 1] * a
  return out
}

// camera framing of effective weights w4: [look-at z, eye rise, radius]
export function shapeFraming (out, w4) {
  out[0] = 0
  out[1] = 0
  out[2] = 1
  for (let i = 0; i < 4; i++) {
    const f = SHAPE_FRAMING[GRID_SHAPES[i + 1]]
    const w = w4[i] || 0
    out[0] += w * f[0]
    out[1] += w * f[1]
    out[2] += w * (f[2] - 1)
  }
  return out
}

// GLSL smoothstep(0, 1, x)
function smoothstep01 (x) {
  x = Math.min(Math.max(x, 0), 1)
  return x * x * (3 - 2 * x)
}

// CPU copy of the shader's shapeMap: the world position of base-plane point
// (x, y) lifted by h along the blended normal (sparks start from the real
// surface). w4: effective weights; params: [dome curve, torus spin]
export function shapePoint (out, x, y, h, w4, params) {
  const wsum = w4[0] + w4[1] + w4[2] + w4[3]
  if (!(wsum > 0)) {
    out[0] = x; out[1] = y; out[2] = h
    return out
  }
  const wf = Math.max(1 - wsum, 0)
  let sx = x * wf
  let sy = y * wf
  let sz = 0
  let nx = 0
  let ny = 0
  let nz = wf
  const r0 = Math.hypot(x, y)
  const dx = r0 > 1e-5 ? x / r0 : 1
  const dy = r0 > 1e-5 ? y / r0 : 0
  // profiles stop at the fabric's rim, as in the shader
  const r = Math.min(r0, Math.SQRT2)
  if (w4[0] > 0) {
    const w = w4[0]
    const t = Math.min(r / Math.SQRT2, 1.2)
    const e = Math.exp(-8 * t)
    const u = Math.max(1 - t, 0)
    const su = Math.sqrt(u)
    const rho = SHAPE.tunnelRadius * (1 - e) + SHAPE.tunnelFlare * t * t * t
    const drho = 8 * SHAPE.tunnelRadius * e + 3 * SHAPE.tunnelFlare * t * t
    const dz = 1.5 * SHAPE.tunnelDepth * su
    const il = 1 / Math.hypot(dz, drho)
    sx += w * rho * dx; sy += w * rho * dy; sz += w * -SHAPE.tunnelDepth * u * su
    nx += w * -dz * dx * il; ny += w * -dz * dy * il; nz += w * drho * il
  }
  if (w4[1] > 0) {
    const w = w4[1]
    const k = Math.max(params[0] || SHAPE.domeCurve, 0.05)
    const R = 1 / k
    const th = r * k
    const cz = -R * Math.cos(Math.min(Math.SQRT2 * k, Math.PI))
    const st = Math.sin(th)
    const ct = Math.cos(th)
    sx += w * R * st * dx; sy += w * R * st * dy; sz += w * (cz + R * ct)
    nx += w * st * dx; ny += w * st * dy; nz += w * ct
  }
  if (w4[2] > 0) {
    const w = w4[2]
    const R = SHAPE.sphereRadius
    const th = r * SPHERE_K
    const st = Math.sin(th)
    const ct = Math.cos(th)
    sx += w * R * st * dx; sy += w * R * st * dy; sz += w * (R + R * ct)
    nx += w * st * dx; ny += w * st * dy; nz += w * ct
  }
  if (w4[3] > 0) {
    const w = w4[3]
    const c = Math.cos(params[1] || 0)
    const s = Math.sin(params[1] || 0)
    const ex = dx * c - dy * s
    const ey = dx * s + dy * c
    const v = Math.PI - r * (Math.PI * 2 / Math.SQRT2)
    const cv = Math.cos(v)
    const sv = Math.sin(v)
    // closed to a point at the centre, as in the shader
    const k = smoothstep01(r / 0.12)
    const ring = (SHAPE.torusRadius + SHAPE.torusTube * cv) * k
    sx += w * ring * ex; sy += w * ring * ey; sz += w * (SHAPE.torusTube + SHAPE.torusTube * sv)
    nx += w * cv * ex; ny += w * cv * ey; nz += w * sv
  }
  const nl = Math.hypot(nx, ny, nz)
  if (nl > 1e-3) {
    nx /= nl; ny /= nl; nz /= nl
  } else {
    nx = 0; ny = 0; nz = 1
  }
  out[0] = sx + h * nx
  out[1] = sy + h * ny
  out[2] = sz + h * nz
  return out
}

// Percussion accents (index.js feeds them from features.onSnare / onHat):
//  - snare / clap: a front that sweeps sideways across the fabric's base
//    plane (screen-lateral, alternating sides) in a few hundred ms, briefly
//    brightening the ribbons it crosses and lifting them a hair. Two slots,
//    so a quick second hit does not cut the first front short.
//  - hi-hat: glints, a random handful of ribbon segments (a new handful on
//    every hat) flashing on the highlights only, decaying in ~0.1 s.
// Module level like the forms, so a rebuild keeps fronts in flight.
const WAVE_FROM = -1.45 // front position (along its direction) at birth...
const WAVE_TO = 1.45 // ...and at the end of its sweep: past the fabric's corners
const waveState = {
  slots: [[0, 0, 1, 0], [0, 0, 1, 0]], // uniforms: front, amount, dirX, dirY
  age: [Infinity, Infinity], // s since birth
  strength: [0, 0],
  next: 0,
  side: 1 // alternates the sweep direction
}
const glintState = { env: 0, key: 0 }

// dirX, dirY: lateral direction on the base plane (normalised here);
// side: +1 / -1 to sweep from a given side (index.js shares it with the
// snare line of render-waves), anything else alternates here
function triggerWave (strength, dirX, dirY, side) {
  dirX = Number.isFinite(dirX) ? dirX : 0
  dirY = Number.isFinite(dirY) ? dirY : 0
  const len = Math.hypot(dirX, dirY)
  let s = waveState.side
  if (side === 1 || side === -1) s = side
  waveState.side = -s
  const dx = len > 1e-4 ? dirX / len : 1
  const dy = len > 1e-4 ? dirY / len : 0
  const i = waveState.next
  waveState.next = (i + 1) % 2
  waveState.age[i] = 0
  waveState.strength[i] = Math.min(Math.max(strength || 0, 0), 4)
  waveState.slots[i][2] = dx * s
  waveState.slots[i][3] = dy * s
}

function triggerGlint () {
  glintState.env = 1
  glintState.key = (glintState.key + 1) % 997
}

// duration: s for a front to cross; glintDecay: s for the glints to fade
function stepAccents (dt, duration, glintDecay) {
  const d = Math.max(duration || 0.45, 0.05)
  for (let i = 0; i < 2; i++) {
    waveState.age[i] += dt
    const t = waveState.age[i] / d
    const slot = waveState.slots[i]
    if (!(t < 1)) {
      slot[1] = 0
      continue
    }
    // eased out: fast start, settling as it reaches the far side, and
    // fading with it (in on ~4% of the sweep, so no pop at birth)
    const e = 1 - (1 - t) * (1 - t)
    slot[0] = WAVE_FROM + (WAVE_TO - WAVE_FROM) * e
    slot[1] = waveState.strength[i] * Math.min(1, t * 25) * (1 - t) * (1 - t)
  }
  glintState.env *= Math.exp((-3 * dt) / Math.max(glintDecay || 0.12, 0.01))
}

export default function createRenderGrid (regl, settings, opts = {}) {
  if (previous) previous.destroy()

  const SEGMENTS = Math.max(8, Math.min(200, (opts.segments || DEFAULT_SEGMENTS) | 0))

  const lines = []
  for (let j = 1; j < settings.gridLines; j++) {
    lines.push({
      axis: 'x',
      offset: createSpring(settings.linesDampening, settings.linesStiffness, j / settings.gridLines * 2 - 1)
    })
    lines.push({
      axis: 'y',
      offset: createSpring(settings.linesDampening, settings.linesStiffness, j / settings.gridLines * 2 - 1)
    })
  }
  const lineCount = lines.length

  // static geometry: 4 vertices per segment, (line, t, side, end)
  //   side: -1 / +1, which edge of the ribbon
  //   end: +1 for the segment's first sample (partner at t + step),
  //        -1 for its second sample (partner at t - step)
  const vertsPerLine = SEGMENTS * VERTS_PER_SEGMENT
  const vertexCount = lineCount * vertsPerLine
  const lineT = new Float32Array(vertexCount * 4)
  let k = 0
  for (let i = 0; i < lineCount; i++) {
    for (let q = 0; q < SEGMENTS; q++) {
      const t0 = q / SEGMENTS * 2 - 1
      const t1 = (q + 1) / SEGMENTS * 2 - 1
      lineT.set([i, t0, -1, 1, i, t0, 1, 1, i, t1, -1, -1, i, t1, 1, -1], k)
      k += 16
    }
  }
  const lineTBuffer = regl.buffer(lineT)

  // one index buffer for a chunk of lines, relative to the chunk's first vertex
  const linesPerChunk = Math.max(1, Math.floor(65536 / vertsPerLine))
  const chunkLines = Math.min(linesPerChunk, lineCount)
  const indices = new Uint16Array(chunkLines * SEGMENTS * 6)
  let n = 0
  for (let s = 0; s < chunkLines * SEGMENTS; s++) {
    const b = s * VERTS_PER_SEGMENT
    indices[n++] = b
    indices[n++] = b + 1
    indices[n++] = b + 2
    indices[n++] = b + 1
    indices[n++] = b + 3
    indices[n++] = b + 2
  }
  const elements = regl.elements({ data: indices, primitive: 'triangles', type: 'uint16' })
  const chunks = []
  for (let first = 0; first < lineCount; first += linesPerChunk) {
    const count = Math.min(linesPerChunk, lineCount - first)
    chunks.push({ vertex: first * vertsPerLine, count: count * SEGMENTS * 6 })
  }

  const limits = regl.limits
  const useTexture = limits.maxVertexTextureUnits >= 2 && lineCount <= limits.maxTextureSize
  const useFloat = useTexture && regl.hasExtension('oes_texture_float')
  // propagating waves (render-waves.js): one more vertex texture, so only
  // where the GPU has a unit left after frequencyVals (+ offsets)
  const useWaves = opts.waves !== false &&
    limits.maxVertexTextureUnits >= (useTexture ? 3 : 2)
  // bound when a draw passes no wave map: encoded zero height and slope
  const noWaves = useWaves
    ? regl.texture({ width: 1, height: 1, data: new Uint8Array([128, 128, 128, 255]) })
    : null

  let offsetsData, offsetsTexture, offsetsAttr, offsetsBuffer
  if (useTexture) {
    offsetsData = useFloat ? new Float32Array(lineCount * 4) : new Uint8Array(lineCount * 4)
    offsetsTexture = regl.texture(offsetsTextureOptions())
  } else {
    offsetsAttr = new Float32Array(vertexCount)
    offsetsBuffer = regl.buffer({ usage: 'dynamic', type: 'float', data: offsetsAttr })
  }

  function offsetsTextureOptions () {
    return {
      width: lineCount,
      height: 1,
      data: offsetsData,
      format: 'rgba',
      type: useFloat ? 'float' : 'uint8',
      min: 'nearest',
      mag: 'nearest',
      wrap: 'clamp',
      mipmap: false
    }
  }

  const defines = [
    useTexture ? '#define OFFSETS_TEXTURE' : '',
    useFloat ? '#define OFFSETS_FLOAT' : '',
    useWaves ? '#define WAVES' : '',
    `#define OFFSET_RANGE ${OFFSET_RANGE.toFixed(1)}`,
    `#define SEG_STEP ${(2 / SEGMENTS).toFixed(8)}`,
    // finite-difference step of the lighting normals on the 512^2 freq map:
    // 4 texels (2 / 512 base-plane units each). The map is blurred, so this
    // is smooth, and wide enough that its 8-bit steps do not show as noise
    `#define LIGHT_EPS ${(4 * 2 / 512).toFixed(8)}`,
    // rotation of one segment along a ring of the circles form
    `#define SEG_COS ${Math.cos(Math.PI * 2 / SEGMENTS).toFixed(8)}`,
    `#define SEG_SIN ${Math.sin(Math.PI * 2 / SEGMENTS).toFixed(8)}`,
    // 3D shapes (see GRID_SHAPES), same constants as shapePoint()
    `#define TUNNEL_R ${SHAPE.tunnelRadius.toFixed(4)}`,
    `#define TUNNEL_FLARE ${SHAPE.tunnelFlare.toFixed(4)}`,
    `#define TUNNEL_D ${SHAPE.tunnelDepth.toFixed(4)}`,
    `#define SPHERE_R ${SHAPE.sphereRadius.toFixed(4)}`,
    `#define SPHERE_K ${SPHERE_K.toFixed(8)}`,
    `#define TORUS_R ${SHAPE.torusRadius.toFixed(4)}`,
    `#define TORUS_T ${SHAPE.torusTube.toFixed(4)}`
  ].join('\n')

  const ZERO4 = [0, 0, 1, 0] // no snare front
  const UP3 = [0, 0, 1] // key light straight above (no lightDir given)
  const ZERO4F = [0, 0, 0, 0] // no 3D shape: flat
  const ORIGIN3 = [0, 0, 0]
  const shapeParamsU = [SHAPE.domeCurve, 0]
  // attributes point at the current chunk's first vertex
  const attributes = {
    lineT: (ctx, props) => ({ buffer: lineTBuffer, offset: props.vertex * 16, size: 4 })
  }
  const uniforms = {
    frequencyVals: regl.prop('frequencyVals'),
    gridMaxHeight: regl.prop('gridMaxHeight'),
    multiplier: regl.prop('multiplier'),
    fogAmount: regl.prop('fogAmount'),
    fogStart: regl.prop('fogStart'),
    fogEnd: regl.prop('fogEnd'),
    fogDim: regl.prop('fogDim'),
    paletteA: regl.prop('paletteA'),
    paletteB: regl.prop('paletteB'),
    paletteC: regl.prop('paletteC'),
    paletteD: regl.prop('paletteD'),
    paletteShift: regl.prop('paletteShift'),
    // ribbon width, in device pixels
    widthMin: regl.prop('widthMin'),
    widthPeak: regl.prop('widthPeak'),
    widthDepth: regl.prop('widthDepth'),
    peakGain: regl.prop('peakGain'),
    // mirror floor (reflection pass): mirror = 0 draws the grid itself
    mirror: (ctx, props) => props.mirror ? 1 : 0,
    mirrorPlane: (ctx, props) => props.mirrorPlane || 0,
    mirrorFade: (ctx, props) => props.mirrorFade || 0,
    mirrorAmount: (ctx, props) => (props.mirrorAmount === undefined ? 1 : props.mirrorAmount),
    // colour by height: valleys low on the palette ramp and cooler, peaks
    // high and warmer
    heightColor: (ctx, props) => props.heightColor || 0,
    heightRef: (ctx, props) => Math.max(1e-4, props.heightRef || 0.28),
    heightTint: (ctx, props) => props.heightTint || 0,
    sectionTemp: (ctx, props) => props.sectionTemp || 0,
    // percussion accents (amounts 0 = off; the shader skips them then)
    snareWaveA: (ctx, props) => props.snareAmount > 0 ? waveState.slots[0] : ZERO4,
    snareWaveB: (ctx, props) => props.snareAmount > 0 ? waveState.slots[1] : ZERO4,
    snareGain: (ctx, props) => Math.max(0, props.snareAmount || 0),
    snareWidth: (ctx, props) => Math.max(0.02, props.snareWidth || 0.18),
    snareLift: (ctx, props) => Math.max(0, props.snareLift || 0),
    hatGlint: (ctx, props) => Math.max(0, props.hatAmount || 0) * glintState.env,
    hatKey: () => glintState.key,
    hatShare: (ctx, props) => Math.min(Math.max(props.hatShare === undefined ? 0.06 : props.hatShare, 0), 1),
    // lighting of the fabric (lightAmount 0 = off: the shader skips it)
    lightAmount: (ctx, props) => Math.min(Math.max(props.lightAmount || 0, 0), 2),
    lightDetail: (ctx, props) => props.lightDetail === false ? 0 : 1,
    lightDir: (ctx, props) => props.lightDir || UP3,
    specAmount: (ctx, props) => Math.min(Math.max(props.specAmount || 0, 0), 4),
    rimAmount: (ctx, props) => Math.min(Math.max(props.rimAmount || 0, 0), 4),
    iridAmount: (ctx, props) => Math.min(Math.max(props.iridAmount || 0, 0), 1),
    waveRelief: (ctx, props) => Math.min(Math.max(props.waveRelief === undefined ? 5 : props.waveRelief, 0), 40),
    // 3D shapes: effective weights (tunnel, dome, sphere, torus; 0 = flat,
    // the shader skips the shape maths), dome curvature, torus spin, and
    // the world point the fog and the width falloff are measured from
    shapeWeights: (ctx, props) => props.shapeWeights || ZERO4F,
    shapeOn: (ctx, props) => {
      const w = props.shapeWeights
      return w && w[0] + w[1] + w[2] + w[3] > 1e-4 ? 1 : 0
    },
    shapeParams: (ctx, props) => {
      const s = props.shapeParams
      shapeParamsU[0] = s && s[0] > 0.05 ? Math.min(s[0], 1.5) : SHAPE.domeCurve
      shapeParamsU[1] = s && Number.isFinite(s[1]) ? s[1] : 0
      return shapeParamsU
    },
    shapeCenter: (ctx, props) => props.shapeCenter || ORIGIN3,
    // forms
    formWeights: () => formState.weights,
    lineSpacing: 1 / Math.max(2, settings.gridLines),
    dotSize: (ctx, props) => (props.dotSize === undefined ? 2.5 : props.dotSize),
    halfResolution: ({ viewportWidth, viewportHeight }) =>
      [Math.max(1, viewportWidth) * 0.5, Math.max(1, viewportHeight) * 0.5]
  }
  if (useWaves) {
    // wave map of render-waves.js and its world height at h = 1 (0 = off:
    // the shader skips the fetches)
    uniforms.waveMap = (ctx, props) => props.waveMap || noWaves
    uniforms.waveAmount = (ctx, props) => props.waveMap ? Math.max(0, props.waveAmount || 0) : 0
  }
  if (useTexture) {
    uniforms.offsets = offsetsTexture
    uniforms.lineCount = lineCount
  } else {
    attributes.offset = (ctx, props) => ({ buffer: offsetsBuffer, offset: props.vertex * 4, size: 1 })
  }

  const render = regl({
    vert: `
      precision highp float;
      ${defines}

      // x: line index (even = x axis, odd = y axis), y: t in -1..1,
      // z: side (-1 / +1), w: direction of the segment's other end (+1 / -1)
      attribute vec4 lineT;
      #ifdef OFFSETS_TEXTURE
      uniform sampler2D offsets;
      uniform float lineCount;
      #else
      attribute float offset;
      #endif

      uniform sampler2D frequencyVals;
      uniform mat4 projection;
      uniform mat4 view;
      uniform float gridMaxHeight;
      uniform float multiplier;
      uniform float fogAmount;
      uniform float fogStart;
      uniform float fogEnd;
      uniform float fogDim;
      uniform float widthMin;
      uniform float widthPeak;
      uniform float widthDepth;
      uniform float peakGain;
      uniform float mirror; // 1: reflected below z = mirrorPlane
      uniform float mirrorPlane;
      uniform float mirrorFade;
      uniform float mirrorAmount;
      uniform vec2 halfResolution;
      uniform float heightColor;
      uniform float heightRef;
      uniform float heightTint;
      uniform float sectionTemp;
      uniform vec4 formWeights; // grid, circles, radial, points
      uniform float lineSpacing; // 1 / gridLines
      uniform float dotSize; // px, points form
      // snare fronts: x front position along (z, w), the lateral direction
      // on the base plane; y amount (0 = none)
      uniform vec4 snareWaveA;
      uniform vec4 snareWaveB;
      uniform float snareGain;
      uniform float snareWidth; // half width of a front, base-plane units
      uniform float snareLift; // world units at a front's crest
      uniform float hatGlint; // amount * envelope
      uniform float hatKey; // new subset of glinting segments per hat
      uniform float hatShare; // fraction of the segments that glint
      // lighting (see main): master (0 = skipped), 1 = normals include the
      // fabric's own relief (2 extra fetches) / 0 = wave slopes only, unit
      // direction toward the key light (world, z up), and the term amounts
      uniform float lightAmount;
      uniform float lightDetail;
      uniform vec3 lightDir;
      uniform float specAmount;
      uniform float rimAmount;
      uniform float iridAmount;
      uniform float waveRelief; // normal exaggeration of the (shallow) waves
      // 3D shapes (see GRID_SHAPES): weights tunnel, dome, sphere, torus
      // (flat = the rest), 1 when any is non-zero (else skipped), x dome
      // curvature / y torus spin, and the world point fog and width
      // falloff are measured from (the shape's centre, the origin when flat)
      uniform vec4 shapeWeights;
      uniform float shapeOn;
      uniform vec2 shapeParams;
      uniform vec3 shapeCenter;
      #ifdef WAVES
      // propagating waves (render-waves.js): waveDecode(texture2D(waveMap,
      // uv)) = (height -1..1, slope along base x, y); world units are
      // x waveAmount (before the intro multiplier)
      uniform sampler2D waveMap;
      uniform float waveAmount;
      ${WAVE_GLSL}
      #endif
      ${paletteGLSL}

      varying vec4 fragColor;
      // x: signed distance to the centre line (px), y: half core width (px),
      // z: position along the segment (px from its first end, negative or
      // beyond w on the round caps), w: segment length (px)
      varying vec4 edge;

      // view-space depth (-z) in front of which geometry is kept
      const float NEAR = 0.02;
      const float AA_MARGIN = 1.0; // px of geometry beyond the core, for the AA ramp
      const float PI = 3.14159265359;
      const float TAU = 6.28318530718;
      const float SQRT2 = 1.41421356237;
      // finite-difference step of the shapes' tangents (lighting normals)
      const float SHAPE_EPS = 0.01;

      // hash without sine (stable in fp32 on every GPU)
      vec2 hash22(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.xx + p3.yz) * p3.zy);
      }

      // base-plane positions (-1..1) of the samples t - step (pp), t (pc)
      // and t + step (pn) of a line, clamped to its ends, blended between
      // the forms; dotPos is the point-cloud spot of the vertex's segment.
      // The three share their trigonometry: a ring's neighbours are the
      // same point rotated by one step, a spoke's lie along the same
      // direction.
      void formPoints(float off, float axisY, float t, vec2 dotPos,
                      out vec2 pp, out vec2 pc, out vec2 pn) {
        float tp = max(t - SEG_STEP, -1.0);
        float tn = min(t + SEG_STEP, 1.0);
        pp = mix(vec2(off, tp), vec2(tp, off), axisY) * formWeights.x;
        pc = mix(vec2(off, t), vec2(t, off), axisY) * formWeights.x;
        pn = mix(vec2(off, tn), vec2(tn, off), axisY) * formWeights.x;
        if (formWeights.y > 0.0) {
          // rings spread a little past the fabric's disc (0.9) to thin them
          float r = abs((off + 1.0) * 0.575 + axisY * 0.575 * lineSpacing);
          // y rings rotated a little so the closing points do not line up
          float a = (t + 1.0) * PI + axisY * 0.7;
          vec2 u = formWeights.y * r * vec2(cos(a), sin(a));
          // one step back / forward along the ring (none past the ends)
          vec2 up = t > -1.0 ? vec2(u.x * SEG_COS + u.y * SEG_SIN, u.y * SEG_COS - u.x * SEG_SIN) : u;
          vec2 un = t < 1.0 ? vec2(u.x * SEG_COS - u.y * SEG_SIN, u.y * SEG_COS + u.x * SEG_SIN) : u;
          pp += up;
          pc += u;
          pn += un;
        }
        if (formWeights.z > 0.0) {
          float a = (off + 1.0) * PI + axisY * PI * lineSpacing;
          vec2 u = formWeights.z * vec2(cos(a), sin(a));
          pp += mix(0.05, 1.0, (tp + 1.0) * 0.5) * u;
          pc += mix(0.05, 1.0, (t + 1.0) * 0.5) * u;
          pn += mix(0.05, 1.0, (tn + 1.0) * 0.5) * u;
        }
        vec2 spot = formWeights.w * dotPos;
        pp += spot;
        pc += spot;
        pn += spot;
      }

      float lineOffset() {
        #ifdef OFFSETS_TEXTURE
        vec4 s = texture2D(offsets, vec2((lineT.x + 0.5) / lineCount, 0.5));
        #ifdef OFFSETS_FLOAT
        return s.r;
        #else
        float hi = floor(s.r * 255.0 + 0.5);
        float lo = floor(s.g * 255.0 + 0.5);
        return ((hi * 256.0 + lo) / 65535.0 * 2.0 - 1.0) * OFFSET_RANGE;
        #endif
        #else
        return offset;
        #endif
      }

      // how much the snare fronts cover a base-plane point (0..~2): a
      // gaussian across each front, sharper on its leading edge
      float waveFront(vec4 wv, vec2 p) {
        float x = (dot(p, wv.zw) - wv.x) / snareWidth;
        x *= x < 0.0 ? 1.0 : 1.8;
        return wv.y * exp(-x * x);
      }
      float snareAt(vec2 p) {
        // uniform branch: no front in flight costs nothing
        if (snareWaveA.y + snareWaveB.y <= 0.0) return 0.0;
        return waveFront(snareWaveA, p) + waveFront(snareWaveB, p);
      }

      // A base-plane point on the blended 3D shape (call only when shapeOn):
      // returns the world position, n the unit direction the audio height
      // is applied along (the blend of the shapes' analytic normals; the
      // lighting measures the true normal of the blend, see main). Polar
      // maps: azimuth of p around the vertical axis, |p| along the profile.
      vec3 shapeMap(vec2 p, out vec3 n) {
        float wsum = dot(shapeWeights, vec4(1.0));
        float wf = max(1.0 - wsum, 0.0);
        vec3 s = vec3(p, 0.0) * wf;
        n = vec3(0.0, 0.0, wf);
        float r0 = length(p);
        vec2 dir = r0 > 1e-5 ? p / r0 : vec2(1.0, 0.0);
        // the profiles are laid out for the fabric (|p| <= sqrt 2); lines
        // shuffled further out (offsets up to +-2) would wrap past the
        // sphere's pole, under the dome's floor or around the torus tube a
        // second time: they stop at the rim instead (and fade out, main)
        float r = min(r0, SQRT2);
        if (shapeWeights.x > 0.0) {
          // tunnel: the plane's centre at the bottom of the well, the
          // corners on its rim at floor level
          float t = min(r / SQRT2, 1.2);
          float e = exp(-8.0 * t);
          float u = max(1.0 - t, 0.0);
          float su = sqrt(u);
          float rho = TUNNEL_R * (1.0 - e) + TUNNEL_FLARE * t * t * t;
          float drho = 8.0 * TUNNEL_R * e + 3.0 * TUNNEL_FLARE * t * t;
          float dz = 1.5 * TUNNEL_D * su;
          // (drho > 0 everywhere: never a zero vector)
          s += shapeWeights.x * vec3(rho * dir, -TUNNEL_D * u * su);
          n += shapeWeights.x * vec3(-dz * dir, drho) * inversesqrt(dz * dz + drho * drho);
        }
        if (shapeWeights.y > 0.0) {
          // dome: arc length along the cap ~ |p| (radius 1 / curvature)
          float k = shapeParams.x;
          float R = 1.0 / k;
          float th = r * k;
          vec3 nd = vec3(sin(th) * dir, cos(th));
          float cz = -R * cos(min(SQRT2 * k, PI));
          s += shapeWeights.y * (vec3(0.0, 0.0, cz) + R * nd);
          n += shapeWeights.y * nd;
        }
        if (shapeWeights.z > 0.0) {
          // sphere: the centre of the plane on top, its corners at the
          // bottom pole, resting on the floor
          float th = r * SPHERE_K;
          vec3 nd = vec3(sin(th) * dir, cos(th));
          s += shapeWeights.z * (vec3(0.0, 0.0, SPHERE_R) + SPHERE_R * nd);
          n += shapeWeights.z * nd;
        }
        if (shapeWeights.w > 0.0) {
          // torus: from the inner equator over the top, around the outside
          // and back underneath; turned by the spin
          float c = cos(shapeParams.y);
          float sn = sin(shapeParams.y);
          vec2 d = vec2(dir.x * c - dir.y * sn, dir.x * sn + dir.y * c);
          float v = PI - r * (TAU / SQRT2);
          float cv = cos(v);
          float sv = sin(v);
          // the plane's centre maps to the inner equator (radius 0.43, not
          // 0) and dir flips across it: the ramp closes that disc to a
          // point, so a line through the centre cannot jump across the
          // hole (main also fades the ribbons there)
          float k = smoothstep(0.0, 0.12, r);
          s += shapeWeights.w * vec3((TORUS_R + TORUS_T * cv) * k * d, TORUS_T + TORUS_T * sv);
          n += shapeWeights.w * vec3(cv * d, sv);
        }
        // opposite normals can cancel mid-morph (e.g. the sphere's
        // underside against the plane): no NaN, fall back to up
        float nl = dot(n, n);
        n = nl > 1e-6 ? n * inversesqrt(nl) : vec3(0.0, 0.0, 1.0);
        return s;
      }

      // a base-plane point lifted by the frequencies, in view space; w
      // carries the frequency value (the view matrix is affine, so w would
      // be 1). surf: the wave slope there (xy, world units per base-plane
      // unit, before the multiplier) and the height (z, along the surface
      // normal); world: the lifted point in world space (never mirrored);
      // nrm: the direction it was lifted along, for the lighting
      vec4 gridPoint(vec2 p, out vec3 surf, out vec3 world, out vec3 nrm) {
        float f = texture2D(frequencyVals, (p + 1.0) * 0.5).x;
        // the snare front lifts what is already up (scaled by f), so the
        // flat dark parts of the fabric stay flat
        float lift = f * gridMaxHeight + snareLift * snareAt(p) * min(f * 3.0, 1.0);
        surf = vec3(0.0);
        #ifdef WAVES
        // the waves move the whole fabric, dark parts included (they only
        // show where the ribbons are lit); uniform branch when off
        if (waveAmount > 0.0) {
          vec3 wv = waveDecode(texture2D(waveMap, (p + 1.0) * 0.5));
          lift += waveAmount * wv.x;
          surf.xy = waveAmount * wv.yz;
        }
        #endif
        float h = lift * multiplier;
        surf.z = h;
        // on the 3D shape (uniform branch: flat costs nothing), the height
        // along its normal, so the audio still moves the bent fabric
        vec3 base = vec3(p, 0.0);
        nrm = vec3(0.0, 0.0, 1.0);
        if (shapeOn > 0.0) base = shapeMap(p, nrm);
        world = base + h * nrm;
        // reflection across the plane z = mirrorPlane (below the grid)
        vec3 wm = vec3(world.xy, mix(world.z, 2.0 * mirrorPlane - world.z, mirror));
        vec4 v = view * vec4(wm, 1.0);
        return vec4(v.xyz, f);
      }

      // a in front of the near plane, b behind: the point between them on it
      vec3 toNear(vec3 a, vec3 b) {
        float s = (-NEAR - a.z) / (b.z - a.z);
        return mix(a, b, clamp(s, 0.0, 1.0));
      }

      vec2 toScreen(vec3 v) {
        vec4 c = projection * vec4(v, 1.0);
        return c.xy / c.w * halfResolution;
      }

      void main() {
        float off = lineOffset();
        // 0 for x-axis lines (even index), 1 for y-axis lines (odd index)
        float axisY = step(0.5, lineT.x - 2.0 * floor(lineT.x * 0.5 + 0.25));
        float t = lineT.y;

        // the segment this vertex belongs to, and its point-cloud spot
        // (uniform over a disc of radius 0.95)
        float segStart = lineT.w > 0.0 ? t : t - SEG_STEP;
        float seg = floor((segStart + 1.0) / SEG_STEP + 0.5);
        vec2 h = hash22(vec2(lineT.x + 1.0, seg + 1.0));
        float da = h.y * TAU;
        vec2 dotPos = sqrt(h.x) * 0.95 * vec2(cos(da), sin(da));

        vec2 pp;
        vec2 pc;
        vec2 pn;
        formPoints(off, axisY, t, dotPos, pp, pc, pn);
        vec3 surf; // the centre sample's wave slope and height
        vec3 worldC; // ... its world position
        vec3 nrmC; // ... and the direction it was lifted along
        vec3 unused;
        vec3 unusedW;
        vec3 unusedN;
        vec4 c4 = gridPoint(pc, surf, worldC, nrmC);
        vec4 p4 = c4;
        vec4 n4 = c4;
        // a pure point cloud puts all three samples on the segment's dot:
        // one frequency fetch instead of three (uniform branch)
        if (formWeights.w < 1.0) {
          p4 = gridPoint(pp, unused, unusedW, unusedN);
          n4 = gridPoint(pn, unused, unusedW, unusedN);
        }
        vec3 c = c4.xyz;
        vec3 prev = p4.xyz;
        vec3 next = n4.xyz;
        float frequencyVal = c4.w;
        vec3 partner = lineT.w > 0.0 ? next : prev;

        // the two samples the ribbon direction is measured between
        vec3 a;
        vec3 b;
        if (c.z > -NEAR) {
          // behind the near plane: slide onto it toward the segment's other
          // end, or collapse the whole segment (all 4 vertices to one point
          // outside the clip volume) when that end is behind too
          if (partner.z > -NEAR) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            fragColor = vec4(0.0);
            edge = vec4(0.0);
            return;
          }
          c = toNear(partner, c);
          a = lineT.w > 0.0 ? c : partner;
          b = lineT.w > 0.0 ? partner : c;
        } else {
          a = prev.z > -NEAR ? toNear(c, prev) : prev;
          b = next.z > -NEAR ? toNear(c, next) : next;
        }

        // colour by height (of the original point, also for the mirror):
        // the palette position moves from the intensity toward the height,
        // low on the ramp in the valleys and high on the peaks, and the
        // colour temperature follows (cooler valleys, warmer peaks), plus
        // the section's temperature. Same palette, so each track keeps its
        // identity.
        float hc = frequencyVal * gridMaxHeight * multiplier;
        float hn = smoothstep(0.0, 1.0, clamp(hc / heightRef, 0.0, 1.0));
        float tc = mix(frequencyVal, mix(0.12, 0.98, hn), heightColor);
        vec3 rgb = palette(tc) * 0.95;
        float temp = clamp((hn * 2.0 - 1.0) * heightTint + sectionTemp, -1.0, 1.0);
        rgb *= max(vec3(0.0), 1.0 + temp * vec3(0.16, 0.02, -0.2));
        float opacity = clamp(pow(frequencyVal * 1.5, 2.0), 0.0, 0.95) * multiplier;
        // rings put about twice the line length of the grid on the fabric's
        // disc: dimmer, so the form does not flood into a white mass
        // rings and dots pile up into a white mass: keep them dimmer than lines
        opacity *= 1.0 - 0.6 * formWeights.y;
        opacity *= 1.0 - 0.65 * formWeights.w;
        // spokes converge at the centre: thin them out there
        opacity *= 1.0 - formWeights.z * (1.0 - smoothstep(0.02, 0.4, (t + 1.0) * 0.5));
        if (shapeOn > 0.0) {
          // on a 3D shape: lines shuffled past the fabric (|p| > sqrt 2)
          // stop at the rim (shapeMap), so they fade out as the shape
          // grows and come back as it flattens; and the torus' pinched
          // centre (a point inside the hole) is hidden
          float rc = length(pc);
          opacity *= 1.0 - min(1.0, dot(shapeWeights, vec4(1.0))) * smoothstep(1.42, 1.55, rc);
          opacity *= mix(1.0, smoothstep(0.04, 0.14, rc), min(shapeWeights.w * 2.0, 1.0));
        }

        // Lighting of the fabric. The ribbons stay emissive lines: the light
        // only MODULATES their colour, measured against the flat fabric, so
        // a flat area looks as before and only the relief (frequency peaks,
        // waves) changes it. Per vertex, on the original surface seen from
        // the real eye, in the mirror pass too: the reflection shows the
        // grid's own highlights, like a glossy floor.
        //  - normal from the height field's slope: forward differences of
        //    the freq map (lightDetail) plus the wave map's slope, which is
        //    exaggerated (waveRelief) since the waves are only mm high;
        //  - shading relative to the flat plane: slopes facing the key
        //    light brighten, slopes facing away dim a little;
        //  - Blinn-Phong specular from the orbiting key light;
        //  - rim: the view-dependent fresnel in excess of the flat plane's,
        //    i.e. the crests' silhouettes, in the palette's accent colour;
        //  - thin-film iridescence: a hue shift with the view angle.
        // Specular and rim also add a little opacity, on slopes only, so
        // wave crests catch light even where the fabric is dark.
        float lightReveal = 0.0;
        if (lightAmount > 0.0) {
          vec2 g = surf.xy * waveRelief;
          if (lightDetail > 0.0) {
            float fx = texture2D(frequencyVals, (pc + vec2(LIGHT_EPS, 0.0) + 1.0) * 0.5).x;
            float fy = texture2D(frequencyVals, (pc + vec2(0.0, LIGHT_EPS) + 1.0) * 0.5).x;
            g += gridMaxHeight * (vec2(fx, fy) - frequencyVal) / LIGHT_EPS;
          }
          // the intro flattens the fabric and its light with it; clamped so
          // nothing can push the normal to Inf / NaN
          g = clamp(g * multiplier, -20.0, 20.0);
          // tangents of the base surface along base x / y and its normal:
          // the plane's, or on a 3D shape the finite differences of the
          // blended shape itself (ALU only, no fetch), so the normal
          // follows the surface actually drawn, mid-morph included
          vec3 tx = vec3(1.0, 0.0, 0.0);
          vec3 ty = vec3(0.0, 1.0, 0.0);
          vec3 n0 = vec3(0.0, 0.0, 1.0);
          vec3 refN = n0;
          if (shapeOn > 0.0) {
            // two more full shape evaluations per vertex: only at full
            // detail (the governor drops lightDetail at level 3), and not
            // at the very centre, where the polar maps' direction flips.
            // Otherwise a frame around the blended analytic normal: the
            // base axes projected on the tangent plane
            if (lightDetail > 0.0 && dot(pc, pc) > SHAPE_EPS * SHAPE_EPS) {
              vec3 sc = worldC - surf.z * nrmC;
              vec3 dn;
              tx = (shapeMap(pc + vec2(SHAPE_EPS, 0.0), dn) - sc) / SHAPE_EPS;
              ty = (shapeMap(pc + vec2(0.0, SHAPE_EPS), dn) - sc) / SHAPE_EPS;
            } else {
              tx = vec3(1.0, 0.0, 0.0) - nrmC.x * nrmC;
              tx = dot(tx, tx) > 1e-6 ? normalize(tx) : normalize(cross(vec3(0.0, 1.0, 0.0), nrmC));
              ty = cross(nrmC, tx);
            }
            vec3 cn = cross(tx, ty);
            float cl = dot(cn, cn);
            n0 = cl > 1e-10 ? cn * inversesqrt(cl) : nrmC;
            // the rim compares with a reference between the shape and the
            // plane: the shape's silhouettes catch some of the rim light
            refN = normalize(mix(vec3(0.0, 0.0, 1.0), n0, 0.75) + vec3(0.0, 0.0, 1e-4));
          }
          // the relief's slope tilts the lifted surface: d/dx (S + h N) ~
          // T + g N (flat: exactly normalize(-g, 1) as before)
          vec3 n = cross(tx + g.x * nrmC, ty + g.y * nrmC);
          float nl2 = dot(n, n);
          n = nl2 > 1e-10 ? n * inversesqrt(nl2) : n0;
          // eye = -R^T t (the view matrix is a rigid lookAt)
          vec3 eye = -vec3(dot(view[0].xyz, view[3].xyz),
            dot(view[1].xyz, view[3].xyz), dot(view[2].xyz, view[3].xyz));
          vec3 toEye = eye - worldC;
          vec3 V = toEye * inversesqrt(max(dot(toEye, toEye), 1e-8));
          // seen from below (a dive under the fabric, the far side of a
          // ball): light the side the eye sees, against the base surface
          // seen from that side
          float sd = dot(n0, V) < 0.0 ? -1.0 : 1.0;
          n *= sd;
          float ndl = dot(n, lightDir);
          float shade = clamp(1.0 + 0.9 * lightAmount * (ndl - dot(n0, lightDir) * sd), 0.6, 1.5);
          vec3 hv = lightDir + V;
          hv *= inversesqrt(max(dot(hv, hv), 1e-8));
          // ndh^24 by squaring (no pow(0, y) edge cases)
          float s = clamp(dot(n, hv), 0.0, 1.0);
          float s2 = s * s;
          float s8 = s2 * s2 * s2 * s2;
          float spec = s8 * s8 * s8 * clamp(ndl * 4.0, 0.0, 1.0);
          // slopes only: the flat fabric's mirror-like hot spot stays faint
          float slope = smoothstep(0.04, 0.3, length(g));
          spec *= mix(0.35, 1.0, slope);
          float ndv = clamp(dot(n, V), 0.0, 1.0);
          float fv = 1.0 - ndv;
          float ff = 1.0 - clamp(abs(dot(refN, V)), 0.0, 1.0);
          float rim = clamp((fv * fv * fv - ff * ff * ff) * 4.0, 0.0, 1.0) * (0.4 + 0.6 * hn);
          // accent: the top of the palette ramp, a little more saturated
          vec3 acc = palette(0.92);
          acc = max(mix(vec3(dot(acc, vec3(0.2126, 0.7152, 0.0722))), acc, 1.4), 0.0);
          vec3 specCol = mix(vec3(1.0, 0.97, 0.92), acc, 0.3);
          // thin film (n = 1.33): the path length goes with the cosine of
          // the refracted angle; three cosines a third of a cycle apart
          // average exactly 0.5, so 2 * irid keeps the mean brightness
          float cosT = sqrt(1.0 - (1.0 - ndv * ndv) * 0.5653);
          vec3 irid = 0.5 + 0.5 * cos(TAU * (cosT * 1.7 + hn * 0.35 + vec3(0.0, 0.333, 0.667)));
          float ia = clamp(iridAmount * lightAmount * (0.5 + 0.5 * slope), 0.0, 1.0);
          rgb *= shade * mix(vec3(1.0), irid * 2.0, ia);
          float sa = spec * specAmount * lightAmount;
          float ra = rim * rimAmount * lightAmount;
          rgb += specCol * (sa * 1.2) + acc * (ra * 0.8);
          lightReveal = min((sa + ra) * slope * 0.25, 0.3);
        }

        // distance fog, relative to the depth of the grid centre so it
        // follows the roaming camera: the far side of the grid recedes
        float depth = -c.z;
        // the shape's centre (the origin when flat: -view[3].z as before)
        float centerDepth = max(-(view * vec4(shapeCenter, 1.0)).z, NEAR);
        float fog = fogAmount * smoothstep(centerDepth + fogStart, centerDepth + fogEnd, depth);
        rgb *= 1.0 - fogDim * fog;
        opacity *= 1.0 - fog;

        // reflection: fainter the further the original point is above the
        // mirror (peaks fade first) and a little dimmer with depth
        if (mirror > 0.5) {
          float above = max(hc - mirrorPlane, 0.0);
          opacity *= mirrorAmount * exp(-mirrorFade * above);
          opacity *= 1.0 - 0.5 * fog;
        }
        // light caught by the slopes (fogged and mirrored like the rest)
        opacity = min(opacity + lightReveal * multiplier * (1.0 - fog) * mix(1.0, mirrorAmount, mirror), 0.98);

        // width: thin in quiet parts, thicker (and brighter) on the peaks,
        // a little thinner in the distance for depth
        float peak = smoothstep(0.2, 1.0, frequencyVal);
        float w = mix(widthMin, widthPeak, peak);
        // dots of the point cloud: their own size, bigger on the peaks
        w = mix(w, dotSize * mix(1.0, 1.8, peak), formWeights.w);
        w *= pow(clamp(centerDepth / depth, 0.35, 3.0), widthDepth);
        rgb *= 1.0 + peakGain * peak;

        // snare: the front brightens the contours it crosses (relative to
        // their own opacity: a dark area gets a faint rim, not a white band)
        float sw = min(snareAt(pc) * snareGain, 2.0);
        rgb *= 1.0 + 1.2 * sw;
        // the small additive part shows the whole grid's contour inside the
        // front (fogged and mirrored like the rest)
        float rim = 0.04 * sw * multiplier * (1.0 - fog) * mix(1.0, mirrorAmount, mirror);
        opacity = min(opacity * (1.0 + 0.6 * sw) + rim, 0.98);

        // hi-hat glints: one segment in 1 / hatShare, a different subset on
        // every hat, only where the ribbon is already a highlight
        if (hatGlint > 0.0) {
          vec2 g = hash22(vec2(lineT.x * 1.37 + hatKey * 7.0, seg + hatKey * 3.1));
          float pick = step(1.0 - hatShare, g.x);
          float hl = smoothstep(0.25, 0.85, frequencyVal);
          rgb *= 1.0 + 2.5 * hatGlint * pick * hl * (0.5 + g.y);
        }
        // below 1px the ribbon stays 1px wide and fades instead (same
        // amount of light, no sub-pixel shimmer)
        float core = max(w, 1.0);
        opacity *= clamp(w / core, 0.0, 1.0);

        // screen-space direction; degenerate (line seen end-on, or a dot of
        // the point cloud) -> any direction
        vec2 d = toScreen(b) - toScreen(a);
        float len = length(d);
        vec2 tangent = len > 1e-4 ? d / len : vec2(1.0, 0.0);
        vec2 normal = vec2(-tangent.y, tangent.x);

        float halfExtent = 0.5 * core + AA_MARGIN;
        // round caps, only for the point cloud (lines keep exact joints):
        // the quad also grows along the segment, first end backward
        float capExt = formWeights.w * halfExtent;
        // between the CLIPPED ends (c is already on the near plane when it
        // was behind it; then the partner is in front), so both ends of the
        // quad agree and no screen position comes from a w near 0
        vec3 partnerC = partner.z > -NEAR ? toNear(c, partner) : partner;
        float segLen = length(toScreen(partnerC) - toScreen(c));
        vec4 clip = projection * vec4(c, 1.0);
        vec2 shift = normal * (lineT.z * halfExtent) - tangent * (lineT.w * capExt);
        clip.xy += shift / halfResolution * clip.w;

        fragColor = vec4(rgb, opacity);
        edge = vec4(lineT.z * halfExtent, 0.5 * core,
          lineT.w > 0.0 ? -capExt : segLen + capExt, segLen);
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
      varying vec4 edge;
      void main() {
        // analytic coverage of a 1px-wide pixel footprint across the core;
        // beyond the segment's ends (round caps of the dots) the distance is
        // measured to the nearest end. Lines never go beyond: same as before.
        float outside = max(max(-edge.z, edge.z - edge.w), 0.0);
        float dist = length(vec2(edge.x, outside));
        float coverage = clamp(edge.y + 0.5 - dist, 0.0, 1.0);
        gl_FragColor = vec4(fragColor.rgb, fragColor.a * coverage);
      }
    `,
    uniforms,
    blend: {
      enable: true,
      func: {
        srcRGB: 'src alpha',
        srcAlpha: 1,
        dstRGB: 'one minus src alpha',
        dstAlpha: 1
      },
      equation: {
        rgb: 'add',
        alpha: 'add'
      }
    },
    depth: { enable: false },
    attributes,
    elements,
    count: regl.prop('count')
  })

  function uploadOffsets () {
    if (useTexture) {
      for (let i = 0; i < lineCount; i++) {
        const v = lines[i].offset.tick(1, false)
        if (useFloat) {
          offsetsData[i * 4] = v
        } else {
          const n = Math.min(1, Math.max(0, (v / OFFSET_RANGE + 1) / 2))
          const packed = Math.round(n * 65535)
          offsetsData[i * 4] = packed >> 8
          offsetsData[i * 4 + 1] = packed & 255
        }
      }
      // same size and type every frame: update the existing storage
      // (texSubImage2D) instead of re-specifying the whole texture
      offsetsTexture.subimage(offsetsData)
    } else {
      let p = 0
      for (let i = 0; i < lineCount; i++) {
        const v = lines[i].offset.tick(1, false)
        for (let q = 0; q < vertsPerLine; q++) offsetsAttr[p++] = v
      }
      offsetsBuffer.subdata(offsetsAttr)
    }
  }

  // Reshuffles: on musical phrases when the tempo is trusted, else every
  // settings.reshuffleInterval seconds (the old fixed 9.5 s timer). The
  // per-line stagger (linesAnimationOffset ms per line) runs on the frame
  // clock instead of hundreds of timeouts.
  const INITIAL_DELAY = 24.5 // s before the first reshuffle, as before
  let elapsed = 0 // s since this grid was created
  let sinceReshuffle = 0
  let sweepTime = 0 // s since the last reshuffle started
  const pendingValue = new Float32Array(lineCount)
  const pendingAt = new Float32Array(lineCount).fill(-1) // sweepTime, or -1

  let calls = 0
  function setLinesOffsets () {
    let xVal = 1
    let yVal = 1
    calls += 1
    calls = calls % 2
    const randomGranularity = ((Math.random() * 10 | 0) + 1) / 5
    lines.forEach((line, i) => {
      let nextVal
      if (calls === 0) {
        nextVal = ((line.axis === 'x' ? xVal++ : yVal++) / settings.gridLines * 2 - 1) * randomGranularity
      } else if (calls === 1) {
        nextVal = Math.random() * 2 - 1
      } else {
        nextVal = (line.axis === 'x' ? xVal++ : yVal++) / settings.gridLines * 2 - 1
      }

      // lines still pending from the previous sweep get the new value
      pendingValue[i] = nextVal
      pendingAt[i] = (i * settings.linesAnimationOffset) / 1000
    })
    sweepTime = 0
    sinceReshuffle = 0
  }

  // dt: seconds; features: the analysis features (onPhrase, bpmConfidence)
  function tick (dt, features) {
    dt = Math.min(Math.max(dt || 0, 0), 0.25)
    stepForm(dt)
    elapsed += dt
    sinceReshuffle += dt
    if (elapsed >= INITIAL_DELAY) {
      const onPhrase = settings.reshuffleOnPhrase !== false && features &&
        features.bpmConfidence >= settings.reshuffleConfidence
      if (onPhrase) {
        // a minimum gap keeps short phrases (fast tempo, 16 beats) calm
        if (features.onPhrase && sinceReshuffle >= settings.reshuffleMinGap) setLinesOffsets()
        // tempo trusted but no phrase for very long (should not happen)
        else if (sinceReshuffle >= settings.reshuffleInterval * 4) setLinesOffsets()
      } else if (sinceReshuffle >= settings.reshuffleInterval) {
        setLinesOffsets()
      }
    }
    stepAccents(dt, settings.snareWaveTime, settings.hatGlintDecay)
    sweepTime += dt
    for (let i = 0; i < lineCount; i++) {
      if (pendingAt[i] >= 0 && sweepTime >= pendingAt[i]) {
        lines[i].offset.updateValue(pendingValue[i])
        pendingAt[i] = -1
      }
    }
  }

  previous = {
    destroy () {
      // ignore resources already freed (e.g. by regl.destroy())
      const free = (res) => { try { if (res) res.destroy() } catch (e) {} }
      free(lineTBuffer)
      free(elements)
      free(offsetsTexture)
      free(offsetsBuffer)
      free(noWaves)
    }
  }

  // props: frequencyVals, gridMaxHeight, multiplier, fogAmount, fogStart,
  // fogEnd, fogDim, paletteA..D, paletteShift, widthMin, widthPeak (device
  // px), widthDepth, peakGain; optional heightColor, heightRef (world units),
  // heightTint, sectionTemp (-1 cool .. 1 warm), dotSize (device px),
  // waveMap (render-waves.js wave map) + waveAmount (world units, 0 = off),
  // lighting: lightAmount (0 = off), lightDetail (false: wave slopes only,
  // no extra fetches), lightDir (unit, toward the light), specAmount,
  // rimAmount, iridAmount, waveRelief; 3D shapes: shapeWeights (shapeWeights()
  // x amount, absent = flat), shapeParams ([dome curve, torus spin]),
  // shapeCenter (world [x, y, z] the fog / width depth are measured from)
  const drawProps = chunks.map(() => ({}))
  // uploads this frame's line offsets and steps the springs; renderGrid()
  // does it itself unless prepare() already ran this frame (so an extra
  // draw() before it, like the reflection, sees the same offsets)
  let prepared = false
  function prepare () {
    uploadOffsets()
    for (const line of lines) {
      line.offset.tick()
    }
    prepared = true
  }
  const NO_MIRROR = { mirror: 0, mirrorPlane: 0, mirrorFade: 0, mirrorAmount: 1 }
  function draw (props) {
    for (let c = 0; c < chunks.length; c++) {
      // the props objects are reused: reset the mirror fields first so a
      // reflection draw does not leak into the next plain draw
      const p = Object.assign(drawProps[c], NO_MIRROR, props)
      p.vertex = chunks[c].vertex
      p.count = chunks[c].count
    }
    render(drawProps)
  }
  function renderGrid (props) {
    if (!prepared) prepare()
    prepared = false
    draw(props)
  }
  renderGrid.prepare = prepare
  // morph to another form ('grid' | 'circles' | 'radial' | 'points') over
  // duration seconds (eased; a change in the middle of a morph starts from
  // whatever is on screen)
  renderGrid.setForm = setForm
  renderGrid.getForm = () => GRID_FORMS[formState.target]
  renderGrid.formWeights = formState.weights
  // bend into a 3D shape (GRID_SHAPES, 'flat' = none) over duration seconds
  // (eased; 0 snaps), and step that morph (once per frame, before the
  // camera reads the framing: index.js does it right after the director)
  renderGrid.setShape = setShape
  renderGrid.getShape = () => GRID_SHAPES[shapeState.target]
  renderGrid.stepShape = stepShape
  // draw with the current offsets, without stepping anything (mirror pass;
  // props as renderGrid plus mirror, mirrorPlane, mirrorFade, mirrorAmount)
  renderGrid.draw = draw
  // advance the reshuffle schedule (once per frame, before rendering)
  renderGrid.tick = tick
  // start a reshuffle now (resets the schedule)
  renderGrid.reshuffle = setLinesOffsets
  // percussion accents: a snare front sweeping along (dirX, dirY) on the
  // base plane (strength ~0..1), and a new set of hi-hat glints
  renderGrid.snare = triggerWave
  renderGrid.hat = triggerGlint
  // whether the shader samples the wave map (props waveMap, waveAmount)
  renderGrid.wavesSupported = useWaves
  // how the offsets reach the GPU (for debugging)
  renderGrid.segments = SEGMENTS
  renderGrid.drawCalls = chunks.length
  renderGrid.offsetsMode = useTexture ? (useFloat ? 'texture-float' : 'texture-rgba8-packed') : 'attribute'
  return renderGrid
}

