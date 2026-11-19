// Picks the best colour-buffer type the GPU can really render into, blend
// into and sample with linear filtering. Extension presence alone is not
// trusted (iOS and some Android drivers advertise formats that end up
// incomplete or unblendable): each candidate is exercised with a tiny
// render -> blend -> linear-sample -> readback round trip.

export const HDR_EXTENSIONS = [
  'oes_texture_half_float',
  'oes_texture_half_float_linear',
  'oes_texture_float',
  'oes_texture_float_linear',
  'ext_color_buffer_half_float',
  'webgl_color_buffer_float',
  'ext_float_blend'
]

const FULLSCREEN = [-1, -1, -1, 4, 4, -1]

export default function detectHdr (regl) {
  const candidates = []
  if (
    regl.hasExtension('oes_texture_half_float') &&
    regl.hasExtension('oes_texture_half_float_linear')
  ) {
    candidates.push('half float')
  }
  if (
    regl.hasExtension('oes_texture_float') &&
    regl.hasExtension('oes_texture_float_linear')
  ) {
    candidates.push('float')
  }
  if (!candidates.length) return { type: 'uint8', hdr: false }

  // draw additively: two passes of (1, .25, .125) must sum to (2, .5, .25),
  // which only survives in a real >8-bit buffer with working blending
  const write = regl({
    vert: `
      precision highp float;
      attribute vec2 position;
      void main() { gl_Position = vec4(position, 0, 1); }
    `,
    frag: `
      precision mediump float;
      void main() { gl_FragColor = vec4(1.0, 0.25, 0.125, 1.0); }
    `,
    attributes: { position: FULLSCREEN },
    count: 3,
    depth: { enable: false },
    blend: { enable: true, func: { src: 'one', dst: 'one' } },
    framebuffer: regl.prop('fbo')
  })
  // then read it back through a linearly filtered lookup into uint8
  const read = regl({
    vert: `
      precision highp float;
      attribute vec2 position;
      varying vec2 uv;
      void main() { uv = position * 0.5 + 0.5; gl_Position = vec4(position, 0, 1); }
    `,
    frag: `
      precision mediump float;
      uniform sampler2D src;
      varying vec2 uv;
      void main() { gl_FragColor = vec4(texture2D(src, uv).rgb * 0.25, 1.0); }
    `,
    attributes: { position: FULLSCREEN },
    uniforms: { src: regl.prop('src') },
    count: 3,
    depth: { enable: false },
    framebuffer: regl.prop('fbo')
  })

  for (const type of candidates) {
    if (probe(regl, type, write, read)) return { type, hdr: true }
  }
  return { type: 'uint8', hdr: false }
}

// Raw-GL completeness check for a colour attachment of `type`. regl's own
// framebuffer() throws on an incomplete FBO after it has already registered
// it (and left it bound), which would break regl's context-restore path; so
// incomplete formats are rejected here, before regl ever sees them. Every
// binding touched is restored, so regl's cached state stays valid.
function colorBufferComplete (regl, type) {
  const gl = regl._gl
  if (!gl) return true // cannot pre-check: let the regl probe decide
  let glType = gl.FLOAT
  if (type === 'half float') {
    const ext = gl.getExtension('OES_texture_half_float')
    if (!ext) return false
    glType = ext.HALF_FLOAT_OES
  }
  const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING)
  const prevUnit = gl.getParameter(gl.ACTIVE_TEXTURE)
  gl.activeTexture(gl.TEXTURE0)
  const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D)
  const tex = gl.createTexture()
  const fb = gl.createFramebuffer()
  let complete = false
  try {
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, glType, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
  } catch (e) {
    complete = false
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo)
  gl.bindTexture(gl.TEXTURE_2D, prevTex)
  gl.activeTexture(prevUnit)
  gl.deleteFramebuffer(fb)
  gl.deleteTexture(tex)
  // drain any error raised above, so regl's debug checks do not trip on it
  for (let i = 0; i < 8 && gl.getError() !== gl.NO_ERROR; i++) {}
  return complete
}

function probe (regl, type, write, read) {
  if (!colorBufferComplete(regl, type)) return false
  let tex, fbo, out
  let ok = false
  try {
    tex = regl.texture({
      width: 4,
      height: 4,
      type,
      min: 'linear',
      mag: 'linear',
      wrap: 'clamp'
    })
    // completeness was pre-checked above (regl would throw here otherwise)
    fbo = regl.framebuffer({ color: tex, depth: false, stencil: false })
    out = regl.framebuffer({ width: 4, height: 4, depth: false, stencil: false })
    regl.clear({ color: [0, 0, 0, 0], framebuffer: fbo })
    write({ fbo })
    write({ fbo })
    read({ fbo: out, src: fbo })
    const px = regl.read({ framebuffer: out })
    // expected ~ (128, 32, 16)
    ok =
      Math.abs(px[0] - 128) <= 6 &&
      Math.abs(px[1] - 32) <= 6 &&
      Math.abs(px[2] - 16) <= 6
  } catch (e) {
    ok = false
  }
  for (const r of [out, fbo, tex]) {
    try {
      if (r) r.destroy()
    } catch (e) {
      // already freed
    }
  }
  return ok
}
