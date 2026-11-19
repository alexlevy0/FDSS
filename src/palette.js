// Per-track cosine palettes (Inigo Quilez): col(t) = a + b * cos(2π(c*t + d)).
// With c = 0.5 and d ≈ 0.5 the ramp is monotonic over t in 0..1 (dark at 0,
// bright at 1), which matches how the grid uses t = frequency value.
//
// The controller crossfades the palette parameters when the track changes and
// drifts the phase (d) slowly, faster when the music is loud.

export const PALETTES = [
  // track #3: cyan / teal
  {
    name: 'teal',
    a: [0.4, 0.6, 0.62],
    b: [0.38, 0.42, 0.38],
    c: [0.5, 0.5, 0.5],
    d: [0.56, 0.5, 0.46]
  },
  // track #2: magenta / violet
  {
    name: 'violet',
    a: [0.55, 0.3, 0.6],
    b: [0.45, 0.3, 0.4],
    c: [0.5, 0.5, 0.5],
    d: [0.5, 0.6, 0.45]
  },
  // track #1: amber / warm
  {
    name: 'amber',
    a: [0.62, 0.42, 0.22],
    b: [0.4, 0.38, 0.2],
    c: [0.5, 0.5, 0.5],
    d: [0.5, 0.52, 0.56]
  }
]

const KEYS = ['a', 'b', 'c', 'd']

function clonePalette (p) {
  return { a: p.a.slice(), b: p.b.slice(), c: p.c.slice(), d: p.d.slice() }
}

export default function createPalette (opts = {}) {
  const palettes = opts.palettes || PALETTES
  const settings = Object.assign(
    {
      crossfade: 3, // seconds
      drift: 0.04, // amplitude of the phase drift on d
      driftSpeed: 0.12, // rad/s at zero energy
      driftEnergy: 0.6, // extra rad/s at full energy
      energyShift: 0.12 // shift of t at full energy (brighter when loud)
    },
    opts.settings
  )

  let from = clonePalette(palettes[0])
  let to = clonePalette(palettes[0])
  let current = clonePalette(palettes[0])
  let fade = 1
  let phase = 0
  let index = 0

  // values handed to shaders (arrays are reused every frame)
  const uniforms = {
    paletteA: [0, 0, 0],
    paletteB: [0, 0, 0],
    paletteC: [0, 0, 0],
    paletteD: [0, 0, 0],
    paletteShift: 0
  }

  function setTrack (i) {
    const next = palettes[((i % palettes.length) + palettes.length) % palettes.length]
    index = i
    // start the fade from whatever is on screen right now (handles a change
    // that arrives in the middle of a previous crossfade)
    from = clonePalette(current)
    to = clonePalette(next)
    fade = settings.crossfade > 0 ? 0 : 1
  }

  function update (dt, energy = 0) {
    dt = Math.min(Math.max(dt || 0, 0), 0.1)
    if (fade < 1) fade = Math.min(1, fade + dt / Math.max(settings.crossfade, 1e-3))
    const f = fade * fade * (3 - 2 * fade) // smoothstep

    for (const k of KEYS) {
      for (let j = 0; j < 3; j++) {
        current[k][j] = from[k][j] + (to[k][j] - from[k][j]) * f
      }
    }

    phase += dt * (settings.driftSpeed + settings.driftEnergy * energy)
    if (phase > Math.PI * 200) phase -= Math.PI * 200

    for (let j = 0; j < 3; j++) {
      uniforms.paletteA[j] = current.a[j]
      uniforms.paletteB[j] = current.b[j]
      uniforms.paletteC[j] = current.c[j]
      uniforms.paletteD[j] = current.d[j] + settings.drift * Math.sin(phase + j * 2.094)
    }
    uniforms.paletteShift = settings.energyShift * energy
    return uniforms
  }

  // CPU evaluation of the current palette (0..1 per channel)
  function evaluate (t, out = [0, 0, 0]) {
    t += uniforms.paletteShift
    for (let j = 0; j < 3; j++) {
      const v = uniforms.paletteA[j] + uniforms.paletteB[j] *
        Math.cos(2 * Math.PI * (uniforms.paletteC[j] * t + uniforms.paletteD[j]))
      out[j] = Math.min(1, Math.max(0, v))
    }
    return out
  }

  update(0, 0)

  return {
    settings,
    uniforms,
    setTrack,
    update,
    evaluate,
    get index () { return index }
  }
}

// GLSL helper matching evaluate(); include in shaders that declare the
// paletteA..D / paletteShift uniforms.
export const paletteGLSL = `
  uniform vec3 paletteA;
  uniform vec3 paletteB;
  uniform vec3 paletteC;
  uniform vec3 paletteD;
  uniform float paletteShift;
  vec3 palette(float t) {
    t += paletteShift;
    return clamp(paletteA + paletteB * cos(6.28318530718 * (paletteC * t + paletteD)), 0.0, 1.0);
  }
`
