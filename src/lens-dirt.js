// Procedural lens dirt, generated once on the CPU at startup (no image
// file): a few wide, faint smudges and wipes, soft round spots with a
// brighter rim (out-of-focus dust), and many small specks. render-post
// multiplies it by the bloom, so it only shows where the glow is strong.
import Alea from 'alea'

export default function createLensDirt (regl, { size = 512, seed = 'fdss-dirt' } = {}) {
  const rand = new Alea(seed)
  const n = size
  const acc = new Float32Array(n * n * 3)
  const scale = n / 512

  // one blob: elliptical, rotated; profile(r) for r = normalised radius 0..1
  function blob (cx, cy, radius, aspect, angle, intensity, tint, profile) {
    const rx = radius * aspect
    const reach = Math.ceil(Math.max(rx, radius)) + 1
    const ca = Math.cos(angle)
    const sa = Math.sin(angle)
    const x0 = Math.max(0, Math.floor(cx - reach))
    const x1 = Math.min(n - 1, Math.ceil(cx + reach))
    const y0 = Math.max(0, Math.floor(cy - reach))
    const y1 = Math.min(n - 1, Math.ceil(cy + reach))
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx
        const dy = y + 0.5 - cy
        const u = (dx * ca + dy * sa) / rx
        const v = (-dx * sa + dy * ca) / radius
        const r = Math.sqrt(u * u + v * v)
        if (r >= 1) continue
        const a = profile(r) * intensity
        const i = (y * n + x) * 3
        acc[i] += a * tint[0]
        acc[i + 1] += a * tint[1]
        acc[i + 2] += a * tint[2]
      }
    }
  }
  const range = (a, b) => a + (b - a) * rand()
  const tint = () => {
    const t = range(-1, 1)
    return [1 + 0.06 * t, 1, 1 - 0.08 * t]
  }
  const gauss = (r) => Math.exp(-r * r * 4) - Math.exp(-4) * r
  const disc = (r) => {
    // soft disc with a slightly brighter rim (defocused dust)
    const edge = 1 - smooth(0.75, 1, r)
    return edge * (0.6 + 0.4 * smooth(0.4, 0.9, r))
  }
  const speck = (r) => 1 - smooth(0.3, 1, r)
  function smooth (a, b, x) {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)
  }

  // wide smudges (fingerprints, haze)
  for (let i = 0; i < 26; i++) {
    blob(rand() * n, rand() * n, range(30, 110) * scale, range(1, 2.2), rand() * Math.PI,
      range(0.08, 0.22), tint(), gauss)
  }
  // a few wipes: long, thin, faint
  for (let i = 0; i < 5; i++) {
    blob(rand() * n, rand() * n, range(6, 14) * scale, range(5, 10), rand() * Math.PI,
      range(0.08, 0.16), tint(), gauss)
  }
  // defocused dust spots
  for (let i = 0; i < 90; i++) {
    blob(rand() * n, rand() * n, range(3, 12) * scale, range(1, 1.15), rand() * Math.PI,
      range(0.12, 0.45), tint(), disc)
  }
  // specks
  for (let i = 0; i < 380; i++) {
    blob(rand() * n, rand() * n, range(0.8, 2.6) * scale, 1, 0,
      range(0.25, 0.9), tint(), speck)
  }

  // soft compression to 0..1, plus a faint floor so the whole glass glows
  // a little under strong bloom
  const data = new Uint8Array(n * n * 4)
  for (let p = 0, q = 0; p < n * n; p++, q += 3) {
    const o = p * 4
    for (let c = 0; c < 3; c++) {
      const v = 0.04 + (1 - Math.exp(-acc[q + c] * 1.6)) * 0.96
      data[o + c] = Math.max(0, Math.min(255, Math.round(v * 255)))
    }
    data[o + 3] = 255
  }

  const texture = regl.texture({
    width: n,
    height: n,
    data,
    format: 'rgba',
    type: 'uint8',
    min: 'linear',
    mag: 'linear',
    wrap: 'clamp'
  })
  return { texture, size: n, destroy: () => texture.destroy() }
}
