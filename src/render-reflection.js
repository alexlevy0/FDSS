// Mirror floor: the grid drawn a second time, reflected below its base
// (render-grid's `mirror` uniforms), into a reduced-resolution buffer that
// is blurred (separable 9-tap gaussian, 2 passes) and added onto the scene.
// The low resolution and the blur make it read as a glossy, slightly rough
// floor instead of a second sharp grid, and keep its fill cost small.
//
// The buffers are of the scene's type (HDR when available). The grid draws
// into a cleared buffer with its usual src-alpha blending, so the buffer
// holds premultiplied colour; it is composited additively (the grid lines
// are emissive on a dark scene).
import { FRAG_PRECISION, FULLSCREEN_VERT } from './render-bloom'

export default function createRenderReflection (regl, { type = 'uint8' } = {}) {
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
  const fboA = makeFbo()
  const fboB = makeFbo()

  const intoA = regl({ framebuffer: fboA })

  // 9-tap gaussian folded into 5 bilinear fetches
  const blurFrag = `
    ${FRAG_PRECISION}
    varying vec2 uv;
    uniform sampler2D src;
    uniform vec2 dir; // texel size * radius along the blur axis
    uniform float gain;
    void main() {
      vec3 c = texture2D(src, uv).rgb * 0.2270270270;
      vec2 o1 = dir * 1.3846153846;
      vec2 o2 = dir * 3.2307692308;
      c += (texture2D(src, uv + o1).rgb + texture2D(src, uv - o1).rgb) * 0.3162162162;
      c += (texture2D(src, uv + o2).rgb + texture2D(src, uv - o2).rgb) * 0.0702702703;
      gl_FragColor = vec4(max(c, vec3(0.0)) * gain, 0.0);
    }
  `
  const blurPass = regl({
    vert: FULLSCREEN_VERT,
    frag: blurFrag,
    attributes: { position },
    uniforms: {
      src: regl.prop('src'),
      dir: regl.prop('dir'),
      gain: regl.prop('gain')
    },
    count: 3,
    depth: { enable: false },
    blend: { enable: false },
    framebuffer: regl.prop('fbo')
  })
  // second blur axis, added onto the target (the scene); alpha untouched
  const compositePass = regl({
    vert: FULLSCREEN_VERT,
    frag: blurFrag,
    attributes: { position },
    uniforms: {
      src: regl.prop('src'),
      dir: regl.prop('dir'),
      gain: regl.prop('gain')
    },
    count: 3,
    depth: { enable: false },
    blend: {
      enable: true,
      func: { srcRGB: 'one', dstRGB: 'one', srcAlpha: 'zero', dstAlpha: 'one' },
      equation: { rgb: 'add', alpha: 'add' }
    },
    framebuffer: regl.prop('fbo')
  })

  let curW = 0
  let curH = 0
  function resize (w, h) {
    if (w === curW && h === curH) return
    curW = w
    curH = h
    fboA.resize(w, h)
    fboB.resize(w, h)
  }

  // draw(): called inside the reduced-resolution framebuffer scope, draws
  // the mirrored grid (the caller wraps it with its camera uniforms).
  // target: framebuffer to add the result onto. blur: radius in texels of
  // the reduced buffer. intensity: gain of the composite.
  function render ({ width, height, scale = 0.5, blur = 1, intensity = 1, draw, target }) {
    const s = Math.min(Math.max(scale, 0.125), 1)
    resize(Math.max(1, Math.round(width * s)), Math.max(1, Math.round(height * s)))
    intoA(() => {
      regl.clear({ color: [0, 0, 0, 0] })
      draw()
    })
    const r = Math.max(0, blur)
    blurPass({ fbo: fboB, src: fboA, dir: [r / curW, 0], gain: 1 })
    compositePass({ fbo: target, src: fboB, dir: [0, r / curH], gain: Math.max(0, intensity) })
  }

  function destroy () {
    for (const f of [fboA, fboB]) {
      const tex = f.color[0]
      f.destroy()
      tex.destroy()
    }
    position.destroy()
  }

  return { render, destroy }
}
