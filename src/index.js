import createRegl from 'regl'
import mat4 from 'gl-mat4'
import fit from 'canvas-fit'
import GUI from 'lil-gui'
import shuffle from 'shuffle-array'
import Alea from 'alea'
import Delaunator from 'delaunator'
import createAudio from './audio'
import createAnalysis from './audio-analysis'
import createCamera from './camera'
import createTitleCard from './title-card'
import createAudioControls, { isTextField, prefersReducedMotion } from './audio-controls'
import createRenderBloom from './render-bloom'
import createRenderPost from './render-post'
import detectHdr, { HDR_EXTENSIONS } from './gpu-hdr'
import createRenderBlur from './render-blur'
import createRenderGrid from './render-grid'
import createSettingsDrift from './settings-drift'
import createPalette from './palette'

// the viz canvas renders at the device pixel ratio, capped (retina phones
// report 3, which would triple the fill cost of every full-screen pass).
// Touch devices get a lower cap: phone GPUs pay for every full-res pass
// (trail blend, tonemap, FXAA) on far less fill rate than desktops.
const coarsePointer =
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches
const display = { maxPixelRatio: coarsePointer ? 1.5 : 2 }
const pixelRatio = () =>
  Math.max(0.5, Math.min(window.devicePixelRatio || 1, display.maxPixelRatio))

const titleCard = createTitleCard()
const canvas = document.querySelector('canvas.viz')
const resize = fit(canvas, null, pixelRatio())
function refit () {
  // devicePixelRatio changes with browser zoom and when the window moves
  // between screens; every FBO follows canvas.width/height on the next frame
  resize.scale = pixelRatio()
  resize()
}
window.addEventListener(
  'resize',
  () => {
    refit()
    titleCard.resize()
  },
  false
)
const camera = createCamera(canvas, [2.5, 2.5, 2.5], [0, 0, 0])
// optional GPU features: each user checks regl.hasExtension() and falls back
const regl = createRegl({
  canvas,
  attributes: { antialias: false, alpha: false, depth: false, stencil: false },
  optionalExtensions: HDR_EXTENSIONS
})

let delaunay,
  points,
  positions,
  positionsBuffer,
  fabricElements,
  renderFrequencies,
  renderGrid

// Fabric springs, stored as flat arrays (one slot per point) instead of
// spring-animator objects: the per-frame update reads each point's
// "next value" tens of thousands of times. Same maths as spring-animator's
// createSpring(stiffness, dampening): next = v + vel + (dest - v) * stiffness
// - vel * dampening, with vel = v - last.
let springValue, springLast, springDest, springPeek, springStiffness, springDamping

const getFrameBuffer = (width, height) =>
  regl.framebuffer({
    color: regl.texture({
      shape: [Math.max(1, width), Math.max(1, height), 4]
    }),
    depth: false,
    stencil: false
  })

const fbo = getFrameBuffer(512, 512)
const freqMapFBO = getFrameBuffer(512, 512)

const renderToFBO = regl({ framebuffer: fbo })
const renderToFreqMapFBO = regl({ framebuffer: freqMapFBO })

const renderBlur = createRenderBlur(regl)

// HDR scene buffer when the GPU can render, blend and filter half floats (or
// floats); plain uint8 otherwise. Motion-blur trails decay in this buffer,
// so with HDR they fade all the way to black instead of leaving 8-bit ghosts.
const hdrInfo = detectHdr(regl)
const sceneTexture = regl.texture({
  width: Math.max(1, canvas.width),
  height: Math.max(1, canvas.height),
  type: hdrInfo.type,
  min: 'linear',
  mag: 'linear',
  wrap: 'clamp'
})
const sceneFbo = regl.framebuffer({
  color: sceneTexture,
  depth: false,
  stencil: false
})
const renderToScene = regl({ framebuffer: sceneFbo })
const renderBloom = createRenderBloom(regl, hdrInfo)
const renderPost = createRenderPost(regl, hdrInfo)

const tracks = [
  { title: '#3', artist: 'fievresdusamedisoir', path: 'audio/fievresdusamedisoir3.mp3' },
  { title: '#2', artist: 'fievresdusamedisoir', path: 'audio/fievresdusamedisoir2.mp3' },
  { title: '#1', artist: 'fievresdusamedisoir', path: 'audio/fievresdusamedisoir.mp3' }
]

const audio = createAudio(tracks[0].path)
// per-frame audio features (log bands with AGC, aggregates, kick); updated
// once per frame in the render loop, read by everything that reacts to sound
const analysis = createAnalysis(audio)
const features = analysis.features

// per-track cosine palette, crossfaded on track change, drifting with energy
const palette = createPalette()

// The UI does not wait for the audio: iOS Safari buffers nothing before a
// user gesture (so 'canplay' may never fire), and a missing file must not
// leave a black page. Only the title font is waited for (briefly), since the
// title card samples the rendered text.
audio.ready.catch((err) => console.warn('audio failed to load', err))
const fontsReady = Promise.race([
  document.fonts && document.fonts.load
    ? document.fonts.load('48px "Open Sans"').catch(() => {})
    : Promise.resolve(),
  new Promise((resolve) => setTimeout(resolve, 1500))
])

fontsReady.then(() => {
  const audioControls = createAudioControls(audio, tracks, {
    onTrackChange: (i) => palette.setTrack(i)
  })

  function loop () {
    window.requestAnimationFrame(loop)
    audioControls.tick()
  }

  setup()

  // Warm-up: draw one frame synchronously, with the intro at 0 (pure black),
  // so shaders compile and every FBO is allocated now, while the title card
  // is showing, instead of stalling on the first visible frame. This replaces
  // the old "render for 1s then cancel" loop.
  warmUp()

  titleCard.show().then(() => {
    // The scene starts right away behind the title card (a 2D overlay above
    // the WebGL canvas) and fades in through `intro` while the title
    // particles fly off and the title canvas fades out.
    introStart = null
    playWhenAllowed()
    camera.start()
    startLoop()
    window.requestAnimationFrame(loop)
    // the player comes in once the grid is mostly there, then auto-hides
    // after a few seconds without activity (the GUI stays behind the G key)
    audioControls.addHoverZone(gui.domElement)
    setTimeout(() => {
      audioControls.show({
        duration: introTiming.uiFade,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
      })
    }, prefersReducedMotion() ? 0 : introTiming.uiDelay)
  })
})

// Title -> scene transition. intro goes 0 -> 1 (ease-out) over
// settings.introDuration seconds from the first frame after entering; it
// scales the grid (height and opacity, via renderGrid's multiplier) and the
// bloom. Before entering it stays at 0, so the warm-up frame is black.
const introTiming = { uiDelay: 1400, uiFade: 1500 } // ms
let introStart = null
let introActive = false
function introAmount (time) {
  if (!introActive) return 0
  if (introStart === null) introStart = time
  const d = Math.max(0.001, settings.introDuration)
  const t = Math.min(1, Math.max(0, (time - introStart) / d))
  const inv = 1 - t
  return 1 - inv * inv * inv // easeOutCubic
}

// When the title card enters on its own there was no click, so browsers
// may block the sound: start it on the first interaction instead.
// Only events that count as a user gesture are used: for touch that is
// pointerup / touchend / click, never pointerdown (Chrome only grants
// activation on pointerdown for the mouse). The listeners stay until a
// play() really starts the sound, so a rejected try does not use them up.
function playWhenAllowed () {
  const isRunning = () =>
    !audio.element.paused &&
    (!audio.context || audio.context.state === 'running')
  audio.play().then((started) => {
    if (started || isRunning()) return
    const events = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']
    let pending = false
    const remove = () => {
      events.forEach((e) => window.removeEventListener(e, unlock, true))
      audio.element.removeEventListener('play', onPlay)
      if (audio.context) audio.context.removeEventListener('statechange', onPlay)
    }
    const unlock = (e) => {
      if (pending) return
      if (e.type === 'pointerdown' && e.pointerType !== 'mouse') return
      // the player's own controls (play button, track list, Space) start
      // the sound themselves; unlocking here too would make them toggle it
      // straight back off
      if (e.target && e.target.closest && e.target.closest('.controls-container')) return
      if (e.type === 'keydown' && (e.code === 'Space' || e.key === 'Escape')) return
      pending = true
      audio.play().then((ok) => {
        pending = false
        if (ok || isRunning()) remove()
      })
    }
    // started some other way (player), or the context finished resuming
    // after the first try: stop listening, so a later click on the scene
    // does not resume a track the user paused
    const onPlay = () => {
      // the element can fire 'play' while the context is still locked
      // (silent); keep listening in that case
      if (isRunning()) remove()
    }
    events.forEach((e) => window.addEventListener(e, unlock, true))
    audio.element.addEventListener('play', onPlay)
    if (audio.context) audio.context.addEventListener('statechange', onPlay)
  })
}

const settings = {
  seed: 0,

  introDuration: 2.5, // seconds for the scene to fade in after the title

  cameraKick: 0.035, // camera nudge on kicks (world units, ~peak offset)

  points: 2500,
  dampening: 0.7,
  stiffness: 0.55,
  freqPow: 1.2,
  connectedNeighbors: 4,
  neighborWeight: 0.96, // lower than before: log bands light up more points
  contrast: 0.7,
  pointsPerBand: 5,
  blurAngle: 0.25,
  blurMag: 7,

  gridLines: 180,
  linesDampening: 0.02,
  linesStiffness: 0.9,
  linesAnimationOffset: 12,
  gridMaxHeight: 0.28,
  kickHeight: 0.35, // grid height pulse on kicks: height * (1 + kickHeight * kick)

  fogAmount: 0.85, // 0 = no fog
  fogStart: -0.3, // fog range, in view-space depth relative to the grid centre
  fogEnd: 1.6,
  fogDim: 0.5, // how much fogged lines also darken (besides fading)

  motionBlur: true,
  motionBlurAmount: 0.45,

  bloomThreshold: 0.04, // linear luminance where the glow starts
  bloomKnee: 0.6, // soft knee, as a fraction of the threshold
  bloomIntensity: 0.55,
  bloomScatter: 0.75, // weight of each coarser mip: higher = wider glow
  bloomKick: 1.2, // bloom flash on kicks: intensity * (1 + bloomKick * kick)

  exposure: 0.75, // linear gain before ACES tone mapping
  fxaa: true,
  vignette: 0.35,
  vignetteStart: 0.35,
  // radial offset at the corners, in uv units; 0 at rest on touch devices
  // (sub-pixel there anyway) so the extra post fetches only run on kicks
  chromaticAberration: 0, // any constant amount makes rainbow moire on the 1px lines
  chromaticKick: 0.004, // extra aberration on kicks
  grain: 0.03
}

// Tweak panel: hidden by default, toggled with the G key (top-right,
// compact; styled in index.html).
const gui = new GUI({ title: 'réglages (G)' })
gui.hide()
let guiOpenedOnce = false
function toggleGUI () {
  const show = gui._hidden
  gui.show(show)
  if (show && !guiOpenedOnce) {
    guiOpenedOnce = true
    gui.open()
  }
}
window.addEventListener('keydown', (e) => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
  if (e.code !== 'KeyG' && e.key !== 'g' && e.key !== 'G') return
  if (isTextField(e.target)) return
  e.preventDefault()
  toggleGUI()
})
// visual settings wander slightly (linearly) around their defaults
const drift = createSettingsDrift({ amount: 0.1, period: 20 })
const driftGUI = gui.addFolder('variation')
driftGUI.add(drift.settings, 'enabled').name('vary settings')
  .onChange((on) => { if (!on) drift.reset() })
driftGUI.add(drift.settings, 'amount', 0, 0.5).step(0.01).name('amount (±)')
driftGUI.add(drift.settings, 'period', 2, 120).step(1).name('period (s)')
const fabricGUI = gui.addFolder('fabric')
fabricGUI.add(settings, 'dampening', 0.01, 1).step(0.01).onChange(setup)
fabricGUI.add(settings, 'stiffness', 0.01, 1).step(0.01).onChange(setup)
fabricGUI.add(settings, 'connectedNeighbors', 0, 7).step(1).onChange(setup)
drift.add(fabricGUI.add(settings, 'neighborWeight', 0.8, 1).step(0.01), { amount: 0.012, absolute: true })
drift.add(fabricGUI.add(settings, 'contrast', 0, 0.9).step(0.01))
drift.add(fabricGUI.add(settings, 'freqPow', 0.5, 4).step(0.05))
fabricGUI.add(settings, 'pointsPerBand', 1, 10).step(1).onChange(setup)
const audioGUI = gui.addFolder('audio')
drift.add(audioGUI.add(analysis.opts, 'agcAmount', 0, 1).step(0.01))
audioGUI.add(analysis.opts, 'agcRelease', 1, 60).step(0.5)
audioGUI.add(analysis.opts, 'maxGain', 1, 10).step(0.1)
audioGUI.add(analysis.opts, 'noiseGate', 0, 0.3).step(0.005)
audioGUI.add(analysis.opts, 'kickSensitivity', 0, 5).step(0.05)
audioGUI.add(analysis.opts, 'kickMinFlux', 0, 0.1).step(0.001)
audioGUI.add(analysis.opts, 'kickRefractory', 0.05, 1).step(0.01)
audioGUI.add(analysis.opts, 'kickDecay', 0.05, 1).step(0.01)
audioGUI.close()
const bloomGUI = gui.addFolder('bloom')
drift.add(bloomGUI.add(settings, 'bloomThreshold', 0, 1).step(0.005).name('threshold'))
drift.add(bloomGUI.add(settings, 'bloomKnee', 0, 1).step(0.01).name('knee'))
drift.add(bloomGUI.add(settings, 'bloomIntensity', 0, 3).step(0.01).name('intensity'))
drift.add(bloomGUI.add(settings, 'bloomScatter', 0, 1).step(0.01).name('scatter'))
drift.add(bloomGUI.add(settings, 'bloomKick', 0, 4).step(0.05).name('kick flash'))
const gridGUI = gui.addFolder('grid')
gridGUI.add(settings, 'gridLines', 10, 300).step(1).onChange(setup)
gridGUI.add(settings, 'linesAnimationOffset', 0, 100).step(1)
drift.add(gridGUI.add(settings, 'gridMaxHeight', 0.01, 0.8).step(0.01))
drift.add(gridGUI.add(settings, 'kickHeight', 0, 2).step(0.01))
const fogGUI = gui.addFolder('fog')
drift.add(fogGUI.add(settings, 'fogAmount', 0, 1).step(0.01))
drift.add(fogGUI.add(settings, 'fogStart', -3, 3).step(0.05))
drift.add(fogGUI.add(settings, 'fogEnd', -3, 4).step(0.05))
drift.add(fogGUI.add(settings, 'fogDim', 0, 1).step(0.01))
fogGUI.close()
const paletteGUI = gui.addFolder('palette')
paletteGUI.add(palette.settings, 'crossfade', 0, 10).step(0.1)
drift.add(paletteGUI.add(palette.settings, 'drift', 0, 0.3).step(0.005))
drift.add(paletteGUI.add(palette.settings, 'driftSpeed', 0, 2).step(0.01))
drift.add(paletteGUI.add(palette.settings, 'driftEnergy', 0, 3).step(0.01))
drift.add(paletteGUI.add(palette.settings, 'energyShift', 0, 0.5).step(0.01))
paletteGUI.close()
const postGUI = gui.addFolder('post')
drift.add(postGUI.add(settings, 'exposure', 0.1, 3).step(0.01))
postGUI.add(settings, 'fxaa')
drift.add(postGUI.add(settings, 'vignette', 0, 1).step(0.01))
drift.add(postGUI.add(settings, 'vignetteStart', 0, 0.95).step(0.01))
postGUI.add(settings, 'chromaticAberration', 0, 0.02).step(0.0005)
drift.add(postGUI.add(settings, 'chromaticKick', 0, 0.04).step(0.0005))
drift.add(postGUI.add(settings, 'grain', 0, 0.15).step(0.005))
postGUI.add(display, 'maxPixelRatio', 0.5, 3).step(0.25).onChange(refit)
postGUI
  .add({ buffers: hdrInfo.hdr ? hdrInfo.type : 'uint8 (no HDR)' }, 'buffers')
  .disable()
postGUI.close()
const cameraGUI = gui.addFolder('camera')
cameraGUI.add(camera.settings, 'roam')
drift.add(cameraGUI.add(camera.settings, 'roamSpeed', 0, 0.5).step(0.002).name('roam speed'))
drift.add(cameraGUI.add(camera.settings, 'drift', 0, 3).step(0.05))
cameraGUI.add(camera.settings, 'resumeDelay', 1, 30).step(0.5).name('resume after (s)')
cameraGUI.add(camera.settings, 'resumeDuration', 0.5, 10).step(0.1).name('resume ease (s)')
drift.add(cameraGUI.add(settings, 'cameraKick', 0, 0.2).step(0.005).name('kick nudge'))
cameraGUI.add(camera.settings, 'nudgeFrequency', 0.5, 6).step(0.1).name('nudge freq')
cameraGUI.add(camera.settings, 'nudgeDamping', 0.2, 1.5).step(0.05).name('nudge damping')
cameraGUI.close()
gui.add(settings, 'motionBlur')
gui.add(settings, 'introDuration', 0.1, 8).step(0.1).name('intro (s)')
drift.add(gui.add(settings, 'motionBlurAmount', 0.01, 1).step(0.01))

function setup () {
  const rand = new Alea(settings.seed)
  points = []

  renderGrid = createRenderGrid(regl, settings)

  // fill up the points list with the frequency-tracking nodes: several
  // points per log band, low bands pulled toward the centre
  const bandCount = features.bandCount
  const perBand = Math.max(1, settings.pointsPerBand | 0)
  const trackedCount = bandCount * perBand
  for (let q = 0; q < trackedCount; q++) {
    const mag = Math.pow(rand(), 1 - q / trackedCount) * 0.9
    const rads = rand() * Math.PI * 2
    const position = [Math.cos(rads) * mag, Math.sin(rads) * mag]
    const id = points.length
    const point = createPoint(id, position)
    point.band = Math.floor(q / perBand)
    points.push(point)
  }

  while (points.length < settings.points) {
    points.push(createPoint(points.length, [rand() * 2 - 1, rand() * 2 - 1]))
  }

  function createPoint (id, position) {
    return {
      position: position,
      id: id,
      neighbors: new Set() // gonna fill this up with the results of delaunay
    }
  }

  const n = points.length
  springValue = new Float64Array(n)
  springLast = new Float64Array(n)
  springDest = new Float64Array(n)
  springPeek = new Float64Array(n)
  // argument order of the old createSpring(dampening * stiffness, stiffness)
  springStiffness = settings.dampening * settings.stiffness
  springDamping = settings.stiffness

  delaunay = new Delaunator(points.map((pt) => pt.position))
  for (let j = 0; j < delaunay.triangles.length; j += 3) {
    const pt1 = delaunay.triangles[j]
    const pt2 = delaunay.triangles[j + 1]
    const pt3 = delaunay.triangles[j + 2]

    points[pt1].neighbors.add(pt2)
    points[pt1].neighbors.add(pt3)
    points[pt2].neighbors.add(pt1)
    points[pt2].neighbors.add(pt3)
    points[pt3].neighbors.add(pt1)
    points[pt3].neighbors.add(pt2)
  }

  points.forEach((pt) => {
    pt.neighbors = shuffle(Array.from(pt.neighbors)).slice(
      0,
      settings.connectedNeighbors
    )
  })

  // one vertex per point (x, y, value), drawn through an index buffer of
  // the delaunay triangles; only the values change from frame to frame
  positions = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    positions[i * 3] = points[i].position[0]
    positions[i * 3 + 1] = points[i].position[1]
  }
  if (positionsBuffer) positionsBuffer.destroy()
  positionsBuffer = regl.buffer({ usage: 'dynamic', type: 'float', data: positions })
  if (fabricElements) fabricElements.destroy()
  // uint16 indices (WebGL1 core) as long as the point count allows it
  const indices = n <= 65536
    ? new Uint16Array(delaunay.triangles)
    : new Uint32Array(delaunay.triangles)
  fabricElements = regl.elements({
    data: indices,
    primitive: 'triangles',
    type: n <= 65536 ? 'uint16' : 'uint32'
  })

  renderFrequencies = regl({
    vert: `
      attribute vec3 position;

      varying vec4 fragColor;

      void main() {
        float actualIntensity = position.z * 1.2;
        fragColor = vec4(vec3(actualIntensity), 1);
        gl_Position = vec4(position.xy, 0, 1);
      }
    `,
    frag: `
      precision highp float;
      varying vec4 fragColor;
      void main() {
        gl_FragColor = fragColor;
      }
    `,
    attributes: {
      position: positionsBuffer
    },
    elements: fabricElements
  })
}

// the value a spring would reach after one more step (spring.tick(1, false))
function peekSpring (i) {
  const v = springValue[i]
  const vel = v - springLast[i]
  return v + vel + (springDest[i] - v) * springStiffness - vel * springDamping
}

function update () {
  const bands = features.bands
  const n = points.length
  const freqPow = settings.freqPow
  const neighborWeight = settings.neighborWeight
  // log bands put most points in the lows/mids, where music always has
  // energy: cut a floor so the fabric keeps dark areas between the peaks
  const contrast = Math.min(settings.contrast, 0.95)
  // every point's look-ahead value before this frame's steps
  for (let i = 0; i < n; i++) springPeek[i] = peekSpring(i)

  for (let i = 0; i < n; i++) {
    const pt = points[i]
    let value = 0
    if (pt.band !== undefined) {
      const b = Math.max(0, bands[pt.band] - contrast) / (1 - contrast)
      value = Math.pow(b, freqPow)
    }
    const neighbors = pt.neighbors
    const count = neighbors.length
    let neighborSum = 0
    for (let k = 0; k < count; k++) neighborSum += springPeek[neighbors[k]]
    const neighborAverage = count ? neighborSum / count : 0
    value = Math.max(value, neighborAverage * neighborWeight)

    // updateValue(value) + tick(): points processed later in this loop see
    // this one's new look-ahead, exactly as with the per-object springs
    springDest[i] = value
    const next = peekSpring(i)
    springLast[i] = springValue[i]
    springValue[i] = next
    springPeek[i] = peekSpring(i)
  }

  for (let i = 0; i < n; i++) positions[i * 3 + 2] = springPeek[i]
  positionsBuffer.subdata(positions)
}

const renderGlobals = regl({
  uniforms: {
    projection: ({ viewportWidth, viewportHeight }) =>
      mat4.perspective(
        [],
        Math.PI / 4,
        viewportWidth / viewportHeight,
        0.01,
        1000
      ),
    view: () => camera.getMatrix(),
    time: ({ time }) => time
  }
})

const renderColoredQuad = regl({
  vert: `
    precision highp float;
    attribute vec2 position;
    void main() {
      gl_Position = vec4(position, 0, 1);
    }
  `,
  frag: `
    precision highp float;
    uniform vec4 color;
    void main () {
      gl_FragColor = color;
    }
  `,
  depth: { enable: false },
  blend: {
    enable: true,
    // alpha is reset to 0 rather than accumulated: in a half-float buffer
    // an ever-growing alpha would eventually overflow to Infinity
    func: {
      srcRGB: 'src alpha',
      srcAlpha: 0,
      dstRGB: 'one minus src alpha',
      dstAlpha: 0
    },
    equation: {
      rgb: 'add',
      alpha: 'add'
    }
  },
  uniforms: {
    color: regl.prop('color')
  },
  attributes: {
    position: [-1, -1, -1, 4, 4, -1]
  },
  count: 3,
  primitive: 'triangles'
})

let lastFrameTime = null
function startLoop () {
  lastFrameTime = null
  introActive = true
  return regl.frame(({ time }) => {
    const dt = lastFrameTime === null ? 1 / 60 : time - lastFrameTime
    lastFrameTime = time
    renderFrame(time, dt)
  })
}

function warmUp () {
  try {
    regl.poll() // refresh viewport size outside regl.frame
    renderFrame(regl.now(), 1 / 60)
  } catch (err) {
    console.warn('warm-up frame failed', err)
  }
}

function renderFrame (time, dt) {
  drift.update(dt, !gui._hidden && !gui._closed)
  const intro = introAmount(time)
  analysis.update(dt)
  const pal = palette.update(dt, features.energy)
  if (features.onKick) camera.nudge(settings.cameraKick)
  camera.tick({ time })
  update()
  renderToFBO(() => {
    renderFrequencies()
  })
  renderToFreqMapFBO(() => {
    const rads = settings.blurAngle * Math.PI
    const direction = [
      Math.cos(rads) * settings.blurMag,
      Math.sin(rads) * settings.blurMag
    ]
    renderBlur({
      iChannel0: fbo,
      direction: direction
    })
  })
  const width = Math.max(1, canvas.width)
  const height = Math.max(1, canvas.height)
  if (sceneFbo.width !== width || sceneFbo.height !== height) {
    sceneFbo.resize(width, height)
  }
  renderToScene(() => {
    if (settings.motionBlur) {
      // renderColoredQuad({ color: [0.18, 0.18, 0.18, settings.motionBlurAmount] })
      // renderColoredQuad({ color: [0.08, 0.08, 0.08, settings.motionBlurAmount] })
      renderColoredQuad({
        color: [0.0, 0.0, 0.0, settings.motionBlurAmount]
      })
    } else {
      regl.clear({
        // color: [0.18, 0.18, 0.18, 1],
        color: [0.08, 0.08, 0.08, 1],
        depth: 1
      })
    }
    renderGlobals(() => {
      renderGrid({
        frequencyVals: freqMapFBO,
        gridMaxHeight:
          settings.gridMaxHeight * (1 + settings.kickHeight * features.kick),
        multiplier: intro,
        fogAmount: settings.fogAmount,
        fogStart: settings.fogStart,
        // smoothstep() is undefined when edge0 >= edge1
        fogEnd: Math.max(settings.fogEnd, settings.fogStart + 0.01),
        fogDim: settings.fogDim,
        paletteA: pal.paletteA,
        paletteB: pal.paletteB,
        paletteC: pal.paletteC,
        paletteD: pal.paletteD,
        paletteShift: pal.paletteShift
      })
    })
  })

  const bloom = renderBloom.render({
    source: sceneFbo,
    width,
    height,
    threshold: settings.bloomThreshold,
    knee: settings.bloomKnee,
    scatter: settings.bloomScatter
  })
  renderPost.render({
    scene: sceneFbo,
    bloom: bloom.texture,
    width,
    height,
    bloomIntensity:
      (intro *
        settings.bloomIntensity *
        (1 + settings.bloomKick * features.kick)) /
      bloom.norm,
    exposure: settings.exposure,
    ca:
      settings.chromaticAberration +
      settings.chromaticKick * features.kick,
    fxaa: settings.fxaa,
    vignette: settings.vignette,
    vignetteStart: settings.vignetteStart,
    grain: settings.grain
  })
}
