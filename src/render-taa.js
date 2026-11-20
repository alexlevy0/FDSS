// Temporal anti-aliasing for the HDR scene buffer.
//
// Every frame the projection is shifted by a sub-pixel offset (Halton 2,3
// sequence, see jitter()), and the composed scene (grid + motion-blur
// trails) is blended with an accumulated history:
//   history' = mix(clip(history), current, alpha)
// with alpha ~ 0.1 at 60 fps (frame-rate independent, see render()).
//
// There are no motion vectors, but the camera is known: history is fetched
// where the grid's base plane (z = planeHeight) was last frame, through the
// plane-to-plane homography between the two view-projections (linear in
// screen space, so it is computed per vertex of the full-screen triangle and
// divided per pixel). Pixels whose ray misses the plane fall back to the same
// uv. What the plane does not explain (heights, springs, trails) is handled
// by neighbourhood clipping: the history colour is clipped toward the 3x3
// min/max box of the current frame, in YCoCg on reversibly tone-mapped
// values (a perceptual-ish space where HDR peaks do not dominate the box).
//
// History is two ping-pong buffers of the scene's type (half float / float
// when the GPU can render them, uint8 otherwise). It is reset (current frame
// copied as is) on resize, when TAA is (re)enabled, after a long frame and on
// large camera jumps.
import { FRAG_PRECISION } from './render-bloom'

function halton (index, base) {
  let f = 1
  let r = 0
  let i = index
  while (i > 0) {
    f /= base
    r += f * (i % base)
    i = Math.floor(i / base)
  }
  return r
}

// 3x3 inverse (column-major), null when singular
function invert3 (m) {
  const a00 = m[0]; const a01 = m[1]; const a02 = m[2]
  const a10 = m[3]; const a11 = m[4]; const a12 = m[5]
  const a20 = m[6]; const a21 = m[7]; const a22 = m[8]
  const b01 = a22 * a11 - a12 * a21
  const b11 = -a22 * a10 + a12 * a20
  const b21 = a21 * a10 - a11 * a20
  const det = a00 * b01 + a01 * b11 + a02 * b21
  if (!det || !isFinite(det)) return null
  const id = 1 / det
  return [
    b01 * id, (-a22 * a01 + a02 * a21) * id, (a12 * a01 - a02 * a11) * id,
    b11 * id, (a22 * a00 - a02 * a20) * id, (-a12 * a00 + a02 * a10) * id,
    b21 * id, (-a21 * a00 + a01 * a20) * id, (a11 * a00 - a01 * a10) * id
  ]
}

// column-major 3x3 product a * b
function mul3 (a, b) {
  const out = new Array(9)
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) {
      out[c * 3 + r] =
        a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2]
    }
  }
  return out
}

// column-major 4x4 product a * b
function mul4 (a, b) {
  const out = new Float64Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
    }
  }
  return out
}

// clip (x, y, w) of the plane point (u, v, h) as a 3x3 of (u, v, 1),
// taken from the rows x, y, w of a view-projection
function planeMatrix (vp, h) {
  return [
    vp[0], vp[1], vp[3],
    vp[4], vp[5], vp[7],
    vp[8] * h + vp[12], vp[9] * h + vp[13], vp[11] * h + vp[15]
  ]
}

const IDENTITY3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

export default function createRenderTaa (regl, { type = 'uint8' } = {}) {
  const position = regl.buffer([-1, -1, -1, 4, 4, -1])
  const makeFbo = () =>
    regl.framebuffer({
      color: regl.texture({
        width: 1,
        height: 1,
        type,
        min: 'linear',
        mag: 'linear',
        wrap: 'clamp'
      }),
      depth: false,
      stencil: false
    })
  const history = [makeFbo(), makeFbo()]
  let current = 0 // index of the buffer holding the latest result
  let valid = false
  let curW = 0
  let curH = 0
  let frameIndex = 0
  let prevVP = null

  const resolve = regl({
    vert: `
      precision highp float;
      attribute vec2 position;
      // ndc (x, y, 1) -> (previous clip x, y, w, and the sign carrier s)
      uniform mat3 reproject;
      uniform vec3 reprojectS;
      varying vec2 uv;
      varying vec4 prevClip;
      void main() {
        uv = position * 0.5 + 0.5;
        vec3 n = vec3(position, 1.0);
        prevClip = vec4(reproject * n, dot(reprojectS, n));
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `,
    frag: `
      ${FRAG_PRECISION}
      varying vec2 uv;
      varying vec4 prevClip;
      uniform sampler2D scene;
      uniform sampler2D history;
      uniform vec2 texel;
      uniform float alpha; // weight of the current frame
      uniform float clipAmount; // 1 = full neighbourhood clipping

      float maxc(vec3 c) { return max(c.r, max(c.g, c.b)); }
      // reversible tone map: HDR peaks do not dominate the box or the blend
      vec3 compress(vec3 c) { return c / (1.0 + maxc(c)); }
      vec3 expand(vec3 c) { return c / max(1.0 - maxc(c), 1e-3); }
      vec3 toYCoCg(vec3 c) {
        return vec3(
          dot(c, vec3(0.25, 0.5, 0.25)),
          dot(c, vec3(0.5, 0.0, -0.5)),
          dot(c, vec3(-0.25, 0.5, -0.25)));
      }
      vec3 fromYCoCg(vec3 c) {
        return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
      }
      // one neighbourhood sample: grows the YCoCg box, and tracks the
      // brightest compressed RGB channel (bound for the result below)
      vec3 fetch(vec2 p, inout vec3 lo, inout vec3 hi, inout float peak) {
        vec3 rgb = compress(clamp(texture2D(scene, p).rgb, vec3(0.0), vec3(6e4)));
        peak = max(peak, maxc(rgb));
        vec3 s = toYCoCg(rgb);
        lo = min(lo, s);
        hi = max(hi, s);
        return s;
      }

      void main() {
        vec3 lo = vec3(1e4);
        vec3 hi = vec3(-1e4);
        float peak = 0.0;
        vec3 c = fetch(uv, lo, hi, peak);
        fetch(uv + vec2(-texel.x, -texel.y), lo, hi, peak);
        fetch(uv + vec2(0.0, -texel.y), lo, hi, peak);
        fetch(uv + vec2(texel.x, -texel.y), lo, hi, peak);
        fetch(uv + vec2(-texel.x, 0.0), lo, hi, peak);
        fetch(uv + vec2(texel.x, 0.0), lo, hi, peak);
        fetch(uv + vec2(-texel.x, texel.y), lo, hi, peak);
        fetch(uv + vec2(0.0, texel.y), lo, hi, peak);
        fetch(uv + vec2(texel.x, texel.y), lo, hi, peak);

        // where the grid plane was last frame (same uv if the ray misses it)
        vec2 huv = uv;
        if (prevClip.w > 0.0 && prevClip.z > 1e-6) {
          huv = prevClip.xy / prevClip.z * 0.5 + 0.5;
        }
        // a near-singular reprojection can give NaN / huge values: one bad
        // history pixel would then spread to the whole frame through bloom
        if (!(huv.x == huv.x) || !(huv.y == huv.y) || abs(huv.x) > 1e3 || abs(huv.y) > 1e3) {
          huv = uv;
        }
        float offscreen = step(1.0, max(abs(huv.x - 0.5), abs(huv.y - 0.5)) * 2.0);
        vec3 hs = clamp(texture2D(history, huv).rgb, vec3(0.0), vec3(6e4));
        if (!(hs.r == hs.r) || !(hs.g == hs.g) || !(hs.b == hs.b)) hs = vec3(0.0);
        vec3 h = toYCoCg(compress(hs));

        // clip the history toward the box centre (Playdead's clip, cheaper
        // and less blocky than a per-channel clamp)
        vec3 centre = 0.5 * (hi + lo);
        vec3 extent = 0.5 * (hi - lo) + 1e-4;
        vec3 v = h - centre;
        vec3 units = abs(v / extent);
        float m = max(units.x, max(units.y, units.z));
        vec3 clipped = m > 1.0 ? centre + v / m : h;
        h = mix(h, clipped, clipAmount);

        float a = mix(alpha, 1.0, offscreen);
        // a == 1 (reset / off-screen): use the current frame only
        vec3 col = max(fromYCoCg(a >= 0.999 ? c : mix(h, c, a)), vec3(0.0));
        // the YCoCg box centre can lie outside the RGB cube: bound the result
        // to the brightest neighbour (and keep it off 1, where expand() blows
        // up), so the clip never makes a firefly brighter than its source
        float bound = min(peak, 0.995);
        float mc = maxc(col);
        col *= mc > bound ? bound / mc : 1.0;
        gl_FragColor = vec4(expand(col), 1.0);
      }
    `,
    attributes: { position },
    uniforms: {
      scene: regl.prop('scene'),
      history: regl.prop('history'),
      texel: regl.prop('texel'),
      alpha: regl.prop('alpha'),
      clipAmount: regl.prop('clipAmount'),
      reproject: regl.prop('reproject'),
      reprojectS: regl.prop('reprojectS')
    },
    count: 3,
    depth: { enable: false },
    blend: { enable: false },
    framebuffer: regl.prop('fbo')
  })

  function resize (w, h) {
    if (w === curW && h === curH) return
    curW = w
    curH = h
    history[0].resize(w, h)
    history[1].resize(w, h)
    valid = false
  }

  // sub-pixel offset for this frame, in pixels (-0.5..0.5) * scale
  function jitter (samples = 8, scale = 1) {
    const n = Math.max(1, samples | 0)
    const i = (frameIndex % n) + 1 // Halton is 0 at index 0
    return [(halton(i, 2) - 0.5) * scale, (halton(i, 3) - 0.5) * scale]
  }

  // shifts a column-major perspective projection by (jx, jy) pixels
  function jitterProjection (projection, jx, jy, width, height) {
    projection[8] += (2 * jx) / Math.max(1, width)
    projection[9] += (2 * jy) / Math.max(1, height)
    return projection
  }

  function reset () {
    valid = false
  }

  // scene: the composed scene framebuffer; view / projection: this frame's
  // UNjittered matrices (for the reprojection). Returns the framebuffer to
  // read the anti-aliased scene from.
  function render ({
    scene,
    width,
    height,
    dt,
    view,
    projection,
    historyWeight = 0.9,
    clip = 1,
    reproject = true,
    planeHeight = 0,
    resetDistance = 0.35
  }) {
    resize(Math.max(1, width | 0), Math.max(1, height | 0))
    frameIndex = (frameIndex + 1) % 1024

    const vp = mul4(projection, view)
    // a jump of the camera (or a stall) makes the history meaningless
    if (prevVP) {
      let diff = 0
      for (let i = 0; i < 16; i++) diff = Math.max(diff, Math.abs(vp[i] - prevVP[i]))
      if (diff > resetDistance) valid = false
    }
    if (!(dt >= 0) || dt > 0.25) valid = false

    let reprojectM = IDENTITY3
    let reprojectS = [0, 0, 1]
    if (reproject && prevVP) {
      const inv = invert3(planeMatrix(vp, planeHeight))
      const m = inv && mul3(planeMatrix(prevVP, planeHeight), inv)
      // a near-singular plane matrix (camera grazing the plane) gives huge
      // or non-finite values: skip the reprojection for that frame
      const sane = (a) => a.every((x) => isFinite(x) && Math.abs(x) < 1e6)
      if (inv && sane(inv) && sane(m)) {
        reprojectM = m
        // last row of inv: s = 1 / (current clip w) of the plane point,
        // positive only where the ray hits the plane in front of the camera
        reprojectS = [inv[2], inv[5], inv[8]]
      }
    }
    if (reprojectM === IDENTITY3) {
      // reprojected (x, y, w) = (x, y, 1): same uv
      reprojectS = [0, 0, 1]
    }

    // history weight per 1/60 s, made frame-rate independent
    const keep = Math.pow(Math.min(Math.max(historyWeight, 0), 0.99), Math.max(dt, 0) * 60)
    const alpha = valid ? 1 - keep : 1

    const next = 1 - current
    resolve({
      fbo: history[next],
      scene,
      history: history[current],
      texel: [1 / curW, 1 / curH],
      alpha,
      clipAmount: Math.min(Math.max(clip, 0), 1),
      reproject: reprojectM,
      reprojectS
    })
    current = next
    valid = true
    prevVP = vp
    return history[current]
  }

  function destroy () {
    for (const f of history) {
      const tex = f.color[0]
      f.destroy()
      tex.destroy()
    }
    position.destroy()
  }

  return { render, jitter, jitterProjection, reset, destroy }
}
