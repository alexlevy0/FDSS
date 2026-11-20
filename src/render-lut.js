// Per-section 3D colour LUTs, generated procedurally at startup (no image
// assets) and blended on the CPU into one N^3 strip texture that the final
// post pass samples in display space (render-post applyLut).
//
// Why blend on the CPU: a LUT lookup is linear in the table, so the weighted
// sum of the section tables (and the mix with the identity by `amount`) is
// exactly the weighted sum of their outputs. The shader then pays 2 fetches
// whatever the number of sections in play, and the strip is only rebuilt
// and re-uploaded while the weights actually move (section transitions take
// seconds; a steady section costs nothing).
//
// Layout: N slices of N x N side by side, a (N*N) x N uint8 RGBA texture:
// texel (b * N + r, g). N = 32 (1024 x 32) or 16 (256 x 16), both POT.
//
// What the looks do (and do not): the section grade in render-post already
// does the global moves (black level, mid gamma, saturation, temperature);
// these tables only do what a grade cannot: tone-curve shape, split toning
// and bleach bypass. Black stays black except in the breakdown's (very
// slightly) lifted teal blacks, and white stays near white, so the thin
// glowing ribbons on black remain the picture.

export const LUT_SECTIONS = ['breakdown', 'build', 'drop', 'groove']

const LUMA_R = 0.2126
const LUMA_G = 0.7152
const LUMA_B = 0.0722
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}
const luma = (c) => LUMA_R * c[0] + LUMA_G * c[1] + LUMA_B * c[2]

// filmic S-curve around a pivot: power `k` (> 1 = more contrast) on each
// side, so 0 -> 0, pivot -> pivot, 1 -> 1, monotonic, no clipping
function sCurve (x, k, pivot) {
  x = clamp01(x)
  return x < pivot
    ? pivot * Math.pow(x / pivot, k)
    : 1 - (1 - pivot) * Math.pow((1 - x) / (1 - pivot), k)
}
function curve (c, k, pivot) {
  for (let i = 0; i < 3; i++) c[i] = sCurve(c[i], k, pivot)
}
// a tint with its luminance removed: split toning moves hue, not brightness
function chroma (rgb) {
  const l = luma(rgb)
  return [rgb[0] - l, rgb[1] - l, rgb[2] - l]
}
// Split toning: shadows tint where there is something to tint (0 at pure
// black, so the black gaps stay black), highlight tint easing off again at
// the very top so the brightest cores stay close to white
function splitTone (c, shadow, shadowAmt, high, highAmt) {
  const l = luma(c)
  const ws = smoothstep(0, 0.08, l) * (1 - smoothstep(0.12, 0.5, l)) * shadowAmt
  const wh = smoothstep(0.45, 0.85, l) * (1 - 0.6 * smoothstep(0.88, 1, l)) * highAmt
  for (let i = 0; i < 3; i++) c[i] += shadow[i] * ws + high[i] * wh
}
function saturate (c, s) {
  const l = luma(c)
  for (let i = 0; i < 3; i++) c[i] = l + s * (c[i] - l)
}
// raises the blacks toward a tint (0 at white)
function lift (c, amount, tint) {
  for (let i = 0; i < 3; i++) c[i] += amount * tint[i] * (1 - c[i])
}
// bleach bypass: the colour overlaid with its own luminance (the skipped
// bleach leaves a silver B&W image on top), mixed in by `a`
function bleach (c, a) {
  const l = luma(c)
  for (let i = 0; i < 3; i++) {
    const x = clamp01(c[i])
    const o = l < 0.5 ? 2 * l * x : 1 - 2 * (1 - l) * (1 - x)
    c[i] += (o - c[i]) * a
  }
}
// crushes the toe: values under `t` go to 0, the rest rescales
function crush (c, t) {
  for (let i = 0; i < 3; i++) c[i] = Math.max(0, (c[i] - t) / (1 - t))
}

const TEAL = chroma([0.3, 0.75, 0.85])
const COOL = chroma([0.85, 0.95, 1.1])
const WARM = chroma([1.1, 0.98, 0.78])
const GOLD = chroma([1.12, 1, 0.72])

// display-referred rgb in (array, modified in place)
const LOOKS = {
  // breakdown: cool teal shadows, faintly lifted (teal) blacks, a softer
  // curve and slightly muted colour: air between the lines
  breakdown (c) {
    lift(c, 0.02, [0.55, 1, 1.1])
    curve(c, 0.93, 0.45)
    splitTone(c, TEAL, 0.5, COOL, 0.25)
    saturate(c, 0.94)
  },
  // build: rising, warm contrast
  build (c) {
    curve(c, 1.12, 0.45)
    splitTone(c, COOL, 0.15, WARM, 0.35)
    saturate(c, 1.03)
  },
  // drop: punchy, deep blacks, a touch of bleach bypass (silvery, hard
  // contrast); the saturation mostly gives back what the bleach takes, the
  // grade's own saturation does the rest
  drop (c) {
    crush(c, 0.008)
    curve(c, 1.22, 0.42)
    bleach(c, 0.18)
    saturate(c, 1.1)
  },
  // groove: neutral, a gentle filmic S-curve and warm highlights
  groove (c) {
    curve(c, 1.06, 0.45)
    splitTone(c, COOL, 0.08, GOLD, 0.25)
  }
}

export default function createRenderLut (regl, { size = 32 } = {}) {
  const N = size === 16 ? 16 : 32
  const W = N * N
  const count = N * N * N

  // the section tables, float rgb at each lattice point, in texel order
  const tables = {}
  const c = [0, 0, 0]
  for (const name of LUT_SECTIONS) {
    const t = new Float32Array(count * 3)
    for (let g = 0; g < N; g++) {
      for (let b = 0; b < N; b++) {
        for (let r = 0; r < N; r++) {
          const ri = r / (N - 1)
          const gi = g / (N - 1)
          const bi = b / (N - 1)
          c[0] = ri; c[1] = gi; c[2] = bi
          LOOKS[name](c)
          const k = ((g * N + b) * N + r) * 3
          // a broken look never reaches the screen: identity instead
          t[k] = Number.isFinite(c[0]) ? clamp01(c[0]) : ri
          t[k + 1] = Number.isFinite(c[1]) ? clamp01(c[1]) : gi
          t[k + 2] = Number.isFinite(c[2]) ? clamp01(c[2]) : bi
        }
      }
    }
    tables[name] = t
  }
  const identity = new Float32Array(count * 3)
  for (let g = 0; g < N; g++) {
    for (let b = 0; b < N; b++) {
      for (let r = 0; r < N; r++) {
        const k = ((g * N + b) * N + r) * 3
        identity[k] = r / (N - 1)
        identity[k + 1] = g / (N - 1)
        identity[k + 2] = b / (N - 1)
      }
    }
  }

  const data = new Uint8Array(count * 4)
  const texOpts = {
    width: W,
    height: N,
    format: 'rgba',
    type: 'uint8',
    min: 'linear',
    mag: 'linear',
    wrap: 'clamp',
    data
  }
  const texture = regl.texture(texOpts)

  // last uploaded state
  const last = { amount: -1 }
  for (const name of LUT_SECTIONS) last[name] = -1
  const w = {}
  const state = { texture, size: N, on: false, update, destroy }

  // weights: { breakdown, build, drop, groove } (any scale; renormalised),
  // amount: 0 = identity .. 1 = full look. Rebuilds only when a section
  // weight moved by more than ~1/500, or the amount alone by more than
  // 1/100 (both under one 8-bit step of the output after the mix).
  function update (weights, amount) {
    const a = Number.isFinite(amount) ? clamp01(amount) : 0
    let total = 0
    for (const name of LUT_SECTIONS) {
      const x = weights && Number.isFinite(weights[name]) ? Math.max(0, weights[name]) : 0
      w[name] = x
      total += x
    }
    if (total > 1e-6) {
      for (const name of LUT_SECTIONS) w[name] /= total
    } else {
      for (const name of LUT_SECTIONS) w[name] = name === 'groove' ? 1 : 0
    }
    state.on = a > 1e-3
    if (!state.on) {
      last.amount = 0
      return state
    }
    let delta = Math.abs(a - last.amount) * 0.2
    for (const name of LUT_SECTIONS) delta = Math.max(delta, Math.abs(w[name] - last[name]))
    if (delta < 0.002) return state

    last.amount = a
    for (const name of LUT_SECTIONS) last[name] = w[name]
    const wb = w.breakdown * a
    const wu = w.build * a
    const wd = w.drop * a
    const wg = w.groove * a
    const wi = 1 - a
    const tb = tables.breakdown
    const tu = tables.build
    const td = tables.drop
    const tg = tables.groove
    for (let i = 0, k = 0; i < count; i++, k += 3) {
      const o = i * 4
      for (let ch = 0; ch < 3; ch++) {
        const v = wi * identity[k + ch] + wb * tb[k + ch] + wu * tu[k + ch] +
          wd * td[k + ch] + wg * tg[k + ch]
        data[o + ch] = Math.round(clamp01(v) * 255)
      }
      data[o + 3] = 255
    }
    texture.subimage({ width: W, height: N, data })
    return state
  }

  function destroy () {
    texture.destroy()
  }

  return state
}
