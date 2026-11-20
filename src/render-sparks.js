import { paletteGLSL } from './palette'

// Peak sparks: on kicks, short-lived sparks fly off the highest points of
// the fabric, arc up under gravity and fall back, fading out; with the
// mirror floor on they vanish where they reach it.
//
// A fixed pool (ring) of particles. Emitting writes the spawn data
// (position + spawn time, velocity + random seed) of the next slots of the
// ring into CPU arrays, uploaded once per frame when something changed.
// The motion is closed-form in the vertex shader from the age (stime -
// spawn time): ballistic height, horizontal velocity with an exponential
// drag. Each spark is drawn as a short streak (head now, tail a few tens of
// ms ago): a screen-space quad with round caps and analytic AA, the same
// technique as the grid ribbons, so a slow spark is a soft dot and a fast
// one a short line. Additive into the HDR scene, with a hard cap on the
// brightness (never unbounded values in an HDR target).

const VERTS = 4

export default function createRenderSparks (regl, { count = 512, seed = 7 } = {}) {
  const N = Math.max(1, count | 0)

  let a = (seed * 2654435761) >>> 0
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const DEAD = -1e4
  const corner = new Float32Array(N * VERTS * 2)
  const spawnA = new Float32Array(N * VERTS * 4) // x, y, z, spawn time
  const spawnB = new Float32Array(N * VERTS * 4) // vx, vy, vz, seed
  for (let i = 0; i < N; i++) {
    for (let v = 0; v < VERTS; v++) {
      const c = (i * VERTS + v) * 2
      corner[c] = v & 1 ? 1 : -1 // side
      corner[c + 1] = v < 2 ? 0 : 1 // 0 tail, 1 head
      spawnA[(i * VERTS + v) * 4 + 3] = DEAD
    }
  }
  const indices = new Uint16Array(N * 6)
  for (let i = 0; i < N; i++) {
    const b = i * VERTS
    indices.set([b, b + 1, b + 2, b + 1, b + 3, b + 2], i * 6)
  }
  const cornerBuffer = regl.buffer(corner)
  const bufA = regl.buffer({ usage: 'dynamic', type: 'float', data: spawnA })
  const bufB = regl.buffer({ usage: 'dynamic', type: 'float', data: spawnB })
  const elements = regl.elements({ data: indices, primitive: 'triangles', type: 'uint16' })

  const draw = regl({
    vert: `
      precision highp float;
      attribute vec2 corner; // side (-1 / +1), end (0 tail, 1 head)
      attribute vec4 spawnA;
      attribute vec4 spawnB;
      uniform mat4 projection;
      uniform mat4 view;
      uniform float stime;
      uniform float gravity;
      uniform float drag;
      uniform float life;
      uniform float streak; // s between tail and head
      uniform float floorZ;
      uniform float floorSoft;
      uniform float width; // device px at the depth of the grid centre
      uniform float brightness;
      uniform float maxBright;
      uniform vec2 halfResolution;
      ${paletteGLSL}

      varying vec4 color;
      // x: signed px across, y: half core, z: px along from the tail, w: length
      varying vec4 edge;

      const float NEAR = 0.05;
      const float AA_MARGIN = 1.0;

      vec3 at(float t) {
        float k = max(drag, 0.001);
        vec2 xy = spawnA.xy + spawnB.xy * (1.0 - exp(-k * t)) / k;
        float z = spawnA.z + spawnB.z * t - 0.5 * gravity * t * t;
        return vec3(xy, max(z, floorZ - floorSoft));
      }

      void hide() {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        color = vec4(0.0);
        edge = vec4(0.0);
      }

      void main() {
        float t = stime - spawnA.w;
        if (t < 0.0 || t > life) { hide(); return; }
        vec3 head = at(t);
        vec3 tail = at(max(t - streak, 0.0));
        // landing: gone by the time the head reaches the floor
        float zHead = spawnA.z + spawnB.z * t - 0.5 * gravity * t * t;
        float land = smoothstep(floorZ - floorSoft, floorZ + floorSoft, zHead);
        float fade = smoothstep(0.0, 0.03, t) * (1.0 - smoothstep(0.5 * life, life, t)) * land;
        if (fade <= 0.001) { hide(); return; }

        vec3 vh = (view * vec4(head, 1.0)).xyz;
        vec3 vt = (view * vec4(tail, 1.0)).xyz;
        if (vh.z > -NEAR || vt.z > -NEAR) { hide(); return; }
        vec4 ch = projection * vec4(vh, 1.0);
        vec4 ct = projection * vec4(vt, 1.0);
        vec2 sh = ch.xy / ch.w * halfResolution;
        vec2 st = ct.xy / ct.w * halfResolution;
        vec2 d = sh - st;
        float len = length(d);
        vec2 tangent = len > 1e-3 ? d / len : vec2(1.0, 0.0);
        vec2 normal = vec2(-tangent.y, tangent.x);

        float depth = -vh.z;
        float centerDepth = max(-view[3].z, NEAR);
        float w = width * clamp(centerDepth / depth, 0.4, 2.5);
        float core = max(w, 1.0);
        float halfExtent = 0.5 * core + AA_MARGIN;
        float isHead = corner.y;
        vec4 clip = isHead > 0.5 ? ch : ct;
        vec2 shift = normal * (corner.x * halfExtent) + tangent * ((isHead * 2.0 - 1.0) * halfExtent);
        clip.xy += shift / halfResolution * clip.w;
        gl_Position = clip;

        // hot white when born, cooling to the palette's bright end; a long
        // streak spreads the same light over more pixels
        float age = t / life;
        float s = spawnB.w;
        vec3 rgb = mix(palette(0.72 + 0.28 * fract(s * 7.31)), vec3(1.0), 0.45 * (1.0 - age));
        float spreadLight = clamp(core * 2.0 / (len + core * 2.0), 0.25, 1.0);
        float b = brightness * (0.6 + 0.8 * s) * fade * spreadLight * clamp(w / core, 0.0, 1.0);
        color = vec4(min(rgb * b, vec3(maxBright)), 1.0);
        edge = vec4(corner.x * halfExtent, 0.5 * core,
          isHead > 0.5 ? len + halfExtent : -halfExtent, len);
      }
    `,
    frag: `
      #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
      #else
      precision mediump float;
      #endif
      varying vec4 color;
      varying vec4 edge;
      void main() {
        float outside = max(max(-edge.z, edge.z - edge.w), 0.0);
        float dist = length(vec2(edge.x, outside));
        float coverage = clamp(edge.y + 0.5 - dist, 0.0, 1.0);
        // dimmer toward the tail
        float g = clamp(edge.z / max(edge.w, 0.001), 0.0, 1.0);
        gl_FragColor = vec4(color.rgb * coverage * mix(0.2, 1.0, g), 0.0);
      }
    `,
    attributes: {
      corner: { buffer: cornerBuffer, size: 2 },
      spawnA: { buffer: bufA, size: 4 },
      spawnB: { buffer: bufB, size: 4 }
    },
    uniforms: {
      stime: regl.prop('stime'),
      gravity: regl.prop('gravity'),
      drag: regl.prop('drag'),
      life: regl.prop('life'),
      streak: regl.prop('streak'),
      floorZ: regl.prop('floorZ'),
      floorSoft: regl.prop('floorSoft'),
      width: regl.prop('width'),
      brightness: regl.prop('brightness'),
      maxBright: regl.prop('maxBright'),
      paletteA: regl.prop('paletteA'),
      paletteB: regl.prop('paletteB'),
      paletteC: regl.prop('paletteC'),
      paletteD: regl.prop('paletteD'),
      paletteShift: regl.prop('paletteShift'),
      halfResolution: ({ viewportWidth, viewportHeight }) =>
        [Math.max(1, viewportWidth) * 0.5, Math.max(1, viewportHeight) * 0.5]
    },
    blend: {
      enable: true,
      func: { srcRGB: 'one', dstRGB: 'one', srcAlpha: 'zero', dstAlpha: 'one' },
      equation: { rgb: 'add', alpha: 'add' }
    },
    depth: { enable: false },
    elements,
    count: N * 6
  })

  let stime = 0
  let next = 0 // next slot of the ring
  let dirty = false
  let lastSpawn = DEAD // stime of the latest emission (to skip idle draws)
  const REBASE = 4000 // s: keep the times small for fp32

  const fin = (x, d) => (typeof x === 'number' && isFinite(x) ? x : d)

  function setSlot (i, x, y, z, t0, vx, vy, vz, s) {
    for (let v = 0; v < VERTS; v++) {
      const o = (i * VERTS + v) * 4
      spawnA[o] = x
      spawnA[o + 1] = y
      spawnA[o + 2] = z
      spawnA[o + 3] = t0
      spawnB[o] = vx
      spawnB[o + 1] = vy
      spawnB[o + 2] = vz
      spawnB[o + 3] = s
    }
  }

  // sources: array of [x, y, z] (world), count: sparks to emit, o: speed
  // (scale of the launch velocities), spread (horizontal speed), lift (extra
  // vertical speed factor, e.g. on drops)
  function emit (sources, n, o = {}) {
    if (!sources || !sources.length) return
    n = Math.min(N, Math.max(0, Math.floor(fin(n, 0))))
    if (n < 1) return
    const speed = Math.max(0, fin(o.speed, 1))
    const spread = Math.max(0, fin(o.spread, 0.35))
    const lift = Math.max(0, fin(o.lift, 1))
    for (let k = 0; k < n; k++) {
      const src = sources[Math.floor(rand() * sources.length) % sources.length]
      const x = fin(src[0], 0) + (rand() - 0.5) * 0.03
      const y = fin(src[1], 0) + (rand() - 0.5) * 0.03
      const z = Math.min(Math.max(fin(src[2], 0), -1), 2)
      const ang = rand() * Math.PI * 2
      const h = spread * speed * (0.2 + 0.8 * rand())
      const vz = speed * lift * (0.55 + 0.85 * rand())
      // spread over the frame: a burst, not one clump at t = 0
      setSlot(next, x, y, z, stime - rand() * 0.016, Math.cos(ang) * h, Math.sin(ang) * h, vz, rand())
      next = (next + 1) % N
    }
    lastSpawn = stime
    dirty = true
  }

  // advance time (call once per frame, before emit/draw)
  function update (dt) {
    dt = Math.min(Math.max(fin(dt, 0), 0), 0.25)
    stime += dt
    if (stime > REBASE) {
      stime -= REBASE
      lastSpawn -= REBASE
      for (let i = 3; i < spawnA.length; i += 4) spawnA[i] -= REBASE
      dirty = true
    }
  }

  const props = {}
  // p: palette, amount (brightness), gravity, drag, life (s), streak (s),
  // floorZ, floorSoft, width (device px), maxBright, force
  function render (p) {
    if (dirty) {
      bufA.subdata(spawnA)
      bufB.subdata(spawnB)
      dirty = false
    }
    const life = Math.min(Math.max(fin(p.life, 1.4), 0.1), 6)
    const amount = Math.max(0, fin(p.amount, 1))
    // nothing alive (or nothing visible): skip the draw call
    // (force: draw anyway, e.g. once at warm-up so the shader compiles)
    if (!p.force && (amount <= 1e-4 || stime - lastSpawn > life + 0.1)) return
    const pal = p.palette
    props.stime = stime
    props.gravity = Math.max(0, fin(p.gravity, 3))
    props.drag = Math.max(0, fin(p.drag, 1.2))
    props.life = life
    props.streak = Math.min(Math.max(fin(p.streak, 0.05), 0), 0.5)
    props.floorZ = fin(p.floorZ, -0.25)
    props.floorSoft = Math.max(0.005, fin(p.floorSoft, 0.05))
    props.width = Math.max(0.25, fin(p.width, 1.6))
    props.brightness = Math.min(amount * 2, 20)
    props.maxBright = Math.min(Math.max(fin(p.maxBright, 4), 0), 16)
    props.paletteA = pal.paletteA
    props.paletteB = pal.paletteB
    props.paletteC = pal.paletteC
    props.paletteD = pal.paletteD
    props.paletteShift = pal.paletteShift
    draw(props)
  }

  function destroy () {
    const free = (res) => { try { if (res) res.destroy() } catch (e) {} }
    free(cornerBuffer)
    free(bufA)
    free(bufB)
    free(elements)
  }

  return { update, emit, render, destroy, count: N }
}
