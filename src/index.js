import createRegl from 'regl'
import mat4 from 'gl-mat4'
import fit from 'canvas-fit'
import GUI from 'lil-gui'
import shuffle from 'shuffle-array'
import Alea from 'alea'
import Delaunator from 'delaunator'
import createAudio from './audio'
import createAnalysis from './audio-analysis'
import createCamera, { CAMERA_SHOTS } from './camera'
import createTitleCard from './title-card'
import createAudioControls, { isTextField, prefersReducedMotion } from './audio-controls'
import createRenderBloom from './render-bloom'
import createRenderPost from './render-post'
import detectHdr, { HDR_EXTENSIONS } from './gpu-hdr'
import createRenderBlur from './render-blur'
import createRenderGrid, { GRID_FORMS } from './render-grid'
import createRenderTaa from './render-taa'
import createRenderReflection from './render-reflection'
import createRenderParticles from './render-particles'
import createRenderDof from './render-dof'
import createRenderGodrays, { GODRAYS_MAX_SAMPLES } from './render-godrays'
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
// frame-time governor (see governQuality): level 0 = settings as set in the
// panel; each level switches one more heavy pass off or down
const quality = { auto: true, level: 0 }
const QUALITY_MAX_LEVEL = 6
const governorPixelCap = () =>
  quality.auto ? (quality.level >= 6 ? 1 : quality.level >= 5 ? 1.5 : Infinity) : Infinity
const pixelRatio = () =>
  Math.max(0.5, Math.min(window.devicePixelRatio || 1, display.maxPixelRatio, governorPixelCap()))

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
// per point: band index (-1 = not tracking a band) and stereo pan (-1..1)
let pointBand, pointPan

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
// temporal AA of the composed scene (history buffers of the scene's type)
const renderTaa = createRenderTaa(regl, hdrInfo)
// depth: mirror floor, dust, depth of field, god rays
const renderReflection = createRenderReflection(regl, hdrInfo)
const renderParticles = createRenderParticles(regl, { count: coarsePointer ? 500 : 1500 })
const renderDof = createRenderDof(regl, Object.assign({ taps: coarsePointer ? 10 : 16 }, hdrInfo))
const renderGodrays = createRenderGodrays(regl, hdrInfo)

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
    onTrackChange: (i) => {
      palette.setTrack(i)
      // new mix: its sections and tempo start from scratch
      analysis.resetStructure()
    }
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
  contrast: 0.8, // tuned by eye: stereo/section boosts flood the fabric below this
  pointsPerBand: 5,
  // 0 = every point follows the mono bands, 1 = the left half of the fabric
  // follows the left channel and the right half the right channel
  stereoWidth: 0.6,
  blurAngle: 0.25,
  blurMag: 7,

  gridLines: 180,
  linesDampening: 0.02,
  linesStiffness: 0.9,
  linesAnimationOffset: 12,
  // segments per grid line (each one a 4-vertex ribbon quad)
  gridSegments: coarsePointer ? 64 : 100,
  gridMaxHeight: 0.28,
  kickHeight: 0.35, // grid height pulse on kicks: height * (1 + kickHeight * kick)
  // ribbon lines, widths in device pixels (like the old 1px GL lines, so
  // the density of the grid does not change with the pixel ratio): thin in
  // quiet parts, thicker on the peaks; below 1px a line fades instead
  lineWidth: 1,
  lineWidthPeak: 2,
  lineWidthDepth: 0.5, // 0 = same width at any distance, 1 = perspective
  linePeakGain: 0.15, // extra brightness on the peaks (HDR)

  // grid reshuffles: on every phrase once the tempo is trusted, otherwise
  // on a fixed timer
  reshuffleOnPhrase: true,
  reshuffleConfidence: 0.45, // bpm confidence needed to follow phrases
  reshuffleMinGap: 6, // s, at least this long between phrase reshuffles
  reshuffleInterval: 9.5, // s, fallback timer

  // colour by height (grid): 0 = colour from the intensity only, 1 = from
  // the height only (valleys low on the palette ramp, peaks high)
  heightColor: 0.5,
  heightColorRange: 1, // height of a full 'peak', in units of gridMaxHeight
  heightTint: 0.25, // cooler valleys / warmer peaks (on top of the palette)

  // grid forms and camera shots: 'auto' follows the section table
  // (SECTION_LOOK below), anything else locks it
  gridForm: 'auto',
  formMorph: 5, // s, eased morph between two forms
  formHold: 75, // s on a form before a phrase may change it (0 = never)
  dotSize: 2.5, // device px, dots of the point-cloud form
  cameraShot: 'auto',
  shotHold: 45, // s on a shot before a phrase may change it (0 = never)

  // mirror floor: the grid reflected below its base, blurred at reduced
  // resolution and added under it (off by default on touch devices: it
  // draws the whole grid a second time)
  reflectionAmount: coarsePointer ? 0 : 0.35, // 0 = off
  reflectionFade: 3.5, // fade with the height above the mirror (peaks first)
  reflectionDepth: 0.08, // mirror plane, this far below the grid base
  reflectionBlur: 1.5, // blur radius, in texels of the reduced buffer
  reflectionScale: coarsePointer ? 0.35 : 0.5, // resolution of the buffer

  // dust: point sprites floating around the grid (additive)
  dustAmount: 0.45, // brightness, 0 = off
  dustDensity: 1, // share of the particles drawn (1500 desktop / 500 touch)
  dustSize: 2.5, // CSS px at the distance of the grid centre
  dustSpeed: 1,
  dustTreble: 1.2, // brightness added by the treble
  dustSparkle: 1, // flash of a random subset on each beat
  dustSparkleShare: 0.15, // fraction of the particles that flash

  // light depth of field: sharp around the projected grid centre, blurred
  // toward the edges and the foreground (no depth buffer: a radial focus)
  dofAmount: coarsePointer ? 0 : 0.2, // 0 = off (pass skipped)
  focusRadius: 0.55, // in half screen heights
  dofFalloff: 0.8, // distance over which the blur reaches its maximum
  dofForeground: 0.6, // below the focus point the blur starts sooner
  dofMaxRadius: 6, // device px at full blur

  // god rays: radial blur of the bright parts toward the grid centre
  godRays: coarsePointer ? 0.25 : 0.35, // master intensity, 0 = off
  godRaysBase: 0.15, // level without kick or drop
  godRaysKick: 1, // added on kicks
  godRaysDrop: 1.5, // added by the drop section weight
  godRaysDecay: 0.96,
  godRaysDensity: 0.7, // fraction of the way to the centre the rays span
  godRaysSamples: coarsePointer ? 16 : 40,
  godRaysThreshold: 0.08, // linear luminance feeding the rays

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
  // anti-aliasing: temporal (jittered projection + history) on desktop,
  // FXAA on touch devices (one full-res pass less, no history buffers)
  aa: coarsePointer ? 'fxaa' : 'taa',
  taaHistory: 0.9, // history weight per 1/60 s
  taaJitter: 1, // jitter amplitude, in pixels (1 = full pixel footprint)
  taaSamples: 8, // length of the Halton (2,3) jitter cycle
  taaClip: 1, // neighbourhood clipping of the history (0 = none: ghosts)
  taaReproject: true, // follow the camera on the grid plane
  vignette: 0.35,
  vignetteStart: 0.35,
  // radial offset at the corners, in uv units; 0 at rest on touch devices
  // (sub-pixel there anyway) so the extra post fetches only run on kicks
  chromaticAberration: 0, // any constant amount makes rainbow moire on the 1px lines
  chromaticKick: 0.004, // extra aberration on kicks
  grain: 0.03
}

// ---- what each section does to the scene ----------------------------------
// One row per section of the mix (see music-structure.js). The numbers are
// blended by the smoothed section weights every frame; the lists are drawn
// from on a section change, and again on a phrase once a long section has
// held a form / shot for settings.formHold / shotHold seconds. A name listed
// twice is twice as likely. 'groove' is the plain, most common state.
//   forms   grid form:   'grid' | 'circles' | 'radial' | 'points'
//   shots   camera shot: 'classic' | 'wide' | 'top' | 'graze' | 'dive'
//   temp    colour temperature of the grid, -1 cool .. +1 warm
//   height  grid height factor
//   bloom   bloom intensity factor
const SECTION_LOOK = {
  breakdown: { forms: ['points', 'circles'], shots: ['wide', 'top'], temp: -0.35, height: 0.7, bloom: 0.7 },
  build: { forms: ['radial', 'circles'], shots: ['dive'], temp: 0.1, height: 1, bloom: 1 },
  drop: { forms: ['grid'], shots: ['graze'], temp: 0.3, height: 1.25, bloom: 1.3 },
  groove: { forms: ['grid', 'grid', 'grid', 'circles'], shots: ['classic', 'classic', 'wide', 'graze'], temp: 0, height: 1, bloom: 1 }
}
const SECTIONS = ['breakdown', 'build', 'drop', 'groove']

// weighted blend of one numeric column of SECTION_LOOK
function sectionMix (key) {
  const w = features.section
  let sum = 0
  let total = 0
  for (const name of SECTIONS) {
    const x = w[name] || 0
    sum += x * SECTION_LOOK[name][key]
    total += x
  }
  return total > 1e-6 ? sum / total : SECTION_LOOK.groove[key]
}

// picks forms and shots from the table (or the locks in settings)
const director = { formSince: 0, shotSince: 0 }
const pickFrom = (list, fallback) =>
  list && list.length ? list[Math.floor(Math.random() * list.length)] : fallback
function direct (dt) {
  // clamped: a hidden tab comes back with one huge frame, which must not
  // count as time spent on the current form / shot
  dt = Math.min(Math.max(dt || 0, 0), 0.1)
  director.formSince += dt
  director.shotSince += dt
  const look = SECTION_LOOK[features.sectionName] || SECTION_LOOK.groove
  const phrase = features.onPhrase && features.bpmConfidence >= settings.reshuffleConfidence
  // a long section: change on a phrase, or after 1.5x the hold without one
  const due = (since, hold) => hold > 0 && since >= hold && (phrase || since >= hold * 1.5)

  let form = null
  if (settings.gridForm !== 'auto') form = settings.gridForm
  else if (features.onSectionChange || due(director.formSince, settings.formHold)) {
    form = pickFrom(look.forms, 'grid')
    director.formSince = 0
  }
  if (form && form !== renderGrid.getForm()) {
    renderGrid.setForm(form, settings.formMorph)
    director.formSince = 0
  }

  let shot = null
  if (!camera.settings.shots) shot = 'classic'
  else if (settings.cameraShot !== 'auto') shot = settings.cameraShot
  else if (features.onSectionChange || due(director.shotSince, settings.shotHold)) {
    shot = pickFrom(look.shots, 'classic')
    director.shotSince = 0
  }
  if (shot && shot !== camera.getShot()) {
    camera.setShot(shot)
    director.shotSince = 0
  }
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
drift.add(fabricGUI.add(settings, 'stereoWidth', 0, 1).step(0.01).name('stereo width'))
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
// music structure: sections, tempo, and what they drive
const structureStatus = { section: 'groove', tempo: '—' }
const structureGUI = gui.addFolder('structure')
const statusControllers = [
  structureGUI.add(structureStatus, 'section').disable(),
  structureGUI.add(structureStatus, 'tempo').disable()
]
const structureOpts = analysis.structureOpts
structureGUI.add(structureOpts, 'phraseBeats', [8, 16, 32]).name('phrase (beats)')
structureGUI.add(structureOpts, 'beatLock', 0, 1).step(0.01).name('beat lock')
structureGUI.add(structureOpts, 'sectionSensitivity', 0.25, 3).step(0.05).name('section sensitivity')
structureGUI.add(structureOpts, 'sectionSmoothing', 0.5, 10).step(0.1).name('section smoothing (s)')
structureGUI.add(structureOpts, 'sectionMinDuration', 1, 30).step(0.5).name('section min (s)')
structureGUI.add(settings, 'reshuffleOnPhrase').name('reshuffle on phrase')
structureGUI.add(settings, 'reshuffleConfidence', 0, 1).step(0.01).name('phrase confidence')
structureGUI.add(settings, 'reshuffleMinGap', 0, 30).step(0.5).name('phrase min gap (s)')
structureGUI.add(settings, 'reshuffleInterval', 2, 30).step(0.5).name('fallback timer (s)')
// numeric columns of SECTION_LOOK (forms / shots lists: edit the table)
for (const name of ['breakdown', 'build', 'drop']) {
  drift.add(structureGUI.add(SECTION_LOOK[name], 'height', 0.1, 2).step(0.01).name(`${name} height`))
  drift.add(structureGUI.add(SECTION_LOOK[name], 'bloom', 0.1, 2.5).step(0.01).name(`${name} bloom`))
  drift.add(structureGUI.add(SECTION_LOOK[name], 'temp', -1, 1).step(0.01).name(`${name} colour temp`), { amount: 0.05, absolute: true })
}
structureGUI.close()
let statusTimer = 0
function updateStructureStatus (dt) {
  statusTimer -= dt
  if (statusTimer > 0 || gui._hidden || gui._closed || structureGUI._closed) return
  statusTimer = 0.25
  const s = features.section
  const pct = (x) => Math.round(x * 100)
  structureStatus.section =
    `${features.sectionName} · b${pct(s.breakdown)} u${pct(s.build)} d${pct(s.drop)} g${pct(s.groove)}`
  structureStatus.tempo =
    `${features.bpm.toFixed(1)} bpm · ${pct(features.bpmConfidence)}% · ${(features.beat % 4) + 1}/4`
  statusControllers.forEach((c) => c.updateDisplay())
}
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
gridGUI.add(settings, 'gridSegments', 16, 200).step(1).name('segments').onChange(setup)
drift.add(gridGUI.add(settings, 'lineWidth', 0.25, 4).step(0.05).name('line width (px)'))
drift.add(gridGUI.add(settings, 'lineWidthPeak', 0.25, 8).step(0.05).name('line width peak'))
drift.add(gridGUI.add(settings, 'lineWidthDepth', 0, 1).step(0.01).name('width depth'))
drift.add(gridGUI.add(settings, 'linePeakGain', 0, 1.5).step(0.01).name('peak brightness'))
drift.add(gridGUI.add(settings, 'heightColor', 0, 1).step(0.01).name('colour by height'))
drift.add(gridGUI.add(settings, 'heightTint', 0, 1).step(0.01).name('height tint'))
gridGUI.add(settings, 'heightColorRange', 0.2, 3).step(0.05).name('height colour range')
gridGUI.add(settings, 'gridForm', ['auto'].concat(GRID_FORMS)).name('form')
gridGUI.add(settings, 'formMorph', 0, 20).step(0.5).name('form morph (s)')
gridGUI.add(settings, 'formHold', 0, 300).step(5).name('form hold (s)')
drift.add(gridGUI.add(settings, 'dotSize', 0.5, 8).step(0.1).name('dot size (px)'))
const depthGUI = gui.addFolder('depth')
drift.add(depthGUI.add(settings, 'reflectionAmount', 0, 1).step(0.01).name('reflection'))
drift.add(depthGUI.add(settings, 'reflectionFade', 0, 12).step(0.1).name('reflection fade'))
depthGUI.add(settings, 'reflectionDepth', 0, 0.5).step(0.005).name('mirror depth')
drift.add(depthGUI.add(settings, 'reflectionBlur', 0, 4).step(0.05).name('reflection blur'))
depthGUI.add(settings, 'reflectionScale', 0.25, 1).step(0.05).name('reflection res')
drift.add(depthGUI.add(settings, 'dustAmount', 0, 2).step(0.01).name('dust'))
depthGUI.add(settings, 'dustDensity', 0, 1).step(0.01).name('dust density')
drift.add(depthGUI.add(settings, 'dustSize', 0.5, 10).step(0.1).name('dust size'))
drift.add(depthGUI.add(settings, 'dustSpeed', 0, 5).step(0.05).name('dust speed'))
drift.add(depthGUI.add(settings, 'dustTreble', 0, 4).step(0.05).name('dust treble'))
drift.add(depthGUI.add(settings, 'dustSparkle', 0, 4).step(0.05).name('dust sparkle'))
depthGUI.add(settings, 'dustSparkleShare', 0, 1).step(0.01).name('sparkle share')
drift.add(depthGUI.add(settings, 'dofAmount', 0, 1).step(0.01).name('depth of field'))
drift.add(depthGUI.add(settings, 'focusRadius', 0, 2).step(0.01).name('focus radius'))
drift.add(depthGUI.add(settings, 'dofFalloff', 0.05, 2).step(0.01).name('focus falloff'))
drift.add(depthGUI.add(settings, 'dofForeground', 0, 3).step(0.05).name('focus foreground'))
depthGUI.add(settings, 'dofMaxRadius', 1, 16).step(0.5).name('dof max (px)')
drift.add(depthGUI.add(settings, 'godRays', 0, 2).step(0.01).name('god rays'))
drift.add(depthGUI.add(settings, 'godRaysBase', 0, 1).step(0.01).name('rays base'))
drift.add(depthGUI.add(settings, 'godRaysKick', 0, 4).step(0.05).name('rays kick'))
drift.add(depthGUI.add(settings, 'godRaysDrop', 0, 4).step(0.05).name('rays drop'))
drift.add(depthGUI.add(settings, 'godRaysDecay', 0.8, 1).step(0.001).name('rays decay'), { amount: 0.008, absolute: true })
drift.add(depthGUI.add(settings, 'godRaysDensity', 0.05, 1).step(0.01).name('rays length'))
depthGUI.add(settings, 'godRaysSamples', 4, GODRAYS_MAX_SAMPLES).step(1).name('rays samples')
depthGUI.add(settings, 'godRaysThreshold', 0, 1).step(0.005).name('rays threshold')
depthGUI.close()
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
postGUI.add(settings, 'aa', ['taa', 'fxaa', 'off']).name('anti-aliasing')
  .onChange(() => renderTaa.reset())
postGUI.add(settings, 'taaHistory', 0, 0.98).step(0.01).name('taa history')
postGUI.add(settings, 'taaJitter', 0, 2).step(0.05).name('taa jitter (px)')
postGUI.add(settings, 'taaSamples', [4, 8, 16]).name('taa samples')
postGUI.add(settings, 'taaClip', 0, 1).step(0.01).name('taa clipping')
postGUI.add(settings, 'taaReproject').name('taa reproject')
drift.add(postGUI.add(settings, 'vignette', 0, 1).step(0.01))
drift.add(postGUI.add(settings, 'vignetteStart', 0, 0.95).step(0.01))
postGUI.add(settings, 'chromaticAberration', 0, 0.02).step(0.0005)
drift.add(postGUI.add(settings, 'chromaticKick', 0, 0.04).step(0.0005))
drift.add(postGUI.add(settings, 'grain', 0, 0.15).step(0.005))
postGUI.add(display, 'maxPixelRatio', 0.5, 3).step(0.25).onChange(refit)
postGUI.add(quality, 'auto').name('auto quality').onChange(() => {
  governor.slow = governor.fast = 0
  refit()
})
postGUI.add(quality, 'level', 0, QUALITY_MAX_LEVEL).step(1).name('quality drop').listen().disable()
postGUI
  .add({ buffers: hdrInfo.hdr ? hdrInfo.type : 'uint8 (no HDR)' }, 'buffers')
  .disable()
postGUI.close()
const cameraGUI = gui.addFolder('camera')
cameraGUI.add(camera.settings, 'roam')
cameraGUI.add(camera.settings, 'shots').name('shot switching')
cameraGUI.add(settings, 'cameraShot', ['auto'].concat(CAMERA_SHOTS)).name('shot')
cameraGUI.add(camera.settings, 'shotTransition', 0, 20).step(0.5).name('shot transition (s)')
cameraGUI.add(settings, 'shotHold', 0, 300).step(5).name('shot hold (s)')
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

  renderGrid = createRenderGrid(regl, settings, { segments: settings.gridSegments })

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
  pointBand = new Int16Array(n).fill(-1)
  pointPan = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (points[i].band !== undefined) pointBand[i] = points[i].band
    // soft crossover around the centre line, no seam between channels
    pointPan[i] = Math.max(-1, Math.min(1, points[i].position[0] / 0.25))
  }
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
  const bandsL = features.bandsL
  const bandsR = features.bandsR
  const width = Math.min(Math.max(settings.stereoWidth, 0), 1)
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
    const band = pointBand[i]
    if (band >= 0) {
      // left half follows the left channel, right half the right one,
      // blended toward mono by stereoWidth (identical for mono sources)
      const mono = bands[band]
      const pan = pointPan[i] * width
      const side = pan < 0 ? bandsL[band] : bandsR[band]
      const level = mono + Math.abs(pan) * (side - mono)
      const b = Math.max(0, level - contrast) / (1 - contrast)
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

// projection and view are computed once per frame in renderFrame (the TAA
// pass needs the unjittered ones, the scene gets the jittered projection)
const frameProjection = new Float32Array(16)
const sceneProjection = new Float32Array(16)
const frameView = new Float32Array(16)
const mirrorProps = {} // reused props of the reflection draw
const renderGlobals = regl({
  uniforms: {
    projection: () => sceneProjection,
    view: () => frameView,
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

// screen uv of the world point (0, 0, z) through view and projection, and
// whether it is in front of the camera; also the camera height (eye z)
const frameCenter = { uv: [0.5, 0.5], visible: 1, eyeZ: 1 }
function updateFrameCenter (proj, view, z) {
  // clip = P * V * (0, 0, z, 1), column-major
  let cx = 0
  let cy = 0
  let cw = 0
  for (let r = 0; r < 4; r++) {
    const v = view[8 + r] * z + view[12 + r] // view-space component r
    cx += proj[r * 4] * v
    cy += proj[r * 4 + 1] * v
    cw += proj[r * 4 + 3] * v
  }
  if (cw > 1e-4) {
    frameCenter.uv[0] = Math.min(Math.max((cx / cw) * 0.5 + 0.5, -1), 2)
    frameCenter.uv[1] = Math.min(Math.max((cy / cw) * 0.5 + 0.5, -1), 2)
  } else {
    frameCenter.uv[0] = 0.5
    frameCenter.uv[1] = 0.5
  }
  // fades out as the centre gets close to / behind the camera plane
  frameCenter.visible = Math.min(1, Math.max(0, (cw - 0.05) / 0.3))
  // eye = -R^T t
  frameCenter.eyeZ = -(view[8] * view[12] + view[9] * view[13] + view[10] * view[14])
}

// motionBlurAmount the reflection / dust brightness was tuned at
const ADDITIVE_LOOK_FADE = 0.45

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

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

// Frame-time governor: an EMA of the frame time; when it stays above the
// budget, one more heavy pass is dropped (depth of field, reflection, god
// ray samples, TAA -> FXAA, pixel ratio 1.5, then 1); when it stays well
// under, quality comes back one step at a time, more slowly (hysteresis),
// and even more slowly after a step up that had to be undone. Caveat: a
// browser that caps rAF to 30 fps (e.g. Safari in Low Power Mode) looks
// like a slow GPU and gets the lowest level; 'auto quality' turns it off.
const governor = {
  ema: 1 / 60,
  slow: 0, // seconds spent over budget
  fast: 0, // seconds spent well under budget
  warm: 0, // seconds since start (shader compiles, title card)
  sinceUp: Infinity, // seconds since the last step up
  upHold: 8 // seconds well under budget before a step up
}
const FRAME_BUDGET = 0.02 // s, ~50 fps
const FRAME_GOOD = 0.0135 // s, ~74 fps or a vsync-locked 60 with headroom
function governQuality (dt) {
  // hidden tabs / stalls: not a measure of the GPU
  if (!(dt > 0) || dt > 0.25) return
  const g = governor
  g.warm += dt
  g.sinceUp += dt
  g.ema += (dt - g.ema) * (1 - Math.exp(-dt / 0.75))
  if (!quality.auto || g.warm < 4) return
  const before = quality.level
  if (g.ema > FRAME_BUDGET) {
    g.slow += dt
    g.fast = 0
    if (g.slow > 2 && quality.level < QUALITY_MAX_LEVEL) {
      // undoing a recent step up: wait longer before trying again
      if (g.sinceUp < 6) g.upHold = Math.min(g.upHold * 2, 120)
      quality.level++
      g.slow = 0
    }
  } else {
    g.slow = Math.max(0, g.slow - dt)
    g.fast = g.ema < FRAME_GOOD ? g.fast + dt : 0
    if (g.fast > g.upHold && quality.level > 0) {
      quality.level--
      g.fast = 0
      g.sinceUp = 0
    }
  }
  if (quality.level !== before) {
    // the EMA must re-measure at the new level before the next step
    g.ema = FRAME_BUDGET * 0.9
    if (Math.min(before, quality.level) < 6 && Math.max(before, quality.level) >= 5) refit()
  }
}

function renderFrame (time, dt) {
  governQuality(dt)
  const q = quality.auto ? quality.level : 0
  const aaMode = q >= 4 && settings.aa === 'taa' ? 'fxaa' : settings.aa
  drift.update(dt, !gui._hidden && !gui._closed)
  const intro = introAmount(time)
  analysis.update(dt)
  const pal = palette.update(dt, features.energy)
  updateStructureStatus(dt)
  if (features.onKick) camera.nudge(settings.cameraKick)
  // section mapping, from the SECTION_LOOK table (1 / 0 in a plain groove)
  const section = features.section
  const sectionHeight = sectionMix('height')
  const sectionBloom = sectionMix('bloom')
  const sectionTemp = sectionMix('temp')
  direct(dt)
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
  renderGrid.tick(dt, features)

  // camera matrices; with TAA the scene is rendered with a sub-pixel jitter
  const useTaa = aaMode === 'taa'
  mat4.perspective(frameProjection, Math.PI / 4, width / height, 0.01, 1000)
  const view = camera.getMatrix()
  for (let i = 0; i < 16; i++) frameView[i] = view[i]
  sceneProjection.set(frameProjection)
  if (useTaa) {
    const j = renderTaa.jitter(settings.taaSamples, settings.taaJitter)
    renderTaa.jitterProjection(sceneProjection, j[0], j[1], width, height)
  } else {
    renderTaa.reset() // history is stale when TAA comes back on
  }

  updateFrameCenter(frameProjection, frameView, 0)

  const gridProps = {
    frequencyVals: freqMapFBO,
    gridMaxHeight:
      settings.gridMaxHeight * sectionHeight *
      (1 + settings.kickHeight * features.kick),
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
    paletteShift: pal.paletteShift,
    widthMin: settings.lineWidth,
    widthPeak: Math.max(settings.lineWidthPeak, settings.lineWidth),
    widthDepth: settings.lineWidthDepth,
    peakGain: settings.linePeakGain,
    heightColor: settings.heightColor,
    heightRef: settings.gridMaxHeight * Math.max(0.05, settings.heightColorRange),
    heightTint: settings.heightTint,
    sectionTemp,
    dotSize: settings.dotSize
  }

  // motion-blur fade per frame, for the amount set per 1/60 s (the trail
  // length no longer depends on the refresh rate)
  const blurStep = Math.min(Math.max(dt, 0), 0.1) * 60
  const blurFade = 1 - Math.pow(1 - Math.min(Math.max(settings.motionBlurAmount, 0.01), 1), blurStep)
  // the reflection and the dust are ADDED into the feedback buffer, so they
  // settle at 1 / blurFade times what is drawn each frame. Scale them by
  // blurFade so their brightness does not depend on motionBlurAmount (or on
  // the refresh rate), normalised to the look tuned at the default 0.45.
  const additiveGain = (settings.motionBlur ? blurFade : 1) / ADDITIVE_LOOK_FADE
  renderToScene(() => {
    if (settings.motionBlur) {
      // renderColoredQuad({ color: [0.18, 0.18, 0.18, settings.motionBlurAmount] })
      // renderColoredQuad({ color: [0.08, 0.08, 0.08, settings.motionBlurAmount] })
      renderColoredQuad({
        color: [0.0, 0.0, 0.0, blurFade]
      })
    } else {
      regl.clear({
        // color: [0.18, 0.18, 0.18, 1],
        color: [0.08, 0.08, 0.08, 1],
        depth: 1
      })
    }
  })

  // line offsets for this frame, shared by the reflection and the grid
  renderGrid.prepare()

  // mirror floor, under the grid; hidden when the camera dips below it
  const mirrorPlane = -Math.max(0, settings.reflectionDepth)
  const reflection = (q >= 2 ? 0 : settings.reflectionAmount) *
    smoothstep(mirrorPlane, mirrorPlane + 0.15, frameCenter.eyeZ)
  if (reflection > 1e-3) {
    const scale = Math.min(Math.max(settings.reflectionScale, 0.25), 1)
    renderReflection.render({
      width,
      height,
      scale,
      blur: settings.reflectionBlur,
      intensity: additiveGain,
      target: sceneFbo,
      draw: () => {
        renderGlobals(() => {
          renderGrid.draw(Object.assign(mirrorProps, gridProps, {
            // same physical width in the reduced buffer
            widthMin: gridProps.widthMin * scale,
            widthPeak: gridProps.widthPeak * scale,
            dotSize: gridProps.dotSize * scale,
            mirror: 1,
            mirrorPlane,
            mirrorFade: settings.reflectionFade,
            mirrorAmount: reflection
          }))
        })
      }
    })
  }

  renderToScene(() => {
    renderGlobals(() => {
      renderGrid(gridProps)
      renderParticles.render({
        dt,
        features,
        palette: pal,
        amount: settings.dustAmount * additiveGain,
        trebleGain: settings.dustTreble,
        sparkle: settings.dustSparkle,
        sparkleShare: settings.dustSparkleShare,
        size: settings.dustSize,
        speed: settings.dustSpeed,
        share: settings.dustDensity,
        pixelScale: pixelRatio(),
        intro
      })
    })
  })

  // TAA on the composed scene (grid + motion-blur trails), before bloom
  const sceneOut = useTaa
    ? renderTaa.render({
      scene: sceneFbo,
      width,
      height,
      dt,
      view: frameView,
      projection: frameProjection,
      historyWeight: settings.taaHistory,
      clip: settings.taaClip,
      reproject: settings.taaReproject
    })
    : sceneFbo

  // light depth of field around the projected grid centre
  const dofAmount = q >= 1 ? 0 : settings.dofAmount
  const dofOn = dofAmount > 1e-3
  const sceneFinal = dofOn
    ? renderDof.render({
      scene: sceneOut,
      width,
      height,
      focus: frameCenter.uv,
      amount: dofAmount,
      maxRadius: settings.dofMaxRadius,
      focusRadius: settings.focusRadius,
      falloff: settings.dofFalloff,
      foreground: settings.dofForeground
    })
    : sceneOut

  // god rays toward the grid centre, on kicks and drops
  const raysIntensity = settings.godRays * intro * frameCenter.visible *
    (settings.godRaysBase + settings.godRaysKick * features.kick +
      settings.godRaysDrop * section.drop)
  const rays = raysIntensity > 1e-3
    ? renderGodrays.render({
      source: sceneOut,
      width,
      height,
      light: frameCenter.uv,
      samples: q >= 3 ? Math.min(16, settings.godRaysSamples) : settings.godRaysSamples,
      decay: settings.godRaysDecay,
      density: settings.godRaysDensity,
      threshold: settings.godRaysThreshold
    })
    : null

  const bloom = renderBloom.render({
    source: sceneFinal,
    width,
    height,
    threshold: settings.bloomThreshold,
    knee: settings.bloomKnee,
    scatter: settings.bloomScatter
  })
  renderPost.render({
    scene: sceneFinal,
    bloom: bloom.texture,
    godrays: rays,
    godraysIntensity: raysIntensity,
    width,
    height,
    bloomIntensity:
      (intro *
        settings.bloomIntensity * sectionBloom *
        (1 + settings.bloomKick * features.kick)) /
      bloom.norm,
    exposure: settings.exposure,
    ca:
      settings.chromaticAberration +
      settings.chromaticKick * features.kick,
    fxaa: aaMode === 'fxaa',
    vignette: settings.vignette,
    vignetteStart: settings.vignetteStart,
    grain: settings.grain
  })
}
