// Final composite, in two passes:
//  A) scene + bloom (linear) -> radial chromatic aberration -> exposure ->
//     tone mapping (AgX by default, ACES as the alternative) -> display
//     encoding, into an 8-bit buffer that keeps the luma in alpha for FXAA
//     (plus the god rays, render-godrays, added like the bloom)
//     (then the cinematic layers, all linear and before tone mapping:
//     halation = a wide bloom level made red/orange, anamorphic flares from
//     render-flares tinted slightly blue, and lens dirt lit by the bloom)
//  B) FXAA -> section colour grading (lift / gamma / gain, saturation,
//     temperature) -> section 3D LUT (render-lut, display space) ->
//     vignette -> film grain + triangular dither, to the canvas
// The two grading stages split the work: the grade does the global moves
// (black level, mid-tone gamma, saturation, temperature), the LUTs only do
// what a grade cannot (tone-curve shape, split toning, bleach bypass), so a
// section's look is never applied twice.
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

// ---- AgX (Troy Sobotka's AgX as shipped in Blender, after Benjamin
// Wrensch's minimal GLSL port) -----------------------------------------------
// Looks applied on the sigmoid's output, ASC CDL style: offset, slope and
// power per channel, then saturation around the luminance. 'punchy' and
// 'golden' are Blender's; agxLookAmount blends from 'base' toward the look.
// 'fdss' (the default) is a little more contrasted than punchy: with the
// exposure match it keeps the dark lines and the gaps within ~0.025 of the
// ACES look the visuals were tuned with (punchy at 0.85 lifted them by
// 15-25%: greyer, flatter thin lines on black) and the ribbons within ~0.03.
export const AGX_LOOKS = {
  base: { offset: [0, 0, 0], slope: [1, 1, 1], power: [1, 1, 1], saturation: 1 },
  fdss: { offset: [0, 0, 0], slope: [1, 1, 1], power: [1.5, 1.5, 1.5], saturation: 1.3 },
  punchy: { offset: [0, 0, 0], slope: [1, 1, 1], power: [1.35, 1.35, 1.35], saturation: 1.4 },
  golden: { offset: [0, 0, 0], slope: [1, 0.9, 0.5], power: [0.8, 0.8, 0.8], saturation: 0.8 }
}
const AGX_MIN_EV = -12.47393
const AGX_MAX_EV = 4.026069
// the "default contrast" sigmoid, 6th order polynomial fit
const agxCurve = (x) => {
  const x2 = x * x
  const x4 = x2 * x2
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232
}
const AGX_LUMA = [0.2126, 0.7152, 0.0722]
// Grey only (the inset / outset matrices keep grey grey): linear scene
// value -> display-encoded value, look included (luminance of the result)
function agxGrey (x, look) {
  const ev = Math.min(AGX_MAX_EV, Math.max(AGX_MIN_EV, Math.log2(Math.max(x, 1e-10))))
  const v = Math.max(0, agxCurve((ev - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV)))
  // scalar loop: this runs ~500 times per exposure match, no allocation
  let l = 0
  for (let i = 0; i < 3; i++) {
    l += AGX_LUMA[i] * Math.pow(Math.max(0, v * look.slope[i] + look.offset[i]), look.power[i])
  }
  return Math.min(1, Math.max(0, l))
}
const acesDisplay = (x) => {
  const y = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)
  return Math.pow(Math.min(1, Math.max(0, y)), 1 / 2.2)
}
// Scene values the visuals actually hold (black gaps .. glowing ribbons ..
// bloom cores) and how much each one matters: the visuals were tuned with
// ACES, so AgX gets the exposure gain that best reproduces ACES' display
// values over them (least squares in display space). AgX's flatter base
// curve lifts the darks and dulls the whites whatever the gain: the default
// punchy look is what keeps the blacks black and the cores near white.
const MATCH_X = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.4, 0.8, 1.5, 3, 6]
// The darks weigh the most: thin lines over black and the gaps between
// them are what reads first
const MATCH_W = [2, 2, 2, 1.5, 1, 1, 1, 0.8, 0.6, 0.4, 0.3]
function agxExposureMatch (look) {
  const err = (lk) => {
    const k = Math.pow(2, lk)
    let e = 0
    for (let i = 0; i < MATCH_X.length; i++) {
      const d = agxGrey(MATCH_X[i] * k, look) - acesDisplay(MATCH_X[i])
      e += MATCH_W[i] * d * d
    }
    return e
  }
  // golden-section search on log2(gain), in [-1, 3] EV
  let a = -1
  let b = 3
  const r = 0.6180339887
  let c = b - r * (b - a)
  let d = a + r * (b - a)
  let fc = err(c)
  let fd = err(d)
  for (let i = 0; i < 40; i++) {
    if (fc < fd) {
      b = d; d = c; fd = fc; c = b - r * (b - a); fc = err(c)
    } else {
      a = c; c = d; fc = fd; d = a + r * (b - a); fd = err(d)
    }
  }
  const k = Math.pow(2, (a + b) / 2)
  return Number.isFinite(k) ? k : 1
}
// The look's parameters, blended from 'base' by amount, then the white
// gain: AgX's shoulder is much softer than ACES', so even matched the bright
// ribbons (scene ~0.5..2) read ~0.07 duller; a display-space slope of
// white > 1 (with the matching, a lower exposure) brings them back up and
// lets the bloom cores reach white again, at the cost of clipping the last
// fraction of AgX's shoulder. Written into the reused uniforms of `out`;
// returns the matching exposure gain, cached on a coarse grid of amount
// (1/50) and white (1/200): both are drifted by the settings drift, and a
// step of the grid moves the gain far less than one 8-bit display step, so
// the search (a few hundred scalar evaluations) only runs when the look
// really changes, not every few frames.
const agxCache = { key: '', gain: 1 }
const agxMatchLook = { offset: [0, 0, 0], slope: [1, 1, 1], power: [1, 1, 1] }
function agxUniforms (lookName, amount, white, out) {
  const look = AGX_LOOKS[lookName] || AGX_LOOKS.base
  const base = AGX_LOOKS.base
  const t = Number.isFinite(amount) ? Math.min(1, Math.max(0, amount)) : 0
  const w = Number.isFinite(white) ? Math.min(1.5, Math.max(0.5, white)) : 1
  for (let i = 0; i < 3; i++) {
    out.agxOffset[i] = base.offset[i] + (look.offset[i] - base.offset[i]) * t
    out.agxSlope[i] = (base.slope[i] + (look.slope[i] - base.slope[i]) * t) * w
    out.agxPower[i] = base.power[i] + (look.power[i] - base.power[i]) * t
  }
  out.agxSat = base.saturation + (look.saturation - base.saturation) * t
  const tq = Math.round(t * 50)
  const wq = Math.round(w * 200)
  const key = `${lookName}:${tq}:${wq}`
  if (agxCache.key !== key) {
    agxCache.key = key
    // matched on the grid point itself, so the gain only depends on the key
    const ts = tq / 50
    const ws = wq / 200
    const m = agxMatchLook
    for (let i = 0; i < 3; i++) {
      m.offset[i] = base.offset[i] + (look.offset[i] - base.offset[i]) * ts
      m.slope[i] = (base.slope[i] + (look.slope[i] - base.slope[i]) * ts) * ws
      m.power[i] = base.power[i] + (look.power[i] - base.power[i]) * ts
    }
    agxCache.gain = agxExposureMatch(m)
  }
  return agxCache.gain
}

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
      uniform float agxOn; // 1 = AgX, 0 = ACES
      uniform vec3 agxOffset; // look (ASC CDL on the sigmoid's output)
      uniform vec3 agxSlope; // includes the white gain
      uniform vec3 agxPower;
      uniform float agxSat;
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

      // AgX: inset matrix (a slight desaturation that makes bright saturated
      // colours travel toward white instead of skewing hue), log2 encoding
      // between AGX min / max EV around 0.18, the default-contrast sigmoid
      // (polynomial fit), the look, then the outset matrix. The result is
      // already display-encoded (2.2), like pow(aces(), 1/2.2).
      // GLSL mat3() is column-major: these are the transposed matrices of
      // the reference implementation, as in Wrensch's port.
      const mat3 AGX_INSET = mat3(
        0.842479062253094, 0.0423282422610123, 0.0423756549057051,
        0.0784335999999992, 0.878468636469772, 0.0784336,
        0.0792237451477643, 0.0791661274605434, 0.879142973793104);
      const mat3 AGX_OUTSET = mat3(
        1.19687900512017, -0.0528968517574562, -0.0529716355144438,
        -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
        -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
      const float AGX_MIN_EV = -12.47393;
      const float AGX_MAX_EV = 4.026069;

      vec3 agxCurve(vec3 x) {
        vec3 x2 = x * x;
        vec3 x4 = x2 * x2;
        return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 -
          6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
      }

      vec3 agx(vec3 x) {
        vec3 v = AGX_INSET * x;
        // 1e-4 (-13.3 EV) is below min EV and a normal fp16 number (the
        // smallest is 2^-14 ~ 6.1e-5; 1e-5 would be subnormal, flushed to 0
        // on many mobile GPUs), so log2 never sees 0 even in mediump
        v = clamp(log2(max(v, vec3(1e-4))), AGX_MIN_EV, AGX_MAX_EV);
        v = agxCurve((v - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV));
        // look: offset / slope / power, then saturation around the new
        // luminance (pow of a clamped base: never pow(negative))
        v = pow(max(v * agxSlope + agxOffset, vec3(0.0)), agxPower);
        float l = dot(v, LUMA);
        v = l + agxSat * (v - l);
        return clamp(AGX_OUTSET * v, 0.0, 1.0);
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
        // uniform branch: only one tone curve runs
        if (agxOn > 0.5) {
          col = agx(col * exposure);
        } else {
          col = pow(aces(col * exposure), vec3(1.0 / 2.2));
        }
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
      dirtScale: regl.prop('dirtScale'),
      agxOn: regl.prop('agxOn'),
      agxOffset: regl.prop('agxOffset'),
      agxSlope: regl.prop('agxSlope'),
      agxPower: regl.prop('agxPower'),
      agxSat: regl.prop('agxSat')
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
      uniform sampler2D lut; // N^3 LUT as an N*N x N strip (render-lut)
      uniform float lutOn;
      uniform float lutSize; // N

      // 3D LUT lookup on a 2D strip: blue picks the slice (slices side by
      // side), red / green are bilinear inside it (LINEAR filtering, texel
      // centres), and the two nearest slices are mixed by hand (no 3D
      // textures in WebGL1). The amount and the section blend are already
      // baked into the strip on the CPU.
      vec3 applyLut(vec3 c) {
        c = clamp(c, 0.0, 1.0);
        float n1 = lutSize - 1.0;
        float b = c.b * n1;
        float b0 = floor(b);
        float b1 = min(b0 + 1.0, n1);
        vec2 rg = c.rg * n1 + 0.5;
        float invW = 1.0 / (lutSize * lutSize);
        float y = rg.y / lutSize;
        vec3 s0 = texture2D(lut, vec2((b0 * lutSize + rg.x) * invW, y)).rgb;
        vec3 s1 = texture2D(lut, vec2((b1 * lutSize + rg.x) * invW, y)).rgb;
        return mix(s0, s1, b - b0);
      }

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

        // section LUT, display space (uniform branch: no fetch when off)
        if (lutOn > 0.5) col = applyLut(col);

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
      gradeTint: regl.prop('gradeTint'),
      lut: regl.prop('lut'),
      lutOn: regl.prop('lutOn'),
      lutSize: regl.prop('lutSize')
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
  const tonemapProps = {
    agxOffset: new Float32Array(3),
    agxSlope: new Float32Array(3),
    agxPower: new Float32Array(3),
    agxSat: 1
  }
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
    grade = null,
    tonemapper = 'agx',
    agxLook = 'fdss',
    agxLookAmount = 1,
    agxWhite = 1,
    lut = null // { texture, size, on } from render-lut
  }) {
    const w = Math.max(1, width | 0)
    const h = Math.max(1, height | 0)
    if (ldrFbo.width !== w || ldrFbo.height !== h) ldrFbo.resize(w, h)

    // AgX gets the extra gain that matches ACES' brightness (the visuals
    // were tuned with ACES); `exposure` keeps meaning the same thing
    const useAgx = tonemapper !== 'aces'
    const tp = tonemapProps
    const agxGain = agxUniforms(agxLook, agxLookAmount, agxWhite, tp)
    const exp = finiteMax0(exposure) * (useAgx ? agxGain : 1)
    tp.agxOn = useAgx ? 1 : 0
    tonemapPass(Object.assign(tp, {
      scene,
      bloom,
      bloomIntensity,
      // any valid texture when the rays are off (never sampled then)
      godrays: godrays || bloom,
      godraysIntensity: godrays ? Math.max(0, godraysIntensity) : 0,
      exposure: exp,
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
    }))
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
    const lutOn = !!(lut && lut.on && lut.texture)
    fp.lutOn = lutOn ? 1 : 0
    // any valid texture when off (never sampled then)
    fp.lut = lutOn ? lut.texture : ldrTexture
    fp.lutSize = lutOn ? lut.size : 2
    finalPass(fp)
  }

  function destroy () {
    ldrFbo.destroy()
    ldrTexture.destroy()
    position.destroy()
  }

  return { render, destroy }
}
