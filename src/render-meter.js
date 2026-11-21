// Scene light meter for the auto exposure and the legibility controls.
//
// Three tiny passes reduce the display-referred scene to a fixed METER_W x
// METER_H grid of cells, each holding the mean linear luminance of its area
// (mean) and the brightest source pixel in it (peak), averaged over time:
//  A) scene -> a fixed 4*METER_W x 4*METER_H target: each output texel
//     fetches every source texel of its footprint at its centre (up to
//     MAX_TAPS x MAX_TAPS, i.e. canvases up to 4096 x 2304 are covered
//     exactly), so a 1 px ribbon line is never skipped and the result does
//     not depend on the canvas resolution or on the governor's pixel ratio
//  B) -> METER_W x METER_H: an exact 4x4 box (mean of the means, max of the
//     peaks), again at texel centres
//  C) a temporal EMA of the grid (ping-pong), time constant set by the
//     caller: the beat-rate averaging happens here on the GPU, so the CPU
//     only needs a rare readback of an already smooth signal
// The CPU reads the EMA grid back every so often and summarises it into a
// few statistics (percentiles of the time-averaged cells stand in for a time
// average of the percentiles).
//
// Mean and peak tell different things: thin bright lines on black have a
// high peak but a low cell mean (most of a cell is black gap); the "soft
// white mass" of a loud wide shot has both high. The high percentiles of the
// cell means are what the legibility controls react to (index.js,
// updateLegibility).
//
// Storage: every buffer is RGBA uint8 with min / mag 'nearest' and every
// fetch lands on a texel centre, so no filtering ever mixes encoded values.
// Each value is x = L / (1 + L) packed on two bytes (16 bit fixed point: RG
// = mean, BA = peak): portable (uint8 is always renderable and readable in
// WebGL1, float readback is not), fine enough in the darks (~0.15 % at
// L = 0.01) and identical on every device, so the tuned knees mean the same
// everywhere.
//
// WebGL1 has no asynchronous readback (no PBO / fence): readPixels waits for
// the GPU to finish everything submitted so far. The caller reads rarely (a
// few times a second at most) and at the start of a frame.
import { FRAG_PRECISION, FULLSCREEN_VERT } from './render-bloom'

export const METER_W = 64
export const METER_H = 36
const MID_W = METER_W * 4
const MID_H = METER_H * 4
// per axis, source texels fetched per pass A output texel (constant loop bound)
const MAX_TAPS = 16

// x = L / (1 + L) on two bytes; L is clamped to [0, 64]
const CODEC = `
vec2 meterPack(float l) {
  float s = clamp(l / (1.0 + l), 0.0, 1.0) * 255.0;
  float hi = floor(s);
  return vec2(hi / 255.0, s - hi);
}
float meterUnpack(vec2 e) {
  float x = min((floor(e.x * 255.0 + 0.5) + e.y) / 255.0, 0.99);
  return min(x / (1.0 - x), 64.0);
}
vec4 meterEncode(vec2 mp) { return vec4(meterPack(mp.x), meterPack(mp.y)); }
vec2 meterDecode(vec4 t) { return vec2(meterUnpack(t.rg), meterUnpack(t.ba)); }
`

export default function createRenderMeter (regl) {
  const position = regl.buffer([-1, -1, -1, 4, 4, -1])
  const makeFbo = (w, h) =>
    regl.framebuffer({
      color: regl.texture({ width: w, height: h, min: 'nearest', mag: 'nearest', wrap: 'clamp' }),
      depth: false,
      stencil: false
    })
  const mid = makeFbo(MID_W, MID_H)
  const grid = makeFbo(METER_W, METER_H)
  const ema = [makeFbo(METER_W, METER_H), makeFbo(METER_W, METER_H)]
  let emaIndex = 0 // ema[emaIndex] holds the latest average
  let emaValid = false
  // read buffer, allocated once
  const pixels = new Uint8Array(METER_W * METER_H * 4)
  const means = new Float32Array(METER_W * METER_H)
  const peaks = new Float32Array(METER_W * METER_H)
  let fresh = false // the EMA changed since the last read

  const midPass = regl({
    vert: FULLSCREEN_VERT,
    frag: `
      ${FRAG_PRECISION}
      varying vec2 uv;
      uniform sampler2D src;
      uniform vec2 srcSize; // source size in texels
      uniform vec2 taps; // fetches per axis (<= MAX_TAPS)
      ${CODEC}
      void main() {
        // this output texel's footprint in source texels
        vec2 foot = srcSize / vec2(${MID_W}.0, ${MID_H}.0);
        vec2 origin = floor(gl_FragCoord.xy) * foot;
        vec2 stride = foot / taps;
        float m = 0.0;
        float p = 0.0;
        for (int y = 0; y < ${MAX_TAPS}; y++) {
          if (float(y) >= taps.y) break;
          for (int x = 0; x < ${MAX_TAPS}; x++) {
            if (float(x) >= taps.x) break;
            // snapped to a source texel centre: an exact texel value
            vec2 t = floor(origin + (vec2(float(x), float(y)) + 0.5) * stride) + 0.5;
            vec3 c = pow(max(texture2D(src, t / srcSize).rgb, vec3(1e-6)), vec3(2.2));
            float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
            // never let NaN / Inf from the HDR buffer into the statistics
            l = l == l ? clamp(l, 0.0, 64.0) : 0.0;
            m += l;
            p = max(p, l);
          }
        }
        gl_FragColor = meterEncode(vec2(m / (taps.x * taps.y), p));
      }
    `,
    attributes: { position },
    uniforms: {
      src: regl.prop('src'),
      srcSize: regl.prop('srcSize'),
      taps: regl.prop('taps')
    },
    count: 3,
    depth: { enable: false },
    blend: { enable: false },
    framebuffer: mid
  })

  const gridPass = regl({
    vert: FULLSCREEN_VERT,
    frag: `
      ${FRAG_PRECISION}
      varying vec2 uv;
      uniform sampler2D src;
      ${CODEC}
      void main() {
        vec2 base = floor(gl_FragCoord.xy) * 4.0;
        float m = 0.0;
        float p = 0.0;
        for (int y = 0; y < 4; y++) {
          for (int x = 0; x < 4; x++) {
            vec2 t = base + vec2(float(x), float(y)) + 0.5;
            vec2 s = meterDecode(texture2D(src, t / vec2(${MID_W}.0, ${MID_H}.0)));
            m += s.x;
            p = max(p, s.y);
          }
        }
        gl_FragColor = meterEncode(vec2(m / 16.0, p));
      }
    `,
    attributes: { position },
    uniforms: { src: mid },
    count: 3,
    depth: { enable: false },
    blend: { enable: false },
    framebuffer: grid
  })

  const emaPass = regl({
    vert: FULLSCREEN_VERT,
    frag: `
      ${FRAG_PRECISION}
      varying vec2 uv;
      uniform sampler2D cur;
      uniform sampler2D prev;
      uniform float alpha;
      ${CODEC}
      void main() {
        vec2 t = (floor(gl_FragCoord.xy) + 0.5) / vec2(${METER_W}.0, ${METER_H}.0);
        // averaged in linear luminance, not in the encoded domain
        vec2 c = meterDecode(texture2D(cur, t));
        vec2 o = meterDecode(texture2D(prev, t));
        gl_FragColor = meterEncode(mix(o, c, alpha));
      }
    `,
    attributes: { position },
    uniforms: {
      cur: grid,
      prev: regl.prop('prev'),
      alpha: regl.prop('alpha')
    },
    count: 3,
    depth: { enable: false },
    blend: { enable: false },
    framebuffer: regl.prop('fbo')
  })

  // source: the display-referred scene (gamma encoded, as render-post reads
  // it); dt: seconds since the previous draw; tau: EMA time constant (s),
  // reset: restart the average from this frame
  function draw ({ source, width, height, dt, tau, reset }) {
    const w = Math.max(1, width | 0)
    const h = Math.max(1, height | 0)
    midPass({
      src: source,
      srcSize: [w, h],
      taps: [
        Math.min(MAX_TAPS, Math.max(1, Math.ceil(w / MID_W))),
        Math.min(MAX_TAPS, Math.max(1, Math.ceil(h / MID_H)))
      ]
    })
    gridPass()
    const d = Number.isFinite(dt) ? Math.max(0, dt) : 0
    const alpha = reset || !emaValid ? 1 : 1 - Math.exp(-d / Math.max(Number(tau) || 0, 1e-3))
    const next = 1 - emaIndex
    emaPass({ prev: ema[emaIndex], fbo: ema[next], alpha })
    emaIndex = next
    emaValid = true
    fresh = true
  }

  const unpack = (hi, lo) => {
    const x = Math.min((hi + lo / 255) / 255, 0.99)
    return Math.min(x / (1 - x), 64)
  }
  const sorted = new Float32Array(METER_W * METER_H)
  const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))]

  // reads the EMA grid (call before this frame's draws) and returns its
  // statistics, or null when nothing new was drawn since the last read
  function read () {
    if (!fresh) return null
    fresh = false
    try {
      regl.read({ framebuffer: ema[emaIndex], data: pixels })
    } catch (e) {
      return null
    }
    let sum = 0
    const n = METER_W * METER_H
    for (let i = 0; i < n; i++) {
      means[i] = unpack(pixels[i * 4], pixels[i * 4 + 1])
      peaks[i] = unpack(pixels[i * 4 + 2], pixels[i * 4 + 3])
      sum += means[i]
    }
    sorted.set(means)
    sorted.sort()
    const meanP50 = pct(sorted, 0.5)
    const meanP90 = pct(sorted, 0.9)
    const meanP95 = pct(sorted, 0.95)
    const meanP98 = pct(sorted, 0.98)
    // fill: how evenly lit the brightest cells are, mean / peak averaged
    // over the cells at or above the 95th percentile. Lines over black gaps
    // give a low ratio (the peak is a line, the mean includes the gaps), a
    // lit mass a ratio near 1
    let fillSum = 0
    let fillN = 0
    for (let i = 0; i < n; i++) {
      if (means[i] >= meanP95 && peaks[i] > 1e-4) {
        fillSum += Math.min(1, means[i] / peaks[i])
        fillN++
      }
    }
    sorted.set(peaks)
    sorted.sort()
    return {
      fill: fillN ? fillSum / fillN : 0,
      mean: sum / n,
      meanP50,
      meanP90,
      meanP95,
      meanP98,
      peakP90: pct(sorted, 0.9),
      peakP98: pct(sorted, 0.98)
    }
  }

  function destroy () {
    for (const f of [mid, grid, ema[0], ema[1]]) {
      const tex = f.color[0]
      f.destroy()
      tex.destroy()
    }
    position.destroy()
  }

  return { draw, read, destroy, means, peaks }
}
