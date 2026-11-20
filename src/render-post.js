// Final composite, in two passes:
//  A) scene + bloom (linear) -> radial chromatic aberration -> exposure ->
//     ACES filmic tone mapping -> gamma, into an 8-bit buffer that keeps the
//     luma in alpha for FXAA
//     (plus the god rays, render-godrays, added like the bloom)
//     (then the cinematic layers, all linear and before tone mapping:
//     halation = a wide bloom level made red/orange, anamorphic flares from
//     render-flares tinted slightly blue, and lens dirt lit by the bloom)
//  B) FXAA -> section colour grading (lift / gamma / gain, saturation,
//     temperature) -> vignette -> film grain + triangular dither, to the canvas
// Chromatic aberration is done in A, on the HDR samples, so FXAA smooths its
// fringes as well; it is 0 at the centre and grows toward the corners.
import { FRAG_PRECISION, FULLSCREEN_VERT, BLOOM_CODEC } from './render-bloom'

const lumaNormalise = (c) => {
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  return c.map((x) => x / l)
}
// film halation: red / orange; anamorphic streaks: a cool blue
const HALATION_TINT = lumaNormalise([1, 0.36, 0.14])
const FLARES_TINT = lumaNormalise([0.55, 0.78, 1.15])
const finiteMax0 = (x) => (Number.isFinite(x) ? Math.max(0, x) : 0)

// grade: { lift, gamma, gain, saturation, warmth } or null (= identity).
// warmth -1..1 tilts red against blue at constant luminance. Writes the
// grading uniforms into `out` (reused every frame: no allocation).
function gradeUniforms (grade, out) {
  const identity = () => {
    out.gradeOn = 0
    out.lift = 0
    out.gammaInv = 1
    out.gain = 1
    out.saturation = 1
    out.gradeTint[0] = out.gradeTint[1] = out.gradeTint[2] = 1
  }
  if (!grade) return identity()
  const f = (x, d, lo, hi) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d)
  const lift = f(grade.lift, 0, -0.2, 0.2)
  const gamma = f(grade.gamma, 1, 0.3, 3)
  const gain = f(grade.gain, 1, 0, 3)
  const saturation = f(grade.saturation, 1, 0, 3)
  const warmth = f(grade.warmth, 0, -1, 1)
  const on =
    Math.abs(lift) > 1e-4 || Math.abs(gamma - 1) > 1e-4 || Math.abs(gain - 1) > 1e-4 ||
    Math.abs(saturation - 1) > 1e-4 || Math.abs(warmth) > 1e-4
  if (!on) return identity()
  const t = 0.15 * warmth
  // lumaNormalise inline: luminance of (1 + t, 1, 1 - t), > 0 for |t| <= 0.15
  const l = 0.2126 * (1 + t) + 0.7152 + 0.0722 * (1 - t)
  out.gradeOn = 1
  out.lift = lift
  out.gammaInv = 1 / gamma
  out.gain = gain
  out.saturation = saturation
  out.gradeTint[0] = (1 + t) / l
  out.gradeTint[1] = 1 / l
  out.gradeTint[2] = (1 - t) / l
}

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
      uniform sampler2D godrays; // linear, bloom codec (render-godrays)
      uniform float godraysIntensity;
      uniform float exposure;
      uniform float ca;
      uniform sampler2D halo; // wide bloom level (bloom codec)
      uniform float halation;
      uniform vec3 halationTint; // luminance-normalised
      uniform sampler2D flares; // render-flares (bloom codec)
      uniform float flaresIntensity;
      uniform vec3 flaresTint; // luminance-normalised
      uniform sampler2D dirt; // lens dirt, uint8 rgba
      uniform float lensDirt;
      uniform vec2 dirtScale; // keeps the dirt texture square on screen
      ${BLOOM_CODEC}

      const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

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
        // uniform branch: no fetch while the rays are off
        if (godraysIntensity > 1e-4) {
          col += bloomDecode(texture2D(godrays, uv)) * godraysIntensity;
        }
        // halation: the wide glow, by luminance, red-shifted like the light
        // scattered back through film
        if (halation > 1e-4) {
          float hl = dot(bloomDecode(texture2D(halo, uv)), LUMA);
          col += halationTint * (min(hl, 64.0) * halation);
        }
        // anamorphic streaks, by luminance, slightly blue
        if (flaresIntensity > 1e-4) {
          float fl = dot(bloomDecode(texture2D(flares, uv)), LUMA);
          col += flaresTint * (min(fl, 64.0) * flaresIntensity);
        }
        // lens dirt: lit by the bloom only, gated so faint glow (the dark
        // gaps of the fabric) never shows it
        if (lensDirt > 1e-4) {
          vec3 bl = bloomDecode(texture2D(bloom, uv)) * bloomIntensity;
          float gate = smoothstep(0.02, 0.3, dot(bl, LUMA));
          vec3 d = texture2D(dirt, (uv - 0.5) * dirtScale + 0.5).rgb;
          col += min(bl, vec3(64.0)) * d * (gate * lensDirt);
        }
        // never hand NaN / negatives to the tone curve
        col = max(col, vec3(0.0));
        if (!(dot(col, LUMA) == dot(col, LUMA))) col = vec3(0.0);
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
      godrays: regl.prop('godrays'),
      godraysIntensity: regl.prop('godraysIntensity'),
      exposure: regl.prop('exposure'),
      ca: regl.prop('ca'),
      halo: regl.prop('halo'),
      halation: regl.prop('halation'),
      halationTint: regl.prop('halationTint'),
      flares: regl.prop('flares'),
      flaresIntensity: regl.prop('flaresIntensity'),
      flaresTint: regl.prop('flaresTint'),
      dirt: regl.prop('dirt'),
      lensDirt: regl.prop('lensDirt'),
      dirtScale: regl.prop('dirtScale')
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
      uniform float gradeOn;
      uniform float lift;
      uniform float gammaInv; // 1 / gamma
      uniform float gain;
      uniform float saturation;
      uniform vec3 gradeTint; // temperature, luminance-normalised

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

        // section colour grading (uniform branch: off = untouched groove)
        if (gradeOn > 0.5) {
          col = max(gain * (col + lift * (vec3(1.0) - col)), vec3(0.0));
          col = pow(col + 1e-6, vec3(gammaInv));
          float gLum = dot(col, vec3(0.2126, 0.7152, 0.0722));
          col = mix(vec3(gLum), col, saturation) * gradeTint;
          col = clamp(col, 0.0, 1.0);
        }

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
      seed: regl.prop('seed'),
      gradeOn: regl.prop('gradeOn'),
      lift: regl.prop('lift'),
      gammaInv: regl.prop('gammaInv'),
      gain: regl.prop('gain'),
      saturation: regl.prop('saturation'),
      gradeTint: regl.prop('gradeTint')
    },
    count: 3,
    depth: { enable: false },
    blend: { enable: false }
  })

  let frame = 0
  // reused every frame (no per-frame allocation)
  const setVec2 = (v, x, y) => { v[0] = x; v[1] = y; return v }
  const dirtScale = new Float32Array(2)
  const finalTexel = new Float32Array(2)
  const finalProps = { gradeTint: new Float32Array([1, 1, 1]) }
  function render ({
    scene,
    bloom,
    width,
    height,
    bloomIntensity,
    godrays = null,
    godraysIntensity = 0,
    exposure,
    ca,
    fxaa,
    vignette,
    vignetteStart,
    grain,
    halo = null,
    halation = 0,
    flares = null,
    flaresIntensity = 0,
    dirt = null,
    lensDirt = 0,
    grade = null
  }) {
    const w = Math.max(1, width | 0)
    const h = Math.max(1, height | 0)
    if (ldrFbo.width !== w || ldrFbo.height !== h) ldrFbo.resize(w, h)

    tonemapPass({
      scene,
      bloom,
      bloomIntensity,
      // any valid texture when the rays are off (never sampled then)
      godrays: godrays || bloom,
      godraysIntensity: godrays ? Math.max(0, godraysIntensity) : 0,
      exposure,
      ca: Math.max(0, ca),
      // any valid texture when an effect is off (never sampled then)
      halo: halo || bloom,
      halation: halo ? finiteMax0(halation) : 0,
      halationTint: HALATION_TINT,
      flares: flares || bloom,
      flaresIntensity: flares ? finiteMax0(flaresIntensity) : 0,
      flaresTint: FLARES_TINT,
      dirt: dirt || bloom,
      lensDirt: dirt ? finiteMax0(lensDirt) : 0,
      // square texels of the dirt on screen, covering the long side
      dirtScale: setVec2(dirtScale, w >= h ? 1 : w / h, w >= h ? h / w : 1)
    })
    frame = (frame + 1) % 251
    const fp = finalProps
    fp.texel = setVec2(finalTexel, 1 / w, 1 / h)
    fp.fxaaOn = fxaa ? 1 : 0
    fp.vignette = vignette
    // smoothstep() is undefined when edge0 >= edge1
    fp.vignetteStart = Math.min(vignetteStart, 0.99)
    fp.grain = grain
    fp.seed = frame * 7.13
    gradeUniforms(grade, fp)
    finalPass(fp)
  }

  function destroy () {
    ldrFbo.destroy()
    ldrTexture.destroy()
    position.destroy()
  }

  return { render, destroy }
}
