// Hash blur, inlined from glsl-hash-blur + glsl-random (MIT),
// specialised with sample = tex and iterations = 20.
const hashBlur = `
      highp float random(vec2 co) {
        highp float a = 12.9898;
        highp float b = 78.233;
        highp float c = 43758.5453;
        highp float dt = dot(co.xy, vec2(a, b));
        highp float sn = mod(dt, 3.14);
        return fract(sin(sn) * c);
      }

      vec2 mult(inout vec2 r) {
        r = fract(r * vec2(12.9898, 78.233));
        return sqrt(r.x + .001) * vec2(sin(r.y * 6.28318530718), cos(r.y * 6.28318530718));
      }

      vec3 blur(vec2 uv, float radius, float aspect) {
        vec2 circle = vec2(radius);
        circle.x *= aspect;
        vec2 rnd = vec2(random(uv));
        vec3 acc = vec3(0.0);
        for (int i = 0; i < 20; i++) {
          acc += tex(uv + circle * mult(rnd)).xyz;
        }
        return acc / 20.0;
      }
`

export default function createRenderBloom (regl, canvas) {
  // the canvas can still be 0x0 if the page loads before layout (hidden tab)
  const width = Math.max(1, canvas.width)
  const height = Math.max(1, canvas.height)
  const blueTextureBuffer = new Uint8Array(width * height * 4)
  for (let i = 0; i < blueTextureBuffer.length; i += 4) {
    const x = i / 4 % width
    const y = i / 4 / width | 0
    if (x > 100 && y > 100) {
      blueTextureBuffer[i] = blueTextureBuffer[i + 1] = 0
      blueTextureBuffer[i + 2] = blueTextureBuffer[i + 3] = 255
    } else {
      blueTextureBuffer[i] = blueTextureBuffer[i + 1] = blueTextureBuffer[i + 2] = Math.random() * 255 | 0
      blueTextureBuffer[i + 3] = 255
    }
  }
  const tempFbo = regl.framebuffer({
    color: regl.texture({
      shape: [width, height, 4],
      data: blueTextureBuffer
    }),
    depth: true,
    stencil: false
  })

  const renderBloomBlur = regl({
    vert: `
      precision highp float;

      attribute vec2 position;

      varying vec2 uv;

      void main() {
        uv = position / 2.0 + 0.5;
        gl_Position = vec4(position, 0, 1);
      }
    `,
    frag: `
      precision highp float;

      varying vec2 uv;

      uniform vec2 iResolution;
      uniform sampler2D iChannel0;
      uniform float blurMag;

      vec3 tex(vec2 uv);

      ${hashBlur}

      vec3 tex(vec2 uv) {
        vec3 rgb = texture2D(iChannel0, uv).rgb;
        return rgb;
      }

      void main() {
        float aspect = iResolution.x / iResolution.y;
        vec3 blurred = blur(uv, blurMag / 200.0, 1.0 / aspect);
        gl_FragColor = vec4(blurred, 0.8);
      }
    `,
    uniforms: {
      iResolution: () => [canvas.width, canvas.height],
      iChannel0: regl.prop('iChannel0'), // sampler2D
      blurMag: regl.prop('blurMag')
    },
    attributes: {
      position: [
        -1, -1,
        -1, 4,
        4, -1
      ]
    },
    count: 3,
    primitive: 'triangles'
  })

  const renderBloomCombine = regl({
    vert: `
      precision highp float;

      attribute vec2 position;

      varying vec2 uv;

      void main() {
        uv = position / 2.0 + 0.5;
        gl_Position = vec4(position, 0, 1);
      }
    `,
    frag: `
      precision highp float;

      varying vec2 uv;

      uniform sampler2D iChannel0;
      uniform sampler2D blurredFrame;
      uniform float blurWeight;
      uniform float originalWeight;

      void main () {
        vec4 blurred = texture2D(blurredFrame, uv);
        vec4 original = texture2D(iChannel0, uv);
        if (blurred.r < 0.2 && original.r < 0.2) {
          gl_FragColor = original;
        } else {
          blurred.r = pow(blurred.r, 1.9);
          blurred.g = pow(blurred.g, 2.0);
          blurred.b = pow(blurred.b, 1.5);
          vec4 weightedOriginal = originalWeight * original;
          vec4 weightedBlur = blurWeight * blurred;
          // gl_FragColor = vec4(
          //   max(weightedOriginal.r, weightedBlur.r),
          //   max(weightedOriginal.g, weightedBlur.g),
          //   max(weightedOriginal.b, weightedBlur.b),
          //   original.a
          // );
          vec4 result = weightedOriginal + weightedBlur;
          gl_FragColor = vec4(result.rgb / 1.5, result.a);
        }
      }
    `,
    uniforms: {
      iChannel0: regl.prop('iChannel0'), // sampler2D
      blurredFrame: () => tempFbo, // sampler2D
      blurWeight: regl.prop('blurWeight'),
      originalWeight: regl.prop('originalWeight')
    },
    attributes: {
      position: [
        -1, -1,
        -1, 4,
        4, -1
      ]
    },
    count: 3,
    primitive: 'triangles'
  })

  const renderToTempFbo = regl({ framebuffer: tempFbo })

  return function render ({ iChannel0, blurMag, blurWeight, originalWeight }) {
    // keep the bloom buffer in sync with the canvas after a window resize
    const w = Math.max(1, canvas.width)
    const h = Math.max(1, canvas.height)
    if (tempFbo.width !== w || tempFbo.height !== h) {
      tempFbo.resize(w, h)
    }
    renderToTempFbo(() => {
      renderBloomBlur({ iChannel0, blurMag })
    })
    renderBloomCombine({
      iChannel0,
      blurWeight,
      originalWeight,
      blurredFrame: tempFbo
    })
  }
}
