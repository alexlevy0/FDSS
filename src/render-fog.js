// Volumetric height fog (ground haze) on the HDR scene, before the bloom.
//
// There is no depth buffer, but the flat fabric lies on the floor plane
// z = floorZ, so each pixel's view ray is cut where it meets that plane (or
// at maxDist when it misses it: sky, horizon). The 3D shapes are
// approximated: a well (the tunnel) sinks the end of the rays that land
// inside its rim down to its bottom (so the bottom of the well is hazier
// than the rim), and the raised shapes (ball, dome, ring) are a soft
// bounding sphere that ends the rays hitting it there (the haze stays
// behind the shape, not painted in front of it). Along that segment
// the density falls exponentially with the height above the floor,
// sigma * exp(-h / H), whose integral is analytic: for a straight ray going
// from height h0 to h1 over a length L,
//   tau = sigma * L * H * (exp(-h0 / H) - exp(-h1 / H)) / (h1 - h0)
// (the mean density along the segment times its length; its limit for a
// level ray is sigma * L * exp(-h0 / H)). The optical depth therefore grows
// with the distance from the camera (Beer-Lambert) and with how long the
// ray grazes the floor. The segment starts at startDist from the eye, a
// fraction of the distance to the fabric's centre: the near ribbons get no
// fog at all and stay crisp, the far side and the gaps between lines get
// the haze.
//
// Slow drifting wisps: the density is modulated by a cheap 3D value noise
// (1-2 octaves, hash based, no texture) sampled where the ray is about half
// a scale height above the floor, so the wisps sit on the floor. The noise
// domain is periodic (FOG_NOISE_PERIOD cells): the eye's part of the domain
// coordinate is wrapped on the CPU (with the drift offset) and the shader
// wraps every octave, so the coordinates stay below a few PERIODs and
// fract() keeps enough bits on mediump-only GPUs (fp16 resolves ~1/64 at
// 16; at 64-150 it would be 1/32-1/8: blocky wisps). Without fragment highp
// a single octave is used.
//
// The outer history rings (past the fabric along the view ray) get less
// density: they must keep their contrast in the breakdowns, where the haze
// is densest. The nearer rings (beside the fabric, on the camera side) get
// the normal density.
//
// In-scattered colour: a dark palette base, plus a brighter tint toward the
// orbiting key light (a narrow forward lobe) and around the god-ray source
// on screen, so the haze glows where the rays come from.
//
// Two passes: the fog itself at reduced resolution (it is very low
// frequency) into a small buffer holding the premultiplied in-scatter (rgb)
// and the transmittance (alpha), then a full-res composite
//   scene' = scene * transmittance + inscatter
// in linear light. The scene buffer is display-referred (see render-bloom),
// so the composite linearises and re-encodes it, and its output is a new
// buffer: the scene / TAA buffers are feedback (motion-blur trails, history)
// and must never accumulate the fog.
//
// Buffers are of the scene's type; on the uint8 fallback the fog buffer
// stores sqrt(inscatter) (the bloom codec) so the dark haze does not band.
import { FRAG_PRECISION, FULLSCREEN_VERT } from './render-bloom'

export const FOG_MAX_OCTAVES = 2
// period of the noise domain, in cells (the offsets wrap at this): small so
// the domain coordinates stay precise in mediump (every octave doubles
// exactly, so any whole period tiles)
export const FOG_NOISE_PERIOD = 16

function fragmentHighp (regl) {
  const gl = regl._gl
  if (!gl || !gl.getShaderPrecisionFormat) return true
  try {
    const f = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)
    return !!f && f.precision > 0
  } catch (e) {
    return false
  }
}

export default function createRenderFog (regl, { type = 'uint8', hdr = false } = {}) {
  const defines = hdr ? '' : '#define FOG_ENCODED\n'
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
  const fogFbo = makeFbo() // reduced resolution: inscatter + transmittance
  const outFbo = makeFbo() // full resolution: the fogged scene
  // mediump-only fragment shaders: one octave (the second one's domain is
  // twice as large, hence half as precise)
  const maxOctaves = fragmentHighp(regl) ? FOG_MAX_OCTAVES : 1

  const fogPass = regl({
    // the view ray is linear in clip space when built from the camera basis
    // (forward + x * right + y * up, unnormalised), so it is interpolated
    // exactly from the 3 vertices of the full-screen triangle
    vert: `
      precision highp float;
      attribute vec2 position;
      uniform vec3 camFwd;
      uniform vec3 camRight; // x tan(fov / 2) x aspect
      uniform vec3 camUp; // x tan(fov / 2)
      varying vec2 uv;
      varying vec3 ray;
      void main() {
        uv = position * 0.5 + 0.5;
        ray = camFwd + position.x * camRight + position.y * camUp;
        gl_Position = vec4(position, 0, 1);
      }
    `,
    frag: `
      #define MAX_OCTAVES ${FOG_MAX_OCTAVES}
      #define PERIOD ${FOG_NOISE_PERIOD}.0
      ${defines}
      ${FRAG_PRECISION}
      varying vec2 uv;
      varying vec3 ray;
      uniform vec3 eye;
      uniform float floorZ;
      uniform float sigma; // density at the floor (1 / world unit)
      uniform float heightScale; // H, world units
      uniform float startDist;
      uniform float maxDist;
      uniform float maxFog; // cap of 1 - transmittance
      uniform float noiseAmount;
      uniform float noiseScale; // cells per world unit
      // eye.xy * noiseScale + wind drift (xy) and evolution (z), in cells,
      // wrapped at PERIOD by the CPU
      uniform vec3 noiseOrigin;
      uniform vec3 well; // tunnel: depth below the floor, rim radius, -
      uniform vec4 occluder; // raised shape: centre, radius (0 = none)
      uniform vec2 farFade; // distances over which the far density fades
      uniform float octaves;
      uniform vec3 baseColor; // linear
      uniform vec3 lightColor; // linear
      uniform vec3 lightDir; // toward the key light
      uniform vec2 glowUv; // god-ray source on screen
      uniform float glowAmount;
      uniform float aspect;

      // Dave Hoskins' hash (no sine: stable in mediump for small inputs)
      float hash13(vec3 p3) {
        p3 = fract(p3 * 0.1031);
        p3 += dot(p3, p3.zyx + 31.32);
        return fract((p3.x + p3.y) * p3.z);
      }
      float cell(vec3 i) {
        return hash13(mod(i, PERIOD));
      }
      // periodic value noise, 0..1
      float vnoise(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = mix(cell(i), cell(i + vec3(1.0, 0.0, 0.0)), f.x);
        float b = mix(cell(i + vec3(0.0, 1.0, 0.0)), cell(i + vec3(1.0, 1.0, 0.0)), f.x);
        float c = mix(cell(i + vec3(0.0, 0.0, 1.0)), cell(i + vec3(1.0, 0.0, 1.0)), f.x);
        float d = mix(cell(i + vec3(0.0, 1.0, 1.0)), cell(i + vec3(1.0, 1.0, 1.0)), f.x);
        return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
      }

      vec4 fogEncode(vec3 c, float transmittance) {
#ifdef FOG_ENCODED
        return vec4(sqrt(clamp(c, 0.0, 1.0)), transmittance);
#else
        return vec4(max(c, vec3(0.0)), transmittance);
#endif
      }

      void main() {
        vec3 r = ray * inversesqrt(max(dot(ray, ray), 1e-8));
        float H = max(heightScale, 0.01);
        float he = eye.z - floorZ; // eye height above the floor
        // end of the segment: the floor, or maxDist
        float T = maxDist;
        if (he > 0.0 && r.z < -1e-4) {
          T = min(T, he / -r.z);
          // inside the well's rim, the ray goes on down toward its bottom
          // (deepest at the centre); the shapes are centred on the origin
          if (well.x > 0.0) {
            float rr = length(eye.xy + r.xy * T);
            float d = well.x * (1.0 - smoothstep(0.35 * well.y, well.y, rr));
            T = min(T + d / -r.z, maxDist);
          }
        } else if (he <= 0.0 && r.z > 1e-4) T = min(T, -he / r.z);
        // a raised shape: the rays hitting its bounding sphere end there,
        // softly (by how deep they cut into it: no hard disc at its edge)
        if (occluder.w > 0.0) {
          vec3 oc = eye - occluder.xyz;
          float b = dot(oc, r);
          float R2 = occluder.w * occluder.w;
          float disc = b * b - (dot(oc, oc) - R2);
          if (disc > 0.0) {
            float tn = -b - sqrt(disc);
            if (tn > 0.0) T = mix(T, min(T, tn), smoothstep(0.0, 0.35, disc / R2));
          }
        }
        float t0 = min(startDist, T);
        float L = T - t0;
        if (L <= 1e-4) {
          gl_FragColor = fogEncode(vec3(0.0), 1.0);
          return;
        }
        // heights at both ends; under the floor counts as on it (bounded)
        float h0 = max(he + r.z * t0, 0.0);
        float h1 = max(he + r.z * T, 0.0);
        float e0 = exp(-min(h0 / H, 30.0));
        float e1 = exp(-min(h1 / H, 30.0));
        float dh = h1 - h0;
        // mean relative density along the segment, in (0, 1]
        float mean = abs(dh) > 1e-3 * H ? H * (e0 - e1) / dh : 0.5 * (e0 + e1);
        mean = clamp(mean, 0.0, 1.0);

        // drifting wisps, sampled about half a scale height above the floor
        float m = 1.0;
        if (noiseAmount > 1e-3) {
          float ts = abs(r.z) > 1e-4 ? (0.5 * H - he) / r.z : 0.5 * (t0 + T);
          ts = clamp(ts, t0, T);
          // only the ray's part is added here (the eye's is in noiseOrigin)
          vec3 p = mod(noiseOrigin + vec3(r.xy * (ts * noiseScale), 0.0), PERIOD);
          float n = 0.0;
          float wsum = 0.0;
          float w = 1.0;
          for (int i = 0; i < MAX_OCTAVES; i++) {
            if (float(i) >= octaves) break;
            n += vnoise(p) * w;
            wsum += w;
            w *= 0.5;
            // exact x2: keeps the domain periodic, so wrapping is seamless
            p = mod(p * 2.0 + vec3(17.0, 5.0, 11.0), PERIOD);
          }
          n = smoothstep(0.2, 0.8, n / max(wsum, 1e-4));
          m = max(0.0, 1.0 + noiseAmount * (2.0 * n - 1.0));
        }

        // the outer history rings (past the fabric along the ray) keep most
        // of their contrast
        float farK = 1.0 - 0.6 * smoothstep(farFade.x, farFade.y, T);
        float tau = min(sigma * farK * L * mean * m, 8.0);
        float fog = min(1.0 - exp(-tau), maxFog);

        // in-scatter: forward lobe toward the key light (cos^6 by squaring,
        // no pow(0, y)) and a soft glow around the god-ray source
        float fw = max(dot(r, lightDir), 0.0);
        float fw2 = fw * fw;
        float lobe = fw2 * fw2 * fw2;
        vec2 d = (uv - glowUv) * vec2(aspect, 1.0);
        float glow = exp(-min(dot(d, d) * 5.0, 30.0)) * glowAmount;
        vec3 col = baseColor + lightColor * min(0.25 + 0.75 * lobe + glow, 2.0);
        gl_FragColor = fogEncode(col * fog, 1.0 - fog);
      }
    `,
    attributes: { position },
    uniforms: {
      camFwd: regl.prop('camFwd'),
      camRight: regl.prop('camRight'),
      camUp: regl.prop('camUp'),
      eye: regl.prop('eye'),
      floorZ: regl.prop('floorZ'),
      sigma: regl.prop('sigma'),
      heightScale: regl.prop('heightScale'),
      startDist: regl.prop('startDist'),
      maxDist: regl.prop('maxDist'),
      maxFog: regl.prop('maxFog'),
      noiseAmount: regl.prop('noiseAmount'),
      noiseScale: regl.prop('noiseScale'),
      noiseOrigin: regl.prop('noiseOrigin'),
      well: regl.prop('well'),
      occluder: regl.prop('occluder'),
      farFade: regl.prop('farFade'),
      octaves: regl.prop('octaves'),
      baseColor: regl.prop('baseColor'),
      lightColor: regl.prop('lightColor'),
      lightDir: regl.prop('lightDir'),
      glowUv: regl.prop('glowUv'),
      glowAmount: regl.prop('glowAmount'),
      aspect: regl.prop('aspect')
    },
    count: 3,
    depth: { enable: false },
    blend: { enable: false },
    framebuffer: fogFbo
  })

  const compositePass = regl({
    vert: FULLSCREEN_VERT,
    frag: `
      ${defines}
      ${FRAG_PRECISION}
      varying vec2 uv;
      uniform sampler2D scene; // display-referred
      uniform sampler2D fog;
      void main() {
        vec4 s = texture2D(scene, uv);
        vec4 f = texture2D(fog, uv);
#ifdef FOG_ENCODED
        vec3 inscatter = f.rgb * f.rgb;
#else
        vec3 inscatter = max(f.rgb, vec3(0.0));
#endif
        float tr = clamp(f.a, 0.0, 1.0);
        vec3 lin = pow(max(s.rgb, vec3(1e-6)), vec3(2.2));
        lin = lin * tr + inscatter;
        gl_FragColor = vec4(pow(max(lin, vec3(1e-6)), vec3(1.0 / 2.2)), s.a);
      }
    `,
    attributes: { position },
    uniforms: {
      scene: regl.prop('scene'),
      fog: fogFbo
    },
    count: 3,
    depth: { enable: false },
    blend: { enable: false },
    framebuffer: outFbo
  })

  // reused uniform arrays (no allocation per frame)
  const u = {
    camFwd: [0, 0, -1],
    camRight: [1, 0, 0],
    camUp: [0, 1, 0],
    eye: [0, 0, 1],
    noiseOrigin: [0, 0, 0],
    well: [0, 1, 0],
    occluder: [0, 0, 0, 0],
    farFade: [1, 2],
    glowUv: [0.5, 0.5]
  }
  const wrap = (x) => {
    const m = x % FOG_NOISE_PERIOD
    return Number.isFinite(m) ? (m < 0 ? m + FOG_NOISE_PERIOD : m) : 0
  }
  const fin = (x, d) => (Number.isFinite(x) ? x : d)
  const TAN_HALF_FOV = Math.tan(Math.PI / 8) // index.js: perspective(PI / 4)

  // scene: display-referred framebuffer; view: world -> view (column-major);
  // center: the fabric's centre (sets where the fog starts); noiseOffset in
  // cells (wrapped by the caller at FOG_NOISE_PERIOD); colours linear;
  // wellDepth / wellRadius: the tunnel's depth below the floor (0 = none)
  // and its rim radius; occluderRadius: bounding radius of a raised shape
  // around center (0 = none).
  // Returns the framebuffer holding the fogged scene.
  function render ({
    scene, width, height, view, center, scale = 0.5, floorZ = 0,
    wellDepth = 0, wellRadius = 1.35, occluderRadius = 0,
    density = 0.3, heightScale = 0.35, start = 0.7, maxFog = 0.55,
    noise = 0.5, noiseScale = 1.6, noiseOffset, octaves = 2,
    baseColor, lightColor, lightDir, glowUv, glowAmount = 0
  }) {
    const w = Math.max(1, width | 0)
    const h = Math.max(1, height | 0)
    const s = Math.min(Math.max(fin(scale, 0.5), 0.125), 1)
    const fw = Math.max(1, Math.round(w * s))
    const fh = Math.max(1, Math.round(h * s))
    if (fogFbo.width !== fw || fogFbo.height !== fh) fogFbo.resize(fw, fh)
    if (outFbo.width !== w || outFbo.height !== h) outFbo.resize(w, h)

    // camera basis from the view matrix: its rows are right, up, back
    const aspect = w / h
    const tx = view[12]
    const ty = view[13]
    const tz = view[14]
    for (let i = 0; i < 3; i++) {
      u.camRight[i] = view[i * 4] * TAN_HALF_FOV * aspect
      u.camUp[i] = view[i * 4 + 1] * TAN_HALF_FOV
      u.camFwd[i] = -view[i * 4 + 2]
      // eye = -R^T t
      u.eye[i] = -(view[i * 4] * tx + view[i * 4 + 1] * ty + view[i * 4 + 2] * tz)
    }
    const dx = u.eye[0] - fin(center[0], 0)
    const dy = u.eye[1] - fin(center[1], 0)
    const dz = u.eye[2] - fin(center[2], 0)
    const camDist = Math.min(Math.max(fin(Math.sqrt(dx * dx + dy * dy + dz * dz), 4), 0.1), 100)
    const ns = Math.min(Math.max(fin(noiseScale, 1.6), 0.01), 20)
    for (let i = 0; i < 3; i++) {
      const eyeCells = i < 2 ? u.eye[i] * ns : 0
      u.noiseOrigin[i] = wrap(eyeCells + fin(noiseOffset && noiseOffset[i], 0))
    }
    u.well[0] = Math.min(Math.max(fin(wellDepth, 0), 0), 5)
    u.well[1] = Math.min(Math.max(fin(wellRadius, 1.35), 0.05), 5)
    for (let i = 0; i < 3; i++) u.occluder[i] = fin(center[i], 0)
    u.occluder[3] = Math.min(Math.max(fin(occluderRadius, 0), 0), 5)
    // past the fabric (it spans about camDist +- 1.4), toward the outer
    // history rings
    u.farFade[0] = camDist * 1.3
    u.farFade[1] = camDist * 2.2
    u.glowUv[0] = Math.min(Math.max(fin(glowUv && glowUv[0], 0.5), -1), 2)
    u.glowUv[1] = Math.min(Math.max(fin(glowUv && glowUv[1], 0.5), -1), 2)

    fogPass({
      camFwd: u.camFwd,
      camRight: u.camRight,
      camUp: u.camUp,
      eye: u.eye,
      floorZ: fin(floorZ, 0),
      sigma: Math.min(Math.max(fin(density, 0), 0), 20),
      heightScale: Math.min(Math.max(fin(heightScale, 0.35), 0.01), 10),
      startDist: camDist * Math.min(Math.max(fin(start, 0.7), 0), 2),
      // far enough to cross the fabric and the history rings past it
      maxDist: camDist * 3,
      maxFog: Math.min(Math.max(fin(maxFog, 0.55), 0), 0.95),
      noiseAmount: Math.min(Math.max(fin(noise, 0), 0), 1),
      noiseScale: ns,
      noiseOrigin: u.noiseOrigin,
      well: u.well,
      occluder: u.occluder,
      farFade: u.farFade,
      octaves: Math.max(1, Math.min(maxOctaves, Math.round(fin(octaves, 1)))),
      baseColor,
      lightColor,
      lightDir,
      glowUv: u.glowUv,
      glowAmount: Math.min(Math.max(fin(glowAmount, 0), 0), 2),
      aspect
    })
    compositePass({ scene })
    return outFbo
  }

  // the fog is off (slider, governor): give the memory back; the next
  // render() grows the buffers again
  function release () {
    if (fogFbo.width !== 1 || fogFbo.height !== 1) fogFbo.resize(1, 1)
    if (outFbo.width !== 1 || outFbo.height !== 1) outFbo.resize(1, 1)
  }

  function destroy () {
    for (const f of [fogFbo, outFbo]) {
      const tex = f.color[0]
      f.destroy()
      tex.destroy()
    }
    position.destroy()
  }

  return { render, release, destroy }
}
