// Mip-chain bloom (Jimenez, "Next Generation Post Processing in Call of
// Duty: Advanced Warfare"): a soft-knee luminance threshold, a 13-tap
// downsample chain and a 9-tap tent upsample that adds each level onto the
// next finer one.
//
// The scene buffer holds display-referred values (what the grid shader
// writes); the bloom works on their linearised version (pow 2.2) so the glow
// adds light rather than paint. With HDR buffers (half float / float) the
// chain stores linear values directly. On the uint8 fallback it stores
// sqrt(linear), which keeps the darks from banding.

export const FRAG_PRECISION = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`

export const FULLSCREEN_VERT = `
precision highp float;
attribute vec2 position;
varying vec2 uv;
void main() {
  uv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0, 1);
}
`

export const BLOOM_CODEC = `
vec3 bloomDecode(vec4 s) {
#ifdef BLOOM_ENCODED
  return s.rgb * s.rgb;
#else
  return s.rgb;
#endif
}
vec4 bloomEncode(vec3 c) {
#ifdef BLOOM_ENCODED
  return vec4(sqrt(clamp(c, 0.0, 1.0)), 1.0);
#else
  return vec4(max(c, vec3(0.0)), 1.0);
#endif
}
`

export default function createRenderBloom (regl, { type = 'uint8', hdr = false, levels = 5 } = {}) {
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

  // down[i] is 1/2^(i+1) of the source size; up[i] matches down[i]
  // (level 1 = quarter res; level 0 when the chain is too short)
  const haloLevel = Math.max(0, Math.min(1, levels - 2))
  const down = []
  const up = []
  for (let i = 0; i < levels; i++) {
    down.push(makeFbo())
    if (i < levels - 1) up.push(makeFbo())
  }

  const downsampleFrag = (prefilter) => `
    ${prefilter ? '#define PREFILTER' : ''}
    ${defines}
    ${FRAG_PRECISION}
    varying vec2 uv;
    uniform sampler2D src;
    uniform vec2 texel; // source texel size
    uniform float threshold;
    uniform float knee;
    ${BLOOM_CODEC}

    vec3 S(vec2 p) {
    #ifdef PREFILTER
      return pow(max(texture2D(src, p).rgb, vec3(1e-6)), vec3(2.2));
    #else
      return bloomDecode(texture2D(src, p));
    #endif
    }

    void main() {
      vec3 a = S(uv + texel * vec2(-2.0, 2.0));
      vec3 b = S(uv + texel * vec2(0.0, 2.0));
      vec3 c = S(uv + texel * vec2(2.0, 2.0));
      vec3 d = S(uv + texel * vec2(-2.0, 0.0));
      vec3 e = S(uv);
      vec3 f = S(uv + texel * vec2(2.0, 0.0));
      vec3 g = S(uv + texel * vec2(-2.0, -2.0));
      vec3 h = S(uv + texel * vec2(0.0, -2.0));
      vec3 i = S(uv + texel * vec2(2.0, -2.0));
      vec3 j = S(uv + texel * vec2(-1.0, 1.0));
      vec3 k = S(uv + texel * vec2(1.0, 1.0));
      vec3 l = S(uv + texel * vec2(-1.0, -1.0));
      vec3 m = S(uv + texel * vec2(1.0, -1.0));

      vec3 col = e * 0.125;
      col += (a + c + g + i) * 0.03125;
      col += (b + d + f + h) * 0.0625;
      col += (j + k + l + m) * 0.125;

    #ifdef PREFILTER
      // soft-knee threshold on luminance
      float br = dot(col, vec3(0.2126, 0.7152, 0.0722));
      float kn = max(knee, 1e-4);
      float rq = clamp(br - threshold + kn, 0.0, 2.0 * kn);
      rq = rq * rq / (4.0 * kn);
      col *= max(rq, br - threshold) / max(br, 1e-4);
    #endif

      gl_FragColor = bloomEncode(col);
    }
  `

  const downCommand = (prefilter) =>
    regl({
      vert: FULLSCREEN_VERT,
      frag: downsampleFrag(prefilter),
      attributes: { position },
      uniforms: {
        src: regl.prop('src'),
        texel: regl.prop('texel'),
        threshold: regl.prop('threshold'),
        knee: regl.prop('knee')
      },
      count: 3,
      depth: { enable: false },
      blend: { enable: false },
      framebuffer: regl.prop('fbo')
    })

  const prefilterPass = downCommand(true)
  const downPass = downCommand(false)

  const upPass = regl({
    vert: FULLSCREEN_VERT,
    frag: `
      ${defines}
      ${FRAG_PRECISION}
      varying vec2 uv;
      uniform sampler2D low; // coarser level (already upsampled)
      uniform sampler2D cur; // this level of the downsample chain
      uniform vec2 texel; // coarser level texel size
      uniform float scatter;
      ${BLOOM_CODEC}

      vec3 L(vec2 p) { return bloomDecode(texture2D(low, p)); }

      void main() {
        // 9-tap tent filter
        vec3 t = L(uv) * 4.0;
        t += (L(uv + vec2(texel.x, 0.0)) + L(uv - vec2(texel.x, 0.0)) +
              L(uv + vec2(0.0, texel.y)) + L(uv - vec2(0.0, texel.y))) * 2.0;
        t += L(uv + texel) + L(uv - texel) +
             L(uv + vec2(texel.x, -texel.y)) + L(uv + vec2(-texel.x, texel.y));
        t *= 1.0 / 16.0;
        gl_FragColor = bloomEncode(bloomDecode(texture2D(cur, uv)) + t * scatter);
      }
    `,
    attributes: { position },
    uniforms: {
      low: regl.prop('low'),
      cur: regl.prop('cur'),
      texel: regl.prop('texel'),
      scatter: regl.prop('scatter')
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
    for (let i = 0; i < levels; i++) {
      const mw = Math.max(1, w >> (i + 1))
      const mh = Math.max(1, h >> (i + 1))
      down[i].resize(mw, mh)
      if (up[i]) up[i].resize(mw, mh)
    }
  }

  // returns { texture, norm }: norm is the sum of the level weights, divide
  // the bloom intensity by it to keep the brightness independent of scatter
  function render ({ source, width, height, threshold, knee, scatter }) {
    resize(Math.max(1, width | 0), Math.max(1, height | 0))
    const kneeAbs = Math.max(threshold * knee, 1e-4)

    prefilterPass({
      fbo: down[0],
      src: source,
      texel: [1 / curW, 1 / curH],
      threshold,
      knee: kneeAbs
    })
    for (let i = 1; i < levels; i++) {
      downPass({
        fbo: down[i],
        src: down[i - 1],
        texel: [1 / down[i - 1].width, 1 / down[i - 1].height],
        threshold,
        knee: kneeAbs
      })
    }
    let low = down[levels - 1]
    for (let i = levels - 2; i >= 0; i--) {
      upPass({
        fbo: up[i],
        low,
        cur: down[i],
        texel: [1 / low.width, 1 / low.height],
        scatter
      })
      low = up[i]
    }

    let norm = 0
    for (let i = 0; i < levels; i++) norm += Math.pow(scatter, i)
    // halo: a coarser level of the upsample chain (up[haloLevel] holds the
    // levels haloLevel..levels-1), for wide effects such as the halation;
    // haloNorm is its own weight sum. bright: the first, prefiltered (soft
    // thresholded) half-res level, linear, for the anamorphic flares.
    let haloNorm = 0
    for (let i = 0; i < levels - haloLevel; i++) haloNorm += Math.pow(scatter, i)
    return {
      texture: low,
      norm: Math.max(norm, 1e-4),
      halo: up[haloLevel] || low,
      haloNorm: Math.max(haloNorm, 1e-4),
      bright: down[0]
    }
  }

  function destroy () {
    for (const f of down.concat(up)) {
      const tex = f.color[0]
      f.destroy()
      tex.destroy()
    }
    position.destroy()
  }

  return { render, resize, destroy, levels }
}
