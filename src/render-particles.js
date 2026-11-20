// Dust: a few hundred / thousand point sprites floating slowly in a volume
// around the grid, added onto the HDR scene.
//
// Each particle only carries static random seeds; its motion (a slow rise
// that wraps around the volume, plus a lazy wander) is computed in the
// vertex shader from a time uniform, so the CPU cost per frame is a handful
// of uniforms. Sizes are attenuated with distance and clamped to the GPU's
// ALIASED_POINT_SIZE_RANGE; points that would be smaller than ~1.5 px keep
// that size and fade instead (no sub-pixel flicker under the TAA jitter).
// Brightness follows the treble, and a random subset of the particles
// sparkles on every beat, and a smaller one twinkles on every hi-hat.
import { paletteGLSL } from './palette'

export default function createRenderParticles (regl, { count = 1500, seed = 1 } = {}) {
  const n = Math.max(1, count | 0)

  // deterministic seeds (mulberry32), stable across reloads
  let a = (seed * 2654435761) >>> 0
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const seedA = new Float32Array(n * 4) // base position in 0..1 (xyz), phase
  const seedB = new Float32Array(n * 4) // speed, size, colour, sparkle key
  for (let i = 0; i < n; i++) {
    seedA[i * 4] = rand()
    seedA[i * 4 + 1] = rand()
    seedA[i * 4 + 2] = rand()
    seedA[i * 4 + 3] = rand()
    seedB[i * 4] = rand()
    seedB[i * 4 + 1] = rand()
    seedB[i * 4 + 2] = rand()
    seedB[i * 4 + 3] = rand()
  }
  const bufA = regl.buffer(seedA)
  const bufB = regl.buffer(seedB)

  const range = regl.limits.pointSizeDims || [1, 64]
  const maxPointSize = Math.max(1, Math.min(range[1] || 64, 64))

  const draw = regl({
    vert: `
      precision highp float;
      attribute vec4 seedA;
      attribute vec4 seedB;
      uniform mat4 projection;
      uniform mat4 view;
      uniform float ptime; // seconds, scaled by the speed setting
      uniform vec3 volumeMin;
      uniform vec3 volumeSize;
      uniform float size; // px at the depth of the grid centre
      uniform float maxSize;
      uniform float brightness;
      uniform float sparkle; // 0..1 envelope, jumps on beats
      uniform float sparkleKey; // changes every beat
      uniform float sparkleShare; // fraction of particles that sparkle
      uniform float hat; // 0..1 envelope x amount, jumps on hi-hats
      uniform float hatKey; // changes every hat
      uniform float hatShare;
      uniform float pixelScale;
      ${paletteGLSL}
      varying vec4 color;

      const float TAU = 6.28318530718;
      const float MIN_SIZE = 1.5;

      void main() {
        float phase = seedA.w * TAU;
        float speed = 0.5 + seedB.x;
        // slow rise, wrapping around the volume height
        float rise = fract(seedA.z + ptime * 0.012 * speed);
        vec3 p = volumeMin + volumeSize * vec3(seedA.xy, rise);
        // lazy wander (a few cm), different per particle
        p.x += 0.06 * sin(ptime * 0.21 * speed + phase);
        p.y += 0.06 * cos(ptime * 0.17 * speed + phase * 1.7);
        p.z += 0.03 * sin(ptime * 0.31 * speed + phase * 2.3);

        vec4 v = view * vec4(p, 1.0);
        float depth = -v.z;
        if (depth < 0.05) {
          // behind (or touching) the camera: outside the clip volume
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          gl_PointSize = 1.0;
          color = vec4(0.0);
          return;
        }
        gl_Position = projection * v;

        float centerDepth = max(-view[3].z, 0.05);
        float s = size * pixelScale * (0.4 + 1.2 * seedB.y) * centerDepth / depth;
        // sub-MIN_SIZE points keep MIN_SIZE and fade by area instead
        float fade = clamp((s * s) / (MIN_SIZE * MIN_SIZE), 0.0, 1.0);
        gl_PointSize = clamp(s, min(MIN_SIZE, maxSize), maxSize);

        // fade in/out at the ends of the rise (no popping when wrapping),
        // and right in front of the camera (no big blobs crossing the view)
        float ends = smoothstep(0.0, 0.12, rise) * (1.0 - smoothstep(0.85, 1.0, rise));
        float near = smoothstep(0.15, 0.6, depth);
        // gentle twinkle
        float tw = 0.75 + 0.25 * sin(ptime * (1.3 + seedB.w * 2.0) + phase * 3.0);

        // a different random subset sparkles on each beat
        float pick = fract(seedB.w * 7.13 + sparkleKey * 0.618034);
        float sp = sparkle * step(1.0 - sparkleShare, pick);
        // hi-hats: a brief twinkle of another, smaller subset (a different
        // hash than the beat's, so the two do not always pick the same dust)
        float hpick = fract(seedA.w * 13.17 + seedB.y * 3.7 + hatKey * 0.754877);
        sp += hat * step(1.0 - hatShare, hpick);

        vec3 rgb = palette(0.45 + 0.5 * seedB.z);
        float a = brightness * tw * (1.0 + 4.0 * sp) * ends * near * fade;
        color = vec4(rgb * a, 1.0);
      }
    `,
    frag: `
      precision mediump float;
      varying vec4 color;
      void main() {
        // soft round falloff: bright core, gaussian-ish halo, 0 at the rim
        vec2 d = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(d, d);
        float f = max(0.0, 1.0 - r2);
        f = f * f * (0.35 + 0.65 * exp(-r2 * 6.0));
        gl_FragColor = vec4(color.rgb * f, 0.0);
      }
    `,
    attributes: {
      seedA: { buffer: bufA, size: 4 },
      seedB: { buffer: bufB, size: 4 }
    },
    uniforms: {
      ptime: regl.prop('time'),
      volumeMin: regl.prop('volumeMin'),
      volumeSize: regl.prop('volumeSize'),
      size: regl.prop('size'),
      maxSize: maxPointSize,
      brightness: regl.prop('brightness'),
      sparkle: regl.prop('sparkle'),
      sparkleKey: regl.prop('sparkleKey'),
      sparkleShare: regl.prop('sparkleShare'),
      hat: regl.prop('hat'),
      hatKey: regl.prop('hatKey'),
      hatShare: regl.prop('hatShare'),
      pixelScale: regl.prop('pixelScale'),
      paletteA: regl.prop('paletteA'),
      paletteB: regl.prop('paletteB'),
      paletteC: regl.prop('paletteC'),
      paletteD: regl.prop('paletteD'),
      paletteShift: regl.prop('paletteShift')
    },
    // additive into the scene, alpha untouched
    blend: {
      enable: true,
      func: { srcRGB: 'one', dstRGB: 'one', srcAlpha: 'zero', dstAlpha: 'one' },
      equation: { rgb: 'add', alpha: 'add' }
    },
    depth: { enable: false },
    primitive: 'points',
    count: regl.prop('count')
  })

  // state advanced on the CPU (all frame-rate independent)
  let time = 0
  let sparkle = 0
  let sparkleKey = 0
  let hat = 0
  let hatKey = 0
  const props = {
    time: 0,
    volumeMin: [-1.8, -1.8, -0.1],
    volumeSize: [3.6, 3.6, 1.5],
    size: 3,
    brightness: 0.3,
    sparkle: 0,
    sparkleKey: 0,
    sparkleShare: 0.15,
    hat: 0,
    hatKey: 0,
    hatShare: 0.08,
    pixelScale: 1,
    count: n,
    paletteA: null,
    paletteB: null,
    paletteC: null,
    paletteD: null,
    paletteShift: 0
  }

  // opts: dt, features, palette (uniforms), amount (brightness 0..),
  // trebleGain, sparkle (amount), sparkleShare, size (px), speed,
  // pixelScale, intro (0..1), share (0..1 of the particles drawn),
  // beatConfidence (bpm confidence needed for the beat sparkles, 0.3),
  // hat (twinkle amount on hi-hats, 0 = off), hatShare, hatDecay (s)
  function render (o) {
    const dt = Math.min(Math.max(o.dt || 0, 0), 0.25)
    time += dt * Math.max(0, o.speed === undefined ? 1 : o.speed)
    if (time > 1e5) time -= 1e5
    const f = o.features
    // sparkles follow the beat clock only once its tempo is trusted (it
    // free-runs at a default / stale tempo before that)
    const beatConfidence = o.beatConfidence === undefined ? 0.3 : o.beatConfidence
    if (f && f.onBeat && f.bpmConfidence >= beatConfidence) {
      sparkle = 1
      sparkleKey = (sparkleKey + 1) % 1000
    } else {
      sparkle *= Math.exp(-dt / 0.18)
    }
    // hi-hats: own short envelope (the analysis' is tuned for the grid)
    if (f && f.onHat) {
      hat = 1
      hatKey = (hatKey + 1) % 1000
    } else {
      hat *= Math.exp((-3 * dt) / Math.max(o.hatDecay || 0.15, 0.01))
    }
    const treble = f ? f.treble : 0
    const brightness =
      Math.max(0, o.amount) * (0.35 + (o.trebleGain || 0) * treble) * (o.intro === undefined ? 1 : o.intro)
    const share = Math.min(Math.max(o.share === undefined ? 1 : o.share, 0), 1)
    const drawCount = Math.floor(n * share)
    if (brightness <= 1e-4 || drawCount < 1) return
    props.time = time
    props.size = Math.max(0.1, o.size || 3)
    props.brightness = brightness
    props.sparkle = sparkle * Math.max(0, o.sparkle || 0)
    props.sparkleKey = sparkleKey
    props.hat = hat * Math.min(Math.max(o.hat || 0, 0), 4)
    props.hatKey = hatKey
    props.hatShare = Math.min(Math.max(o.hatShare === undefined ? 0.08 : o.hatShare, 0), 1)
    props.sparkleShare = Math.min(Math.max(o.sparkleShare || 0, 0), 1)
    props.pixelScale = Math.max(0.25, o.pixelScale || 1)
    props.count = drawCount
    const p = o.palette
    props.paletteA = p.paletteA
    props.paletteB = p.paletteB
    props.paletteC = p.paletteC
    props.paletteD = p.paletteD
    props.paletteShift = p.paletteShift
    draw(props)
  }

  function destroy () {
    bufA.destroy()
    bufB.destroy()
  }

  return { render, destroy, count: n, maxPointSize }
}
