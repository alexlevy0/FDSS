// Screen-space god rays (after Mitchell, "Volumetric Light Scattering as a
// Post-Process", GPU Gems 3): a thresholded, linearised copy of the scene at
// quarter resolution is smeared radially toward a light position (the
// projected grid centre), each step weighted by decay^i. The result is
// normalised by the sum of the weights, so the brightness does not depend
// on the sample count or the decay; render-post adds it on top of the scene
// (linear, like the bloom) with an intensity driven by the music.
//
// Buffers are of the scene's type; on the uint8 fallback they store
// sqrt(linear) (the bloom codec).
import { FRAG_PRECISION, FULLSCREEN_VERT, BLOOM_CODEC } from './render-bloom'

export const GODRAYS_MAX_SAMPLES = 64

export default function createRenderGodrays (regl, { type = 'uint8', hdr = false } = {}) {
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
  const bright = makeFbo()
  const rays = makeFbo()

  // quarter-res bright pass: 4 bilinear fetches (a 4x4 box) of the
  // display-referred scene, linearised, soft threshold
  const brightPass = regl({
    vert: FULLSCREEN_VERT,
    frag: `
      ${defines}
      ${FRAG_PRECISION}
      varying vec2 uv;
      uniform sampler2D src;
      uniform vec2 texel; // source texel size
      uniform float threshold;
      ${BLOOM_CODEC}
      vec3 S(vec2 p) {
        return pow(max(texture2D(src, p).rgb, vec3(1e-6)), vec3(2.2));
      }
      void main() {
        vec3 c = 0.25 * (
          S(uv + texel * vec2(-1.0, -1.0)) + S(uv + texel * vec2(1.0, -1.0)) +
          S(uv + texel * vec2(-1.0, 1.0)) + S(uv + texel * vec2(1.0, 1.0)));
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
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
    framebuffer: bright
  })

  const raysPass = regl({
    vert: FULLSCREEN_VERT,
    frag: `
      #define MAX_SAMPLES ${GODRAYS_MAX_SAMPLES}
      ${defines}
      ${FRAG_PRECISION}
      varying vec2 uv;
      uniform sampler2D src;
      uniform vec2 light; // uv, may be off screen
      uniform float samples; // 1..MAX_SAMPLES
      uniform float decay;
      uniform float density; // fraction of the way to the light covered
      ${BLOOM_CODEC}
      void main() {
        vec2 delta = (uv - light) * (density / samples);
        vec2 p = uv;
        float w = 1.0;
        float wsum = 0.0;
        vec3 acc = vec3(0.0);
        for (int i = 0; i < MAX_SAMPLES; i++) {
          if (float(i) >= samples) break;
          acc += bloomDecode(texture2D(src, p)) * w;
          wsum += w;
          w *= decay;
          p -= delta;
        }
        gl_FragColor = bloomEncode(acc / max(wsum, 1e-4));
      }
    `,
    attributes: { position },
    uniforms: {
      src: bright,
      light: regl.prop('light'),
      samples: regl.prop('samples'),
      decay: regl.prop('decay'),
      density: regl.prop('density')
    },
    count: 3,
    depth: { enable: false },
    blend: { enable: false },
    framebuffer: rays
  })

  let curW = 0
  let curH = 0
  function resize (w, h) {
    if (w === curW && h === curH) return
    curW = w
    curH = h
    bright.resize(w, h)
    rays.resize(w, h)
  }

  // source: scene framebuffer (display-referred); light: [u, v].
  // Returns the rays texture (linear, bloom codec).
  function render ({ source, width, height, light, samples = 32, decay = 0.95, density = 0.8, threshold = 0.1, scale = 0.25 }) {
    const s = Math.min(Math.max(scale, 0.0625), 1)
    resize(Math.max(1, Math.round(width * s)), Math.max(1, Math.round(height * s)))
    brightPass({
      src: source,
      // 4 bilinear taps one source texel off the centre: a 4x4 box
      texel: [1 / Math.max(1, width), 1 / Math.max(1, height)],
      threshold: Math.max(0, threshold)
    })
    raysPass({
      light,
      samples: Math.max(1, Math.min(GODRAYS_MAX_SAMPLES, Math.round(samples))),
      decay: Math.min(Math.max(decay, 0), 1),
      density: Math.min(Math.max(density, 0), 1)
    })
    return rays
  }

  function destroy () {
    for (const f of [bright, rays]) {
      const tex = f.color[0]
      f.destroy()
      tex.destroy()
    }
    position.destroy()
  }

  return { render, destroy }
}
