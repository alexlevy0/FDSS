// Final composite, in two passes:
//  A) scene + bloom (linear) -> radial chromatic aberration -> exposure ->
//     ACES filmic tone mapping -> gamma, into an 8-bit buffer that keeps the
//     luma in alpha for FXAA
//  B) FXAA -> vignette -> film grain + triangular dither, to the canvas
// Chromatic aberration is done in A, on the HDR samples, so FXAA smooths its
// fringes as well; it is 0 at the centre and grows toward the corners.
import { FRAG_PRECISION, FULLSCREEN_VERT, BLOOM_CODEC } from './render-bloom'

export default function createRenderPost (regl, { hdr = false } = {}) {
  const defines = hdr ? '' : '#define BLOOM_ENCODED\n'
  const position = regl.buffer([-1, -1, -1, 4, 4, -1])

  const ldrTexture = regl.texture({
    width: 1,
    height: 1,
    min: 'linear',
    mag: 'linear',
    wrap: 'clamp'
  })
  const ldrFbo = regl.framebuffer({ color: ldrTexture, depth: false, stencil: false })

  const tonemapPass = regl({
    vert: FULLSCREEN_VERT,
    frag: `
      ${defines}
      ${FRAG_PRECISION}
      varying vec2 uv;
      uniform sampler2D scene;
      uniform sampler2D bloom;
      uniform float bloomIntensity;
      uniform float exposure;
      uniform float ca;
      ${BLOOM_CODEC}

      vec3 hdrAt(vec2 p) {
        vec3 s = pow(max(texture2D(scene, p).rgb, vec3(1e-6)), vec3(2.2));
        return s + bloomDecode(texture2D(bloom, p)) * bloomIntensity;
      }

      // Narkowicz's fit of the ACES filmic curve
      vec3 aces(vec3 x) {
        return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
      }

      // single channels of hdrAt(), for the aberration offsets: same two
      // fetches, but a scalar pow instead of a vec3 one
      float hdrR(vec2 p) {
        return pow(max(texture2D(scene, p).r, 1e-6), 2.2) +
          bloomDecode(texture2D(bloom, p)).r * bloomIntensity;
      }
      float hdrB(vec2 p) {
        return pow(max(texture2D(scene, p).b, 1e-6), 2.2) +
          bloomDecode(texture2D(bloom, p)).b * bloomIntensity;
      }

      void main() {
        vec3 col = hdrAt(uv);
        // uniform branch: below ~0.1 px of offset the extra fetches are
        // skipped entirely (base CA is 0 on touch devices, kicks only)
        if (ca > 1e-4) {
          vec2 d = (uv - 0.5) * ca;
          col.r = hdrR(uv + d);
          col.b = hdrB(uv - d);
        }
        col = aces(col * exposure);
        col = pow(col, vec3(1.0 / 2.2));
        gl_FragColor = vec4(col, dot(col, vec3(0.299, 0.587, 0.114)));
      }
    `,
    attributes: { position },
    uniforms: {
      scene: regl.prop('scene'),
      bloom: regl.prop('bloom'),
      bloomIntensity: regl.prop('bloomIntensity'),
      exposure: regl.prop('exposure'),
      ca: regl.prop('ca')
    },
    count: 3,
    depth: { enable: false },
    blend: { enable: false },
    framebuffer: ldrFbo
  })

  const finalPass = regl({
    vert: FULLSCREEN_VERT,
    frag: `
      ${FRAG_PRECISION}
      varying vec2 uv;
      uniform sampler2D tex; // rgb + luma in alpha
      uniform vec2 texel;
      uniform float fxaaOn;
      uniform float vignette;
      uniform float vignetteStart;
      uniform float grain;
      uniform float seed;

      // FXAA (after Timothy Lottes' FXAA 2 / the common "fxaa.glsl" port)
      vec3 fxaa(vec2 p) {
        vec4 m = texture2D(tex, p);
        float lNW = texture2D(tex, p + vec2(-1.0, -1.0) * texel).a;
        float lNE = texture2D(tex, p + vec2(1.0, -1.0) * texel).a;
        float lSW = texture2D(tex, p + vec2(-1.0, 1.0) * texel).a;
        float lSE = texture2D(tex, p + vec2(1.0, 1.0) * texel).a;
        float lM = m.a;
        float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
        float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

        vec2 dir;
        dir.x = -((lNW + lNE) - (lSW + lSE));
        dir.y = ((lNW + lSW) - (lNE + lSE));
        float dirReduce = max((lNW + lNE + lSW + lSE) * (0.25 * (1.0 / 8.0)), 1.0 / 128.0);
        float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
        dir = clamp(dir * rcpDirMin, vec2(-8.0), vec2(8.0)) * texel;

        vec3 a = 0.5 * (
          texture2D(tex, p + dir * (1.0 / 3.0 - 0.5)).rgb +
          texture2D(tex, p + dir * (2.0 / 3.0 - 0.5)).rgb);
        vec3 b = a * 0.5 + 0.25 * (
          texture2D(tex, p - dir * 0.5).rgb +
          texture2D(tex, p + dir * 0.5).rgb);
        float lB = dot(b, vec3(0.299, 0.587, 0.114));
        return (lB < lMin || lB > lMax) ? a : b;
      }

      // Dave Hoskins' "hash without sine" (MIT)
      float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      void main() {
        vec3 col = fxaaOn > 0.5 ? fxaa(uv) : texture2D(tex, uv).rgb;

        // vignette: 0 at the centre, 1 in the corners
        float d = length(uv - 0.5) * 1.41421356;
        col *= 1.0 - vignette * smoothstep(vignetteStart, 1.0, d);

        // film grain (strongest in the mids, lighter on pure black) plus a
        // triangular +-1 LSB dither that breaks up banding in the darks
        vec2 fc = gl_FragCoord.xy + seed;
        float tri = hash12(fc) + hash12(fc + vec2(37.1, 17.3)) - 1.0;
        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        float g = grain * (0.5 + 0.5 * smoothstep(0.0, 0.25, lum)) * (1.0 - 0.6 * lum);
        col += tri * (g + 1.0 / 255.0);

        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }
    `,
    attributes: { position },
    uniforms: {
      tex: ldrFbo,
      texel: regl.prop('texel'),
      fxaaOn: regl.prop('fxaaOn'),
      vignette: regl.prop('vignette'),
      vignetteStart: regl.prop('vignetteStart'),
      grain: regl.prop('grain'),
      seed: regl.prop('seed')
    },
    count: 3,
    depth: { enable: false },
    blend: { enable: false }
  })

  let frame = 0
  function render ({
    scene,
    bloom,
    width,
    height,
    bloomIntensity,
    exposure,
    ca,
    fxaa,
    vignette,
    vignetteStart,
    grain
  }) {
    const w = Math.max(1, width | 0)
    const h = Math.max(1, height | 0)
    if (ldrFbo.width !== w || ldrFbo.height !== h) ldrFbo.resize(w, h)

    tonemapPass({ scene, bloom, bloomIntensity, exposure, ca: Math.max(0, ca) })
    frame = (frame + 1) % 251
    finalPass({
      texel: [1 / w, 1 / h],
      fxaaOn: fxaa ? 1 : 0,
      vignette,
      // smoothstep() is undefined when edge0 >= edge1
      vignetteStart: Math.min(vignetteStart, 0.99),
      grain,
      seed: frame * 7.13
    })
  }

  function destroy () {
    ldrFbo.destroy()
    ldrTexture.destroy()
    position.destroy()
  }

  return { render, destroy }
}
