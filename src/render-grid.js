import { createSpring } from 'spring-animator'
import { paletteGLSL } from './palette'

// The grid is 2 * (gridLines - 1) lines, alternating x / y axis. The geometry
// is static on the GPU: each vertex only carries (line index, t). The only
// thing that moves is one spring offset per line, simulated on the CPU (a few
// hundred springs) and uploaded once per frame:
//  - as a 1-row texture when the GPU can sample 2 textures in the vertex
//    shader (frequencyVals + offsets). Float texture if OES_texture_float is
//    enabled, otherwise the value is packed in 16 bits (R = high byte,
//    G = low byte) and decoded in the shader;
//  - otherwise as a per-vertex attribute (dynamic buffer) as a fallback.

const SEGMENTS = 100 // segments per line (was 50 when built on the CPU)
const OFFSET_RANGE = 4.0 // packed offsets cover -4..4 (springs stay in -2..2)

let linesOffsetsLoopToken
let previous = null // GPU resources of the previous instance (setup on resize)

export default function createRenderGrid (regl, settings) {
  if (previous) previous.destroy()

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

  // static geometry: pairs of vertices per segment (primitive 'lines')
  const vertexCount = lineCount * SEGMENTS * 2
  const lineT = new Float32Array(vertexCount * 2)
  let k = 0
  for (let i = 0; i < lineCount; i++) {
    for (let q = 0; q < SEGMENTS; q++) {
      lineT[k++] = i
      lineT[k++] = q / SEGMENTS * 2 - 1
      lineT[k++] = i
      lineT[k++] = (q + 1) / SEGMENTS * 2 - 1
    }
  }
  const lineTBuffer = regl.buffer(lineT)

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
    `#define OFFSET_RANGE ${OFFSET_RANGE.toFixed(1)}`
  ].join('\n')

  const attributes = { lineT: lineTBuffer }
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
    paletteShift: regl.prop('paletteShift')
  }
  if (useTexture) {
    uniforms.offsets = offsetsTexture
    uniforms.lineCount = lineCount
  } else {
    attributes.offset = offsetsBuffer
  }

  const render = regl({
    vert: `
      precision highp float;
      ${defines}

      attribute vec2 lineT; // x: line index (even = x axis, odd = y axis), y: t in -1..1
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
      ${paletteGLSL}

      varying vec4 fragColor;

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

      void main() {
        float off = lineOffset();
        // 0 for x-axis lines (even index), 1 for y-axis lines (odd index)
        float axisY = step(0.5, lineT.x - 2.0 * floor(lineT.x * 0.5 + 0.25));
        vec2 position = mix(vec2(off, lineT.y), vec2(lineT.y, off), axisY);

        vec2 lookup = (position + 1.0) / 2.0;
        float frequencyVal = texture2D(frequencyVals, lookup).x;
        vec3 rgb = palette(frequencyVal) * 0.95;
        float opacity = clamp(pow(frequencyVal * 1.5, 2.0), 0.0, 0.95) * multiplier;

        vec4 viewPos = view * vec4(position, frequencyVal * gridMaxHeight * multiplier, 1.0);

        // distance fog, relative to the depth of the grid centre so it
        // follows the roaming camera: the far side of the grid recedes
        float depth = -viewPos.z;
        float centerDepth = -view[3].z;
        float fog = fogAmount * smoothstep(centerDepth + fogStart, centerDepth + fogEnd, depth);
        rgb *= 1.0 - fogDim * fog;
        opacity *= 1.0 - fog;

        fragColor = vec4(rgb, opacity);
        gl_Position = projection * viewPos;
      }
    `,
    frag: `
      precision mediump float;
      varying vec4 fragColor;
      void main() {
        gl_FragColor = fragColor;
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
    attributes,
    count: vertexCount,
    primitive: 'lines'
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
        for (let q = 0; q < SEGMENTS * 2; q++) offsetsAttr[p++] = v
      }
      offsetsBuffer.subdata(offsetsAttr)
    }
  }

  clearTimeout(linesOffsetsLoopToken)
  linesOffsetsLoopToken = setTimeout(setLinesOffsetsLoop, 15000 + 9500)

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

      setTimeout(() => {
        line.offset.updateValue(nextVal)
      }, i * settings.linesAnimationOffset)
    })
  }

  // Every 9.5s, reshuffle the grid lines. The token is always the pending
  // timeout so a new setup() (e.g. on resize) cancels the previous loop.
  function setLinesOffsetsLoop () {
    setLinesOffsets()
    linesOffsetsLoopToken = setTimeout(setLinesOffsetsLoop, 9500)
  }

  previous = {
    destroy () {
      // ignore resources already freed (e.g. by regl.destroy())
      const free = (res) => { try { if (res) res.destroy() } catch (e) {} }
      free(lineTBuffer)
      free(offsetsTexture)
      free(offsetsBuffer)
    }
  }

  // props: frequencyVals, gridMaxHeight, multiplier, fogAmount, fogStart,
  // fogEnd, fogDim, paletteA..D, paletteShift
  function renderGrid (props) {
    uploadOffsets()
    for (const line of lines) {
      line.offset.tick()
    }
    render(props)
  }
  // how the offsets reach the GPU (for debugging)
  renderGrid.offsetsMode = useTexture ? (useFloat ? 'texture-float' : 'texture-rgba8-packed') : 'attribute'
  return renderGrid
}

