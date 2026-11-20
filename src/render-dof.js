// Light depth of field without a depth buffer: a radial focus around the
// projected grid centre. The circle of confusion is 0 inside focusRadius
// and grows to 1 over `falloff` (distances in units of half the screen
// height, aspect-corrected); below the focus point (the foreground of the
// grid, since the camera looks down on it) the distance is stretched by
// `foreground`, so the near side blurs sooner than the far side.
//
// The blur is a small bokeh-ish disc gather: TAPS samples on a golden-angle
// spiral (uniform disc), bright samples weighted up a little so highlights
// open into soft discs. Pixels with a CoC under half a pixel are copied as
// they are (dynamic branch: the sharp centre costs one fetch).
//
// Reads and writes the scene's buffer type (HDR when available).
import { FRAG_PRECISION, FULLSCREEN_VERT } from './render-bloom'

export default function createRenderDof (regl, { type = 'uint8', taps = 16 } = {}) {
  const TAPS = Math.max(4, Math.min(32, taps | 0))
  const position = regl.buffer([-1, -1, -1, 4, 4, -1])
  const fbo = regl.framebuffer({
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

  const pass = regl({
    vert: FULLSCREEN_VERT,
    frag: `
      #define TAPS ${TAPS}
      ${FRAG_PRECISION}
      varying vec2 uv;
      uniform sampler2D scene;
      uniform vec2 texel;
      uniform vec2 focus; // uv of the focus point
      uniform float aspect;
      uniform float focusRadius;
      uniform float falloff;
      uniform float foreground;
      uniform float maxRadius; // px at CoC 1

      void main() {
        vec4 c = texture2D(scene, uv);
        vec2 d = uv - focus;
        d.x *= aspect;
        if (d.y < 0.0) d.y *= 1.0 + foreground;
        float dist = length(d) * 2.0;
        float coc = smoothstep(focusRadius, focusRadius + falloff, dist);
        float r = coc * maxRadius;
        if (r < 0.5) {
          gl_FragColor = c;
          return;
        }
        vec3 acc = c.rgb;
        float wsum = 1.0;
        for (int i = 0; i < TAPS; i++) {
          float fi = float(i) + 0.5;
          float rr = sqrt(fi / float(TAPS));
          float ang = fi * 2.39996323;
          vec2 o = vec2(cos(ang), sin(ang)) * (rr * r) * texel;
          vec3 s = texture2D(scene, uv + o).rgb;
          float w = 1.0 + min(2.0 * dot(s, vec3(0.2126, 0.7152, 0.0722)), 3.0);
          acc += s * w;
          wsum += w;
        }
        gl_FragColor = vec4(acc / wsum, c.a);
      }
    `,
    attributes: { position },
    uniforms: {
      scene: regl.prop('scene'),
      texel: regl.prop('texel'),
      focus: regl.prop('focus'),
      aspect: regl.prop('aspect'),
      focusRadius: regl.prop('focusRadius'),
      falloff: regl.prop('falloff'),
      foreground: regl.prop('foreground'),
      maxRadius: regl.prop('maxRadius')
    },
    count: 3,
    depth: { enable: false },
    blend: { enable: false },
    framebuffer: fbo
  })

  // scene: framebuffer/texture to blur; focus: [u, v]; amount: 0..1 scales
  // the maximum radius (px). Returns the framebuffer to read.
  function render ({ scene, width, height, focus, amount, maxRadius = 6, focusRadius = 0.5, falloff = 0.6, foreground = 0.5 }) {
    const w = Math.max(1, width | 0)
    const h = Math.max(1, height | 0)
    if (fbo.width !== w || fbo.height !== h) fbo.resize(w, h)
    pass({
      scene,
      texel: [1 / w, 1 / h],
      focus,
      aspect: w / h,
      focusRadius: Math.max(0, focusRadius),
      falloff: Math.max(0.01, falloff),
      foreground: Math.max(0, foreground),
      maxRadius: Math.max(0, amount) * Math.max(0, maxRadius)
    })
    return fbo
  }

  function destroy () {
    const tex = fbo.color[0]
    fbo.destroy()
    tex.destroy()
    position.destroy()
  }

  return { render, destroy, taps: TAPS }
}
