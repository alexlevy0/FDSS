import { createSpring } from 'spring-animator'
import { paletteGLSL } from './palette'

// The grid is 2 * (gridLines - 1) lines, alternating x / y axis, drawn as
// screen-space ribbons: every segment is a quad (4 vertices, 2 triangles
// through an index buffer) expanded in the vertex shader perpendicular to
// the projected line, with a width in pixels and analytic anti-aliasing in
// the fragment shader (distance to the centre line -> coverage -> alpha).
// The geometry is static on the GPU: each vertex only carries (line index,
// t, side, which end of its segment it is). The only thing that moves is one
// spring offset per line, simulated on the CPU (a few hundred springs) and
// uploaded once per frame:
//  - as a 1-row texture when the GPU can sample 2 textures in the vertex
//    shader (frequencyVals + offsets). Float texture if OES_texture_float is
//    enabled, otherwise the value is packed in 16 bits (R = high byte,
//    G = low byte) and decoded in the shader;
//  - otherwise as a per-vertex attribute (dynamic buffer) as a fallback.
//
// Vertices are not shared between segments: each quad knows the other end
// of its own segment, so a segment crossing the camera's near plane can be
// clipped in view space (the end behind slides onto the near plane) and a
// segment fully behind collapses to nothing, instead of projecting through
// w <= 0. The ribbon normal still comes from the central difference at each
// sample, identical for the two quads that meet there, so joints have no
// gaps or overlaps.
//
// WebGL1 only guarantees 16-bit indices: the lines are drawn in chunks of
// at most 65536 vertices, all sharing one index buffer (relative indices)
// and pointing their attributes at the chunk's first vertex.

const DEFAULT_SEGMENTS = 100 // segments per line
const OFFSET_RANGE = 4.0 // packed offsets cover -4..4 (springs stay in -2..2)
const VERTS_PER_SEGMENT = 4

let previous = null // GPU resources of the previous instance (setup on resize)

// Alternate forms of the grid. Every vertex position is a blend of the four
// forms with the formWeights uniform (summing to 1), computed in the vertex
// shader from the same static geometry:
//   grid     the orthogonal lines (line offset = x or y, t along the line)
//   circles  concentric rings (offset -> radius, t -> angle); the y-axis
//            lines sit half a ring between the x-axis ones
//   radial   spokes from the centre (offset -> angle, t -> radius)
//   points   every segment shrinks to a round dot at a fixed pseudo-random
//            spot of the disc (the lines break into dashes, then fly apart)
// The state lives at module level so a rebuild (gridLines / segments) keeps
// the current form.
export const GRID_FORMS = ['grid', 'circles', 'radial', 'points']
const formState = {
  weights: [1, 0, 0, 0],
  from: [1, 0, 0, 0],
  target: 0,
  t: 1,
  duration: 5
}

function setForm (name, duration = 5) {
  const index = GRID_FORMS.indexOf(name)
  if (index < 0) return
  if (index === formState.target) return
  for (let i = 0; i < 4; i++) formState.from[i] = formState.weights[i]
  formState.target = index
  formState.duration = Math.max(0, duration)
  formState.t = formState.duration > 0 ? 0 : 1
  if (formState.t >= 1) stepForm(0)
}

function stepForm (dt) {
  if (formState.t >= 1 && formState.weights[formState.target] === 1) return
  formState.t = Math.min(1, formState.t + dt / Math.max(formState.duration, 1e-3))
  const x = formState.t
  const s = x * x * x * (x * (x * 6 - 15) + 10) // smootherstep
  for (let i = 0; i < 4; i++) {
    const to = i === formState.target ? 1 : 0
    formState.weights[i] = formState.from[i] + (to - formState.from[i]) * s
  }
}

export default function createRenderGrid (regl, settings, opts = {}) {
  if (previous) previous.destroy()

  const SEGMENTS = Math.max(8, Math.min(200, (opts.segments || DEFAULT_SEGMENTS) | 0))

  const lines = []
  for (let j = 1; j < settings.gridLines; j++) {
    lines.push({
      axis: 'x',
      offset: createSpring(settings.linesDampening, settings.linesStiffness, j / settings.gridLines * 2 - 1)
    })
    lines.push({
      axis: 'y',
      offset: createSpring(settings.linesDampening, settings.linesStiffness, j / settings.gridLines * 2 - 1)
    })
  }
  const lineCount = lines.length

  // static geometry: 4 vertices per segment, (line, t, side, end)
  //   side: -1 / +1, which edge of the ribbon
  //   end: +1 for the segment's first sample (partner at t + step),
  //        -1 for its second sample (partner at t - step)
  const vertsPerLine = SEGMENTS * VERTS_PER_SEGMENT
  const vertexCount = lineCount * vertsPerLine
  const lineT = new Float32Array(vertexCount * 4)
  let k = 0
  for (let i = 0; i < lineCount; i++) {
    for (let q = 0; q < SEGMENTS; q++) {
      const t0 = q / SEGMENTS * 2 - 1
      const t1 = (q + 1) / SEGMENTS * 2 - 1
      lineT.set([i, t0, -1, 1, i, t0, 1, 1, i, t1, -1, -1, i, t1, 1, -1], k)
      k += 16
    }
  }
  const lineTBuffer = regl.buffer(lineT)

  // one index buffer for a chunk of lines, relative to the chunk's first vertex
  const linesPerChunk = Math.max(1, Math.floor(65536 / vertsPerLine))
  const chunkLines = Math.min(linesPerChunk, lineCount)
  const indices = new Uint16Array(chunkLines * SEGMENTS * 6)
  let n = 0
  for (let s = 0; s < chunkLines * SEGMENTS; s++) {
    const b = s * VERTS_PER_SEGMENT
    indices[n++] = b
    indices[n++] = b + 1
    indices[n++] = b + 2
    indices[n++] = b + 1
    indices[n++] = b + 3
    indices[n++] = b + 2
  }
  const elements = regl.elements({ data: indices, primitive: 'triangles', type: 'uint16' })
  const chunks = []
  for (let first = 0; first < lineCount; first += linesPerChunk) {
    const count = Math.min(linesPerChunk, lineCount - first)
    chunks.push({ vertex: first * vertsPerLine, count: count * SEGMENTS * 6 })
  }

  const limits = regl.limits
  const useTexture = limits.maxVertexTextureUnits >= 2 && lineCount <= limits.maxTextureSize
  const useFloat = useTexture && regl.hasExtension('oes_texture_float')

  let offsetsData, offsetsTexture, offsetsAttr, offsetsBuffer
  if (useTexture) {
    offsetsData = useFloat ? new Float32Array(lineCount * 4) : new Uint8Array(lineCount * 4)
    offsetsTexture = regl.texture(offsetsTextureOptions())
  } else {
    offsetsAttr = new Float32Array(vertexCount)
    offsetsBuffer = regl.buffer({ usage: 'dynamic', type: 'float', data: offsetsAttr })
  }

  function offsetsTextureOptions () {
    return {
      width: lineCount,
      height: 1,
      data: offsetsData,
      format: 'rgba',
      type: useFloat ? 'float' : 'uint8',
      min: 'nearest',
      mag: 'nearest',
      wrap: 'clamp',
      mipmap: false
    }
  }

  const defines = [
    useTexture ? '#define OFFSETS_TEXTURE' : '',
    useFloat ? '#define OFFSETS_FLOAT' : '',
    `#define OFFSET_RANGE ${OFFSET_RANGE.toFixed(1)}`,
    `#define SEG_STEP ${(2 / SEGMENTS).toFixed(8)}`,
    // rotation of one segment along a ring of the circles form
    `#define SEG_COS ${Math.cos(Math.PI * 2 / SEGMENTS).toFixed(8)}`,
    `#define SEG_SIN ${Math.sin(Math.PI * 2 / SEGMENTS).toFixed(8)}`
  ].join('\n')

  // attributes point at the current chunk's first vertex
  const attributes = {
    lineT: (ctx, props) => ({ buffer: lineTBuffer, offset: props.vertex * 16, size: 4 })
  }
  const uniforms = {
    frequencyVals: regl.prop('frequencyVals'),
    gridMaxHeight: regl.prop('gridMaxHeight'),
    multiplier: regl.prop('multiplier'),
    fogAmount: regl.prop('fogAmount'),
    fogStart: regl.prop('fogStart'),
    fogEnd: regl.prop('fogEnd'),
    fogDim: regl.prop('fogDim'),
    paletteA: regl.prop('paletteA'),
    paletteB: regl.prop('paletteB'),
    paletteC: regl.prop('paletteC'),
    paletteD: regl.prop('paletteD'),
    paletteShift: regl.prop('paletteShift'),
    // ribbon width, in device pixels
    widthMin: regl.prop('widthMin'),
    widthPeak: regl.prop('widthPeak'),
    widthDepth: regl.prop('widthDepth'),
    peakGain: regl.prop('peakGain'),
    // mirror floor (reflection pass): mirror = 0 draws the grid itself
    mirror: (ctx, props) => props.mirror ? 1 : 0,
    mirrorPlane: (ctx, props) => props.mirrorPlane || 0,
    mirrorFade: (ctx, props) => props.mirrorFade || 0,
    mirrorAmount: (ctx, props) => (props.mirrorAmount === undefined ? 1 : props.mirrorAmount),
    // colour by height: valleys low on the palette ramp and cooler, peaks
    // high and warmer
    heightColor: (ctx, props) => props.heightColor || 0,
    heightRef: (ctx, props) => Math.max(1e-4, props.heightRef || 0.28),
    heightTint: (ctx, props) => props.heightTint || 0,
    sectionTemp: (ctx, props) => props.sectionTemp || 0,
    // forms
    formWeights: () => formState.weights,
    lineSpacing: 1 / Math.max(2, settings.gridLines),
    dotSize: (ctx, props) => (props.dotSize === undefined ? 2.5 : props.dotSize),
    halfResolution: ({ viewportWidth, viewportHeight }) =>
      [Math.max(1, viewportWidth) * 0.5, Math.max(1, viewportHeight) * 0.5]
  }
  if (useTexture) {
    uniforms.offsets = offsetsTexture
    uniforms.lineCount = lineCount
  } else {
    attributes.offset = (ctx, props) => ({ buffer: offsetsBuffer, offset: props.vertex * 4, size: 1 })
  }

  const render = regl({
    vert: `
      precision highp float;
      ${defines}

      // x: line index (even = x axis, odd = y axis), y: t in -1..1,
      // z: side (-1 / +1), w: direction of the segment's other end (+1 / -1)
      attribute vec4 lineT;
      #ifdef OFFSETS_TEXTURE
      uniform sampler2D offsets;
      uniform float lineCount;
      #else
      attribute float offset;
      #endif

      uniform sampler2D frequencyVals;
      uniform mat4 projection;
      uniform mat4 view;
      uniform float gridMaxHeight;
      uniform float multiplier;
      uniform float fogAmount;
      uniform float fogStart;
      uniform float fogEnd;
      uniform float fogDim;
      uniform float widthMin;
      uniform float widthPeak;
      uniform float widthDepth;
      uniform float peakGain;
      uniform float mirror; // 1: reflected below z = mirrorPlane
      uniform float mirrorPlane;
      uniform float mirrorFade;
      uniform float mirrorAmount;
      uniform vec2 halfResolution;
      uniform float heightColor;
      uniform float heightRef;
      uniform float heightTint;
      uniform float sectionTemp;
      uniform vec4 formWeights; // grid, circles, radial, points
      uniform float lineSpacing; // 1 / gridLines
      uniform float dotSize; // px, points form
      ${paletteGLSL}

      varying vec4 fragColor;
      // x: signed distance to the centre line (px), y: half core width (px),
      // z: position along the segment (px from its first end, negative or
      // beyond w on the round caps), w: segment length (px)
      varying vec4 edge;

      // view-space depth (-z) in front of which geometry is kept
      const float NEAR = 0.02;
      const float AA_MARGIN = 1.0; // px of geometry beyond the core, for the AA ramp
      const float PI = 3.14159265359;
      const float TAU = 6.28318530718;

      // hash without sine (stable in fp32 on every GPU)
      vec2 hash22(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.xx + p3.yz) * p3.zy);
      }

      // base-plane positions (-1..1) of the samples t - step (pp), t (pc)
      // and t + step (pn) of a line, clamped to its ends, blended between
      // the forms; dotPos is the point-cloud spot of the vertex's segment.
      // The three share their trigonometry: a ring's neighbours are the
      // same point rotated by one step, a spoke's lie along the same
      // direction.
      void formPoints(float off, float axisY, float t, vec2 dotPos,
                      out vec2 pp, out vec2 pc, out vec2 pn) {
        float tp = max(t - SEG_STEP, -1.0);
        float tn = min(t + SEG_STEP, 1.0);
        pp = mix(vec2(off, tp), vec2(tp, off), axisY) * formWeights.x;
        pc = mix(vec2(off, t), vec2(t, off), axisY) * formWeights.x;
        pn = mix(vec2(off, tn), vec2(tn, off), axisY) * formWeights.x;
        if (formWeights.y > 0.0) {
          // rings spread a little past the fabric's disc (0.9) to thin them
          float r = abs((off + 1.0) * 0.575 + axisY * 0.575 * lineSpacing);
          // y rings rotated a little so the closing points do not line up
          float a = (t + 1.0) * PI + axisY * 0.7;
          vec2 u = formWeights.y * r * vec2(cos(a), sin(a));
          // one step back / forward along the ring (none past the ends)
          vec2 up = t > -1.0 ? vec2(u.x * SEG_COS + u.y * SEG_SIN, u.y * SEG_COS - u.x * SEG_SIN) : u;
          vec2 un = t < 1.0 ? vec2(u.x * SEG_COS - u.y * SEG_SIN, u.y * SEG_COS + u.x * SEG_SIN) : u;
          pp += up;
          pc += u;
          pn += un;
        }
        if (formWeights.z > 0.0) {
          float a = (off + 1.0) * PI + axisY * PI * lineSpacing;
          vec2 u = formWeights.z * vec2(cos(a), sin(a));
          pp += mix(0.05, 1.0, (tp + 1.0) * 0.5) * u;
          pc += mix(0.05, 1.0, (t + 1.0) * 0.5) * u;
          pn += mix(0.05, 1.0, (tn + 1.0) * 0.5) * u;
        }
        vec2 spot = formWeights.w * dotPos;
        pp += spot;
        pc += spot;
        pn += spot;
      }

      float lineOffset() {
        #ifdef OFFSETS_TEXTURE
        vec4 s = texture2D(offsets, vec2((lineT.x + 0.5) / lineCount, 0.5));
        #ifdef OFFSETS_FLOAT
        return s.r;
        #else
        float hi = floor(s.r * 255.0 + 0.5);
        float lo = floor(s.g * 255.0 + 0.5);
        return ((hi * 256.0 + lo) / 65535.0 * 2.0 - 1.0) * OFFSET_RANGE;
        #endif
        #else
        return offset;
        #endif
      }

      // a base-plane point lifted by the frequencies, in view space; w
      // carries the frequency value (the view matrix is affine, so w would
      // be 1)
      vec4 gridPoint(vec2 p) {
        float f = texture2D(frequencyVals, (p + 1.0) * 0.5).x;
        float h = f * gridMaxHeight * multiplier;
        // reflection across the plane z = mirrorPlane (below the grid)
        float z = mix(h, 2.0 * mirrorPlane - h, mirror);
        vec4 v = view * vec4(p, z, 1.0);
        return vec4(v.xyz, f);
      }

      // a in front of the near plane, b behind: the point between them on it
      vec3 toNear(vec3 a, vec3 b) {
        float s = (-NEAR - a.z) / (b.z - a.z);
        return mix(a, b, clamp(s, 0.0, 1.0));
      }

      vec2 toScreen(vec3 v) {
        vec4 c = projection * vec4(v, 1.0);
        return c.xy / c.w * halfResolution;
      }

      void main() {
        float off = lineOffset();
        // 0 for x-axis lines (even index), 1 for y-axis lines (odd index)
        float axisY = step(0.5, lineT.x - 2.0 * floor(lineT.x * 0.5 + 0.25));
        float t = lineT.y;

        // the segment this vertex belongs to, and its point-cloud spot
        // (uniform over a disc of radius 0.95)
        float segStart = lineT.w > 0.0 ? t : t - SEG_STEP;
        float seg = floor((segStart + 1.0) / SEG_STEP + 0.5);
        vec2 h = hash22(vec2(lineT.x + 1.0, seg + 1.0));
        float da = h.y * TAU;
        vec2 dotPos = sqrt(h.x) * 0.95 * vec2(cos(da), sin(da));

        vec2 pp;
        vec2 pc;
        vec2 pn;
        formPoints(off, axisY, t, dotPos, pp, pc, pn);
        vec4 c4 = gridPoint(pc);
        vec4 p4 = c4;
        vec4 n4 = c4;
        // a pure point cloud puts all three samples on the segment's dot:
        // one frequency fetch instead of three (uniform branch)
        if (formWeights.w < 1.0) {
          p4 = gridPoint(pp);
          n4 = gridPoint(pn);
        }
        vec3 c = c4.xyz;
        vec3 prev = p4.xyz;
        vec3 next = n4.xyz;
        float frequencyVal = c4.w;
        vec3 partner = lineT.w > 0.0 ? next : prev;

        // the two samples the ribbon direction is measured between
        vec3 a;
        vec3 b;
        if (c.z > -NEAR) {
          // behind the near plane: slide onto it toward the segment's other
          // end, or collapse the whole segment (all 4 vertices to one point
          // outside the clip volume) when that end is behind too
          if (partner.z > -NEAR) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            fragColor = vec4(0.0);
            edge = vec4(0.0);
            return;
          }
          c = toNear(partner, c);
          a = lineT.w > 0.0 ? c : partner;
          b = lineT.w > 0.0 ? partner : c;
        } else {
          a = prev.z > -NEAR ? toNear(c, prev) : prev;
          b = next.z > -NEAR ? toNear(c, next) : next;
        }

        // colour by height (of the original point, also for the mirror):
        // the palette position moves from the intensity toward the height,
        // low on the ramp in the valleys and high on the peaks, and the
        // colour temperature follows (cooler valleys, warmer peaks), plus
        // the section's temperature. Same palette, so each track keeps its
        // identity.
        float hc = frequencyVal * gridMaxHeight * multiplier;
        float hn = smoothstep(0.0, 1.0, clamp(hc / heightRef, 0.0, 1.0));
        float tc = mix(frequencyVal, mix(0.12, 0.98, hn), heightColor);
        vec3 rgb = palette(tc) * 0.95;
        float temp = clamp((hn * 2.0 - 1.0) * heightTint + sectionTemp, -1.0, 1.0);
        rgb *= max(vec3(0.0), 1.0 + temp * vec3(0.16, 0.02, -0.2));
        float opacity = clamp(pow(frequencyVal * 1.5, 2.0), 0.0, 0.95) * multiplier;
        // rings put about twice the line length of the grid on the fabric's
        // disc: dimmer, so the form does not flood into a white mass
        // rings and dots pile up into a white mass: keep them dimmer than lines
        opacity *= 1.0 - 0.6 * formWeights.y;
        opacity *= 1.0 - 0.65 * formWeights.w;
        // spokes converge at the centre: thin them out there
        opacity *= 1.0 - formWeights.z * (1.0 - smoothstep(0.02, 0.4, (t + 1.0) * 0.5));

        // distance fog, relative to the depth of the grid centre so it
        // follows the roaming camera: the far side of the grid recedes
        float depth = -c.z;
        float centerDepth = max(-view[3].z, NEAR);
        float fog = fogAmount * smoothstep(centerDepth + fogStart, centerDepth + fogEnd, depth);
        rgb *= 1.0 - fogDim * fog;
        opacity *= 1.0 - fog;

        // reflection: fainter the further the original point is above the
        // mirror (peaks fade first) and a little dimmer with depth
        if (mirror > 0.5) {
          float above = max(hc - mirrorPlane, 0.0);
          opacity *= mirrorAmount * exp(-mirrorFade * above);
          opacity *= 1.0 - 0.5 * fog;
        }

        // width: thin in quiet parts, thicker (and brighter) on the peaks,
        // a little thinner in the distance for depth
        float peak = smoothstep(0.2, 1.0, frequencyVal);
        float w = mix(widthMin, widthPeak, peak);
        // dots of the point cloud: their own size, bigger on the peaks
        w = mix(w, dotSize * mix(1.0, 1.8, peak), formWeights.w);
        w *= pow(clamp(centerDepth / depth, 0.35, 3.0), widthDepth);
        rgb *= 1.0 + peakGain * peak;
        // below 1px the ribbon stays 1px wide and fades instead (same
        // amount of light, no sub-pixel shimmer)
        float core = max(w, 1.0);
        opacity *= clamp(w / core, 0.0, 1.0);

        // screen-space direction; degenerate (line seen end-on, or a dot of
        // the point cloud) -> any direction
        vec2 d = toScreen(b) - toScreen(a);
        float len = length(d);
        vec2 tangent = len > 1e-4 ? d / len : vec2(1.0, 0.0);
        vec2 normal = vec2(-tangent.y, tangent.x);

        float halfExtent = 0.5 * core + AA_MARGIN;
        // round caps, only for the point cloud (lines keep exact joints):
        // the quad also grows along the segment, first end backward
        float capExt = formWeights.w * halfExtent;
        // between the CLIPPED ends (c is already on the near plane when it
        // was behind it; then the partner is in front), so both ends of the
        // quad agree and no screen position comes from a w near 0
        vec3 partnerC = partner.z > -NEAR ? toNear(c, partner) : partner;
        float segLen = length(toScreen(partnerC) - toScreen(c));
        vec4 clip = projection * vec4(c, 1.0);
        vec2 shift = normal * (lineT.z * halfExtent) - tangent * (lineT.w * capExt);
        clip.xy += shift / halfResolution * clip.w;

        fragColor = vec4(rgb, opacity);
        edge = vec4(lineT.z * halfExtent, 0.5 * core,
          lineT.w > 0.0 ? -capExt : segLen + capExt, segLen);
        gl_Position = clip;
      }
    `,
    frag: `
      #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
      #else
      precision mediump float;
      #endif
      varying vec4 fragColor;
      varying vec4 edge;
      void main() {
        // analytic coverage of a 1px-wide pixel footprint across the core;
        // beyond the segment's ends (round caps of the dots) the distance is
        // measured to the nearest end. Lines never go beyond: same as before.
        float outside = max(max(-edge.z, edge.z - edge.w), 0.0);
        float dist = length(vec2(edge.x, outside));
        float coverage = clamp(edge.y + 0.5 - dist, 0.0, 1.0);
        gl_FragColor = vec4(fragColor.rgb, fragColor.a * coverage);
      }
    `,
    uniforms,
    blend: {
      enable: true,
      func: {
        srcRGB: 'src alpha',
        srcAlpha: 1,
        dstRGB: 'one minus src alpha',
        dstAlpha: 1
      },
      equation: {
        rgb: 'add',
        alpha: 'add'
      }
    },
    depth: { enable: false },
    attributes,
    elements,
    count: regl.prop('count')
  })

  function uploadOffsets () {
    if (useTexture) {
      for (let i = 0; i < lineCount; i++) {
        const v = lines[i].offset.tick(1, false)
        if (useFloat) {
          offsetsData[i * 4] = v
        } else {
          const n = Math.min(1, Math.max(0, (v / OFFSET_RANGE + 1) / 2))
          const packed = Math.round(n * 65535)
          offsetsData[i * 4] = packed >> 8
          offsetsData[i * 4 + 1] = packed & 255
        }
      }
      // same size and type every frame: update the existing storage
      // (texSubImage2D) instead of re-specifying the whole texture
      offsetsTexture.subimage(offsetsData)
    } else {
      let p = 0
      for (let i = 0; i < lineCount; i++) {
        const v = lines[i].offset.tick(1, false)
        for (let q = 0; q < vertsPerLine; q++) offsetsAttr[p++] = v
      }
      offsetsBuffer.subdata(offsetsAttr)
    }
  }

  // Reshuffles: on musical phrases when the tempo is trusted, else every
  // settings.reshuffleInterval seconds (the old fixed 9.5 s timer). The
  // per-line stagger (linesAnimationOffset ms per line) runs on the frame
  // clock instead of hundreds of timeouts.
  const INITIAL_DELAY = 24.5 // s before the first reshuffle, as before
  let elapsed = 0 // s since this grid was created
  let sinceReshuffle = 0
  let sweepTime = 0 // s since the last reshuffle started
  const pendingValue = new Float32Array(lineCount)
  const pendingAt = new Float32Array(lineCount).fill(-1) // sweepTime, or -1

  let calls = 0
  function setLinesOffsets () {
    let xVal = 1
    let yVal = 1
    calls += 1
    calls = calls % 2
    const randomGranularity = ((Math.random() * 10 | 0) + 1) / 5
    lines.forEach((line, i) => {
      let nextVal
      if (calls === 0) {
        nextVal = ((line.axis === 'x' ? xVal++ : yVal++) / settings.gridLines * 2 - 1) * randomGranularity
      } else if (calls === 1) {
        nextVal = Math.random() * 2 - 1
      } else {
        nextVal = (line.axis === 'x' ? xVal++ : yVal++) / settings.gridLines * 2 - 1
      }

      // lines still pending from the previous sweep get the new value
      pendingValue[i] = nextVal
      pendingAt[i] = (i * settings.linesAnimationOffset) / 1000
    })
    sweepTime = 0
    sinceReshuffle = 0
  }

  // dt: seconds; features: the analysis features (onPhrase, bpmConfidence)
  function tick (dt, features) {
    dt = Math.min(Math.max(dt || 0, 0), 0.25)
    stepForm(dt)
    elapsed += dt
    sinceReshuffle += dt
    if (elapsed >= INITIAL_DELAY) {
      const onPhrase = settings.reshuffleOnPhrase !== false && features &&
        features.bpmConfidence >= settings.reshuffleConfidence
      if (onPhrase) {
        // a minimum gap keeps short phrases (fast tempo, 16 beats) calm
        if (features.onPhrase && sinceReshuffle >= settings.reshuffleMinGap) setLinesOffsets()
        // tempo trusted but no phrase for very long (should not happen)
        else if (sinceReshuffle >= settings.reshuffleInterval * 4) setLinesOffsets()
      } else if (sinceReshuffle >= settings.reshuffleInterval) {
        setLinesOffsets()
      }
    }
    sweepTime += dt
    for (let i = 0; i < lineCount; i++) {
      if (pendingAt[i] >= 0 && sweepTime >= pendingAt[i]) {
        lines[i].offset.updateValue(pendingValue[i])
        pendingAt[i] = -1
      }
    }
  }

  previous = {
    destroy () {
      // ignore resources already freed (e.g. by regl.destroy())
      const free = (res) => { try { if (res) res.destroy() } catch (e) {} }
      free(lineTBuffer)
      free(elements)
      free(offsetsTexture)
      free(offsetsBuffer)
    }
  }

  // props: frequencyVals, gridMaxHeight, multiplier, fogAmount, fogStart,
  // fogEnd, fogDim, paletteA..D, paletteShift, widthMin, widthPeak (device
  // px), widthDepth, peakGain; optional heightColor, heightRef (world units),
  // heightTint, sectionTemp (-1 cool .. 1 warm), dotSize (device px)
  const drawProps = chunks.map(() => ({}))
  // uploads this frame's line offsets and steps the springs; renderGrid()
  // does it itself unless prepare() already ran this frame (so an extra
  // draw() before it, like the reflection, sees the same offsets)
  let prepared = false
  function prepare () {
    uploadOffsets()
    for (const line of lines) {
      line.offset.tick()
    }
    prepared = true
  }
  const NO_MIRROR = { mirror: 0, mirrorPlane: 0, mirrorFade: 0, mirrorAmount: 1 }
  function draw (props) {
    for (let c = 0; c < chunks.length; c++) {
      // the props objects are reused: reset the mirror fields first so a
      // reflection draw does not leak into the next plain draw
      const p = Object.assign(drawProps[c], NO_MIRROR, props)
      p.vertex = chunks[c].vertex
      p.count = chunks[c].count
    }
    render(drawProps)
  }
  function renderGrid (props) {
    if (!prepared) prepare()
    prepared = false
    draw(props)
  }
  renderGrid.prepare = prepare
  // morph to another form ('grid' | 'circles' | 'radial' | 'points') over
  // duration seconds (eased; a change in the middle of a morph starts from
  // whatever is on screen)
  renderGrid.setForm = setForm
  renderGrid.getForm = () => GRID_FORMS[formState.target]
  renderGrid.formWeights = formState.weights
  // draw with the current offsets, without stepping anything (mirror pass;
  // props as renderGrid plus mirror, mirrorPlane, mirrorFade, mirrorAmount)
  renderGrid.draw = draw
  // advance the reshuffle schedule (once per frame, before rendering)
  renderGrid.tick = tick
  // start a reshuffle now (resets the schedule)
  renderGrid.reshuffle = setLinesOffsets
  // how the offsets reach the GPU (for debugging)
  renderGrid.segments = SEGMENTS
  renderGrid.drawCalls = chunks.length
  renderGrid.offsetsMode = useTexture ? (useFloat ? 'texture-float' : 'texture-rgba8-packed') : 'attribute'
  return renderGrid
}

