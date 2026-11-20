// Anamorphic lens flares: thin horizontal streaks on the brightest points.
//
// Source: the bloom chain's first level (half res, linear, already soft
// thresholded by the bloom; render-bloom returns it as `bright`). A bright
// pass at a quarter of the canvas height (half or quarter width) keeps only
// what is above the flare threshold. A few separable horizontal blur passes
// follow, each with 9 taps spaced 4x wider than the previous pass (so the
// streak reaches a few hundred pixels in ~4 cheap passes), and a combine
// pass averages the passes: a bright core with a long, fading tail.
//
// Buffers are of the scene's type; on the uint8 fallback they store
// sqrt(linear) (the bloom codec). render-post tints the result (slightly
// blue) and adds it before tone mapping.
import { FRAG_PRECISION, FULLSCREEN_VERT, BLOOM_CODEC } from './render-bloom'

export const FLARES_MAX_PASSES = 4

export default function createRenderFlares (regl, { type = 'uint8', hdr = false, widthShift = 1 } = {}) {
  const defines = hdr ? '' : '#define BLOOM_ENCODED\n'
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
  // fbos[0]: bright pass, then the combined result; fbos[1..]: blur passes
  const fbos = []
  for (let i = 0; i <= FLARES_MAX_PASSES; i++) fbos.push(makeFbo())

  const brightPass = regl({
    vert: FULLSCREEN_VERT,
    frag: `
      ${defines}
      ${FRAG_PRECISION}
      varying vec2 uv;
      uniform sampler2D src; // bloom level 0, bloom codec
      uniform vec2 texel; // source texel size
      uniform float threshold;
      ${BLOOM_CODEC}
      void main() {
        // the target is half the source height: two rows in two fetches
        vec3 c = 0.5 * (
          bloomDecode(texture2D(src, uv + vec2(0.0, 0.5 * texel.y))) +
          bloomDecode(texture2D(src, uv - vec2(0.0, 0.5 * texel.y))));
        // NaN / Inf never reach the streaks (bloom would spread them)
        c = min(max(c, vec3(0.0)), vec3(64.0));
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        if (!(l == l) || l > 1e6) { c = vec3(0.0); l = 0.0; }
        float k = max(l - threshold, 0.0) / max(l, 1e-4);
        gl_FragColor = bloomEncode(c * k);
      }
    `,
    attributes: { position },
    uniforms: {
      src: regl.prop('src'),
      texel: regl.prop('texel'),
      threshold: regl.prop('threshold')
    },
    count: 3,
    depth: { enable: false },
    blend: { enable: false },
    framebuffer: regl.prop('fbo')
  })

  // 9 taps along x, exponential weights, normalised; samples outside the
  // screen count as black so the borders do not smear
  const blurPass = regl({
    vert: FULLSCREEN_VERT,
    frag: `
      ${defines}
      ${FRAG_PRECISION}
      varying vec2 uv;
      uniform sampler2D src;
      uniform float stepX; // tap spacing, in uv
      ${BLOOM_CODEC}
      void main() {
        vec3 sum = vec3(0.0);
        float wsum = 0.0;
        for (int i = -4; i <= 4; i++) {
          float fi = float(i);
          float w = exp(-abs(fi) * 0.45);
          float x = uv.x + fi * stepX;
          float inside = step(0.0, x) * step(x, 1.0);
          sum += bloomDecode(texture2D(src, vec2(x, uv.y))) * (w * inside);
          wsum += w;
        }
        gl_FragColor = bloomEncode(sum / max(wsum, 1e-4));
      }
    `,
    attributes: { position },
    uniforms: {
      src: regl.prop('src'),
      stepX: regl.prop('stepX')
    },
    count: 3,
    depth: { enable: false },
    blend: { enable: false },
    framebuffer: regl.prop('fbo')
  })

  // average of the blur passes (unused slots get weight 0)
  const combinePass = regl({
    vert: FULLSCREEN_VERT,
    frag: `
      ${defines}
      ${FRAG_PRECISION}
      varying vec2 uv;
      uniform sampler2D p1;
      uniform sampler2D p2;
      uniform sampler2D p3;
      uniform sampler2D p4;
      uniform vec4 weights;
      ${BLOOM_CODEC}
      void main() {
        vec3 c = bloomDecode(texture2D(p1, uv)) * weights.x +
          bloomDecode(texture2D(p2, uv)) * weights.y +
          bloomDecode(texture2D(p3, uv)) * weights.z +
          bloomDecode(texture2D(p4, uv)) * weights.w;
        gl_FragColor = bloomEncode(c);
      }
    `,
    attributes: { position },
    uniforms: {
      p1: regl.prop('p1'),
      p2: regl.prop('p2'),
      p3: regl.prop('p3'),
      p4: regl.prop('p4'),
      weights: regl.prop('weights')
    },
    count: 3,
    depth: { enable: false },
    blend: { enable: false },
    framebuffer: regl.prop('fbo')
  })

  let curW = 0
  let curH = 0
  function resize (w, h) {
    if (w === curW && h === curH) return
    curW = w
    curH = h
    for (const f of fbos) f.resize(w, h)
  }

  // reused every frame (no per-frame allocation)
  const brightTexel = new Float32Array(2)
  const combineWeights = new Float32Array(4)

  // source: the bloom's `bright` level; width / height: canvas size;
  // passes: 1..FLARES_MAX_PASSES; length: tap spacing factor (1 = 1 texel
  // in the first pass). Returns the streak texture (bloom codec).
  function render ({ source, width, height, threshold, passes, length }) {
    const w = Math.max(1, (width | 0) >> widthShift)
    const h = Math.max(1, (height | 0) >> 2)
    resize(w, h)
    const n = Math.max(1, Math.min(FLARES_MAX_PASSES, passes | 0))
    const len = Math.max(0.05, Math.min(8, +length || 1))
    const srcH = Math.max(1, source.height | 0)
    const srcW = Math.max(1, source.width | 0)

    brightTexel[0] = 1 / srcW
    brightTexel[1] = 1 / srcH
    brightPass({
      fbo: fbos[0],
      src: source,
      texel: brightTexel,
      threshold: Math.max(0, +threshold || 0)
    })
    let spacing = len
    for (let i = 1; i <= n; i++) {
      blurPass({ fbo: fbos[i], src: fbos[i - 1], stepX: spacing / w })
      spacing *= 4
    }
    const wt = 1 / n
    combineWeights[0] = wt
    combineWeights[1] = n >= 2 ? wt : 0
    combineWeights[2] = n >= 3 ? wt : 0
    combineWeights[3] = n >= 4 ? wt : 0
    combinePass({
      fbo: fbos[0],
      p1: fbos[1],
      p2: n >= 2 ? fbos[2] : fbos[1],
      p3: n >= 3 ? fbos[3] : fbos[1],
      p4: n >= 4 ? fbos[4] : fbos[1],
      weights: combineWeights
    })
    return fbos[0]
  }

  function destroy () {
    for (const f of fbos) {
      const tex = f.color[0]
      f.destroy()
      tex.destroy()
    }
    position.destroy()
  }

  return { render, destroy }
}
