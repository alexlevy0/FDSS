import createCamera from '3d-view-controls'
import lookAtMatrix from 'gl-mat4/lookAt'

// Roaming camera on top of 3d-view-controls.
//
// Naming note: 3d-view-controls' `camera.lookAt(a, b, up)` forwards to
// `view.lookAt(t, eye = a, center = b, up)`, and the `camera.center` setter
// actually moves the EYE (it calls view.lookAt(t, newEye)), while the getter
// returns the look-at target. Below, `eye` always means the camera position
// and `target` the point it looks at.
//
// States:
//   roaming  - the eye follows an ellipse around the origin, plus a slow
//              deterministic drift, looking at the origin.
//   user     - the user drags / pinches / scrolls; we leave the controls alone.
//   resuming - after `resumeDelay` seconds without interaction, the eye and
//              target ease from wherever the user left them back onto the
//              roaming path (no jump), and the roaming speed ramps up.
//
// Kick nudge: a damped spring offset applied to the view matrix in view
// space, so it never alters the controls' own state (it works in every mode).

const TAU = Math.PI * 2

// Roaming "shots": each one is a parametric path around the origin, given
// as cylindrical parameters at the shared roaming angle `rads` (so a change
// of shot never swings the camera around): ellipse radii rx / ry, eye
// height z, look-at height tz, angular speed factor and drift factor.
// `t` is the time since the shot started (the dive closes in over time).
// lookAhead moves the look-at point that far past the centre, away from
// the eye, so the shot also takes in the history landscape that lies on
// the far side of the grid (0 = look at the centre).
// A switch blends the parameters of the two paths (both keep moving) with
// an eased curve, so there is never a cut -- except cut(), the hard cuts
// the director asks for on bars during drops: an instant switch to another
// shot, with a deterministic variation of its path (see cutVariation()).
const SHOTS = {
  // the original ellipse, rising and falling once per revolution
  classic (o, rads) {
    o.rx = 1.5; o.ry = 2.7
    o.z = (Math.sin(rads) * 0.5 + 0.5) * 3 + 0.5
    o.tz = 0; o.speed = 1; o.drift = 1; o.lookAhead = 0
  },
  // high, slow and wide: the whole grid in view
  wide (o, rads) {
    o.rx = 3.3; o.ry = 3.8
    o.z = 2.9 + 0.5 * Math.sin(rads * 0.5 + 1)
    o.tz = 0; o.speed = 0.5; o.drift = 1.2; o.lookAhead = 0.35
  },
  // almost straight down, slowly turning (never exactly vertical: the
  // controls keep a z-up camera)
  top (o) {
    o.rx = 0.75; o.ry = 0.9
    o.z = 4.3
    o.tz = 0; o.speed = 0.55; o.drift = 0.5; o.lookAhead = 0
  },
  // low grazing fly-over, faster, just above the peaks
  graze (o, rads) {
    o.rx = 1.85; o.ry = 2.25
    o.z = 0.55 + 0.12 * Math.sin(rads * 3)
    o.tz = 0.1; o.speed = 1.35; o.drift = 0.45; o.lookAhead = 0.25
  },
  // slow dive toward the centre, closing in over ~20 s then holding
  dive (o, rads, t) {
    const p = 1 - Math.exp(-t / 22)
    o.rx = 3.0 - 1.8 * p; o.ry = 3.3 - 2.0 * p
    o.z = 3.4 - 2.4 * p
    o.tz = 0; o.speed = 0.7 + 0.5 * p; o.drift = 0.7; o.lookAhead = 0
  }
}
export const CAMERA_SHOTS = Object.keys(SHOTS)
const PARAMS = ['rx', 'ry', 'z', 'tz', 'speed', 'drift', 'lookAhead']
const newParams = () => ({ rx: 0, ry: 0, z: 0, tz: 0, speed: 1, drift: 1, lookAhead: 0 })

// per-shot path variation of a hard cut (identity: no variation)
const newVariation = () => ({ rx: 1, ry: 1, z: 1, tz: 0, speed: 1, lookAhead: 1 })
function resetVariation (v) {
  v.rx = 1; v.ry = 1; v.z = 1; v.tz = 0; v.speed = 1; v.lookAhead = 1
}
const isIdentity = (v) =>
  v.rx === 1 && v.ry === 1 && v.z === 1 && v.tz === 0 && v.speed === 1 && v.lookAhead === 1
function applyVariation (o, v) {
  o.rx *= v.rx
  o.ry *= v.ry
  o.z *= v.z // cutVariation keeps it >= 0.9 (graze skims the peaks)
  o.tz += v.tz
  o.speed *= v.speed
  o.lookAhead *= v.lookAhead
  return o
}

// small deterministic random source (mulberry32) from an integer seed
function seededRandom (seed) {
  let a = (seed | 0) ^ 0x9e3779b9
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export default function createRoamingCamera (canvas, initialEye, initialTarget) {
  const settings = {
    roam: true,
    roamSpeed: 0.084, // rad/s: one revolution in ~75 s (old 0.0014 rad/frame at 60fps)
    resumeDelay: 6, // seconds of inactivity before roaming resumes
    resumeDuration: 4, // seconds to ease back onto the path
    drift: 1, // drift amplitude multiplier (0 = perfect ellipse)
    nudgeFrequency: 2.4, // Hz of the kick spring
    nudgeDamping: 0.55, // damping ratio of the kick spring (<1 overshoots a bit)
    shots: true, // let the director switch shots (off: back to 'classic')
    lookAhead: 1, // scales each shot's look past the centre (0 = always the centre)
    shotTransition: 7, // seconds of the eased blend between two shots
    cutVariation: 1 // 0..1, how far a hard cut varies its shot's path
  }

  const camera = createCamera(canvas, {
    zoomSpeed: 4,
    rotateSpeed: 4,
    zoomMin: -1,
    zoomMax: 0
  })

  camera.lookAt(initialEye, initialTarget, [0, 0, 1])

  // ---- roaming path -------------------------------------------------------

  // ---- shots ----------------------------------------------------------------

  let shot = 'classic'
  let shotTime = 0 // s since the current shot started
  // previous shot while blending: a live shot (name + its own time) or, if
  // the switch came in the middle of another blend, a frozen snapshot
  let fromShot = null
  let fromTime = 0
  const fromFrozen = newParams()
  let blendT = 1
  let blendDuration = 7
  // path variations of the current shot and of the shot blended from (only
  // non-identity after a hard cut; a later eased switch blends them out)
  const curVar = newVariation()
  const fromVar = newVariation()
  const pCur = newParams()
  const pFrom = newParams()
  const params = newParams()

  const ease = (x) => x * x * x * (x * (x * 6 - 15) + 10) // smootherstep

  // blended shot parameters at angle rads
  function shotParams (out, rads) {
    SHOTS[shot](pCur, rads, shotTime)
    applyVariation(pCur, curVar)
    if (blendT >= 1) {
      for (const k of PARAMS) out[k] = pCur[k]
      return out
    }
    if (fromShot) {
      SHOTS[fromShot](pFrom, rads, fromTime)
      applyVariation(pFrom, fromVar)
    }
    const src = fromShot ? pFrom : fromFrozen
    const s = ease(blendT)
    for (const k of PARAMS) out[k] = src[k] + (pCur[k] - src[k]) * s
    return out
  }

  // eased switch to a shot; switching to the current shot only blends its
  // cut variation out (and keeps its own time)
  function setShot (name, duration) {
    if (!SHOTS[name]) return
    const same = name === shot
    if (same && isIdentity(curVar)) return
    const d = duration === undefined ? settings.shotTransition : duration
    if (state === 'user' || !(d > 0)) {
      // the user holds the camera (resuming eases back anyway), or no blend
      if (!same) shotTime = 0
      shot = name
      blendT = 1
      fromShot = null
      resetVariation(curVar)
      return
    }
    if (blendT < 1) {
      shotParams(fromFrozen, rads)
      fromShot = null
    } else {
      fromShot = shot
      fromTime = shotTime
      Object.assign(fromVar, curVar)
    }
    resetVariation(curVar)
    if (!same) shotTime = 0
    shot = name
    blendT = 0
    blendDuration = d
  }

  // the variation of a hard cut, from an integer seed (amount 0..1)
  function cutVariation (out, rand, amount) {
    const k = Math.min(Math.max(amount, 0), 1)
    const s = 1 + k * (rand() * 0.4 - 0.2) // 0.8 .. 1.2 closer / further
    out.rx = s * (1 + k * (rand() * 0.16 - 0.08))
    out.ry = s * (1 + k * (rand() * 0.16 - 0.08))
    out.z = 1 + k * (rand() * 0.45 - 0.1) // 0.9 .. 1.35 (never much lower)
    out.tz = k * (rand() * 0.16 - 0.04)
    out.speed = 1 + k * (rand() * 0.5 - 0.15)
    out.lookAhead = 1 + k * (rand() * 0.8 - 0.4)
    return out
  }

  // Hard cut: switches to `name` at once (no blend), with a variation of
  // its path drawn from `seed` (same seed, same cut): its scale, height,
  // look-at height, speed, look-ahead, plus a jump along the path and in
  // the drift pattern. Only while roaming: never while the user holds the
  // camera or while it eases back to the path. Returns true when it cut.
  function cut (name, seed) {
    if (!started || state !== 'roaming' || !SHOTS[name]) return false
    const rand = seededRandom(seed)
    cutVariation(curVar, rand, settings.cutVariation)
    const k = Math.min(Math.max(settings.cutVariation, 0), 1)
    // jump along the path: 20 to 60 degrees, either way
    const dir = rand() < 0.5 ? -1 : 1
    rads += dir * k * (0.35 + rand() * 0.7)
    rads -= TAU * Math.floor(rads / TAU)
    roamTime += k * rand() * 40
    shot = name
    shotTime = 0
    blendT = 1
    fromShot = null
    return true
  }

  function stepShot (dt) {
    shotTime += dt
    fromTime += dt
    if (blendT < 1) {
      blendT = Math.min(1, blendT + dt / Math.max(0.01, blendDuration))
      if (blendT >= 1) fromShot = null
    }
  }

  function ellipse (out, rads) {
    shotParams(params, rads)
    out[0] = Math.sin(rads) * params.rx
    out[1] = Math.cos(rads) * params.ry
    out[2] = params.z
    return out
  }

  // low-frequency smooth noise: sums of sines with incommensurate frequencies
  // (ratios of irrational numbers) so the pattern never visibly repeats.
  function drift (out, t, amount) {
    out[0] = amount * (
      0.22 * Math.sin(t * 0.0731 * TAU + 1.3) +
      0.11 * Math.sin(t * 0.1873 * TAU + 4.1) +
      0.05 * Math.sin(t * 0.4142 * TAU + 0.7))
    out[1] = amount * (
      0.26 * Math.sin(t * 0.0577 * TAU + 2.9) +
      0.12 * Math.sin(t * 0.1618 * TAU + 0.2) +
      0.05 * Math.sin(t * 0.3819 * TAU + 5.3))
    out[2] = amount * (
      0.16 * Math.sin(t * 0.0839 * TAU + 3.7) +
      0.08 * Math.sin(t * 0.2236 * TAU + 1.9) +
      0.03 * Math.sin(t * 0.5257 * TAU + 2.4))
    return out
  }

  // small wander of the look-at point, same idea, much smaller
  function targetDrift (out, t, amount) {
    out[0] = amount * 0.06 * Math.sin(t * 0.0491 * TAU + 0.4)
    out[1] = amount * 0.06 * Math.sin(t * 0.0613 * TAU + 2.2)
    out[2] = amount * 0.03 * Math.sin(t * 0.0707 * TAU + 4.6)
    return out
  }

  // Framing of the fabric's 3D shape (render-grid shapeFraming, set every
  // frame by index.js from the eased shape weights, so it moves as slowly
  // as the morph): the look-at point rises / sinks to the shape's centre,
  // the eye follows it plus `eyeRise`, and the path is scaled by `radius`
  // around the centre (further out for a ball, closer and higher above a
  // well). Identity when flat. Only the roaming path: the user's camera is
  // left alone.
  const frame = { targetZ: 0, eyeRise: 0, radius: 1 }
  function setFrame (targetZ, eyeRise, radius) {
    const fin = (x, d) => (typeof x === 'number' && isFinite(x) ? x : d)
    frame.targetZ = Math.min(Math.max(fin(targetZ, 0), -2), 2)
    frame.eyeRise = Math.min(Math.max(fin(eyeRise, 0), -1), 3)
    frame.radius = Math.min(Math.max(fin(radius, 1), 0.3), 3)
  }

  const tmpDrift = new Float64Array(3)
  function pathEye (out, rads, t) {
    ellipse(out, rads) // also leaves the blended shot params in `params`
    out[0] *= frame.radius
    out[1] *= frame.radius
    out[2] = out[2] * frame.radius + frame.targetZ + frame.eyeRise
    drift(tmpDrift, t, settings.drift * params.drift)
    out[0] += tmpDrift[0]
    out[1] += tmpDrift[1]
    out[2] += tmpDrift[2]
    return out
  }
  // call after pathEye (uses the shot params it computed); r: the path
  // angle the eye was computed at (the eye sits at ~(sin r, cos r))
  function pathTarget (out, t, r) {
    targetDrift(out, t, settings.drift)
    out[2] += params.tz + frame.targetZ
    const la = params.lookAhead * Math.max(0, settings.lookAhead) * frame.radius
    out[0] -= Math.sin(r) * la
    out[1] -= Math.cos(r) * la
    return out
  }

  // ---- state --------------------------------------------------------------

  let started = false
  let state = 'roaming' // 'roaming' | 'user' | 'resuming'
  let rads = 0
  let roamTime = 0 // drives the drift; only advances while (re)roaming
  let lastInteraction = 0 // seconds, performance clock
  let pointerDown = false
  let resumeT = 0
  const resumeEye = [0, 0, 0]
  const resumeTarget = [0, 0, 0]
  let lastTime = null

  const eye = [0, 0, 0]
  const target = [0, 0, 0]
  // eye / target hold this frame's finite, distinct pose (getMatrix)
  let poseValid = false
  function checkPose () {
    let d = 0
    for (let i = 0; i < 3; i++) {
      if (!isFinite(eye[i]) || !isFinite(target[i])) return false
      d += (eye[i] - target[i]) * (eye[i] - target[i])
    }
    return d > 1e-8
  }
  const tmp = [0, 0, 0]
  const cameraUp = new Float32Array(3)

  const nowSec = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000

  function interact () {
    lastInteraction = nowSec()
    if (state !== 'user') state = 'user'
  }
  function onDown () {
    pointerDown = true
    interact()
  }
  function onMove () {
    if (pointerDown) interact()
  }
  function onUp () {
    if (pointerDown) {
      pointerDown = false
      lastInteraction = nowSec()
    }
  }

  function start () {
    if (started) return
    started = true
    const passive = { passive: true }
    canvas.addEventListener('mousedown', onDown, passive)
    canvas.addEventListener('touchstart', onDown, passive)
    canvas.addEventListener('wheel', interact, passive)
    window.addEventListener('mousemove', onMove, passive)
    window.addEventListener('touchmove', onMove, passive)
    window.addEventListener('mouseup', onUp, passive)
    window.addEventListener('touchend', onUp, passive)
    window.addEventListener('touchcancel', onUp, passive)
    window.addEventListener('blur', onUp)
    // glide from the initial view onto the path instead of snapping to it
    beginResume()
  }

  // pick the point of the path closest to the current eye so the return
  // trip is as short as possible
  function nearestRads (from, t) {
    let best = rads
    let bestD = Infinity
    const steps = 96
    for (let i = 0; i < steps; i++) {
      const r = (i / steps) * TAU
      pathEye(tmp, r, t)
      const dx = tmp[0] - from[0]
      const dy = tmp[1] - from[1]
      const dz = tmp[2] - from[2]
      const d = dx * dx + dy * dy + dz * dz
      if (d < bestD) {
        bestD = d
        best = r
      }
    }
    return best
  }

  function beginResume () {
    const e = camera.eye
    const c = camera.center // getter: look-at target
    for (let i = 0; i < 3; i++) {
      resumeEye[i] = e[i]
      resumeTarget[i] = c[i]
    }
    rads = nearestRads(resumeEye, roamTime)
    resumeT = 0
    state = 'resuming'
  }

  const smooth = (x) => x * x * (3 - 2 * x)

  // ---- kick nudge (damped spring, view space) -----------------------------

  const nudgeOffset = [0, 0, 0]
  const nudgeVel = [0, 0, 0]
  let nudgeCount = 0

  function nudge (amount = 0.05) {
    if (!(amount > 0)) return
    // velocity such that a critically damped spring peaks at ~amount
    const w = TAU * settings.nudgeFrequency
    const v = amount * w * Math.E
    // mostly a push toward the scene, with a small alternating sideways/vertical bob
    nudgeCount++
    const side = (nudgeCount & 1) ? 1 : -1
    nudgeVel[2] += v
    nudgeVel[1] += v * 0.25
    nudgeVel[0] += v * 0.12 * side
  }

  function stepNudge (dt) {
    const w = TAU * settings.nudgeFrequency
    const k = w * w
    const c = 2 * settings.nudgeDamping * w
    // fixed substeps for stability at low frame rates
    const n = Math.max(1, Math.ceil(dt / (1 / 240)))
    const h = dt / n
    for (let s = 0; s < n; s++) {
      for (let i = 0; i < 3; i++) {
        const a = -k * nudgeOffset[i] - c * nudgeVel[i]
        nudgeVel[i] += a * h // semi-implicit Euler
        nudgeOffset[i] += nudgeVel[i] * h
      }
    }
    for (let i = 0; i < 3; i++) {
      if (Math.abs(nudgeOffset[i]) < 1e-6 && Math.abs(nudgeVel[i]) < 1e-5) {
        nudgeOffset[i] = 0
        nudgeVel[i] = 0
      }
    }
  }

  // ---- per frame ----------------------------------------------------------

  function tick (opts) {
    const time = opts && typeof opts.time === 'number' ? opts.time : nowSec()
    let dt = lastTime === null ? 1 / 60 : time - lastTime
    lastTime = time
    if (!(dt >= 0)) dt = 0
    if (dt > 0.1) dt = 0.1

    camera.tick()
    // keep the camera (mostly) z-up
    cameraUp[0] = camera.up[0]
    cameraUp[1] = camera.up[1]
    cameraUp[2] = 999
    camera.up = cameraUp

    stepNudge(dt)

    if (!started) return
    stepShot(dt)

    if (!settings.roam) {
      if (state !== 'user') state = 'user'
    } else if (state === 'user' && !pointerDown &&
               nowSec() - lastInteraction >= settings.resumeDelay) {
      beginResume()
    }

    if (state === 'roaming') {
      roamTime += dt
      shotParams(params, rads)
      rads = (rads + settings.roamSpeed * params.speed * dt) % TAU
      pathEye(eye, rads, roamTime)
      pathTarget(target, roamTime, rads)
      camera.lookAt(eye, target)
      poseValid = checkPose()
    } else if (state === 'resuming') {
      resumeT += dt / Math.max(0.01, settings.resumeDuration)
      const s = smooth(Math.min(1, resumeT))
      // speed ramps up with the blend so the motion starts gently
      roamTime += dt * s
      shotParams(params, rads)
      rads = (rads + settings.roamSpeed * params.speed * dt * s) % TAU
      pathEye(tmp, rads, roamTime)
      for (let i = 0; i < 3; i++) eye[i] = resumeEye[i] + (tmp[i] - resumeEye[i]) * s
      pathTarget(tmp, roamTime, rads)
      for (let i = 0; i < 3; i++) target[i] = resumeTarget[i] + (tmp[i] - resumeTarget[i]) * s
      camera.lookAt(eye, target)
      poseValid = checkPose()
      if (resumeT >= 1) state = 'roaming'
    }
  }

  const outMatrix = new Float32Array(16)
  // The controls' own matrix is interpolated ~32 ms behind the poses we
  // set (3d-view-controls' delay): after a hard cut it would show one or two
  // in-between frames, a whip pan instead of a cut. So while we drive the
  // camera (roaming / resuming) the matrix comes straight from this frame's
  // eye / target (z up, as the controls keep it); the controls' matrix is
  // used while the user holds the camera. Resuming starts from the pose the
  // controls showed, so only grabbing the camera can step it by those
  // ~32 ms of roaming motion (sub-degree), and the user is moving it then.
  const directMatrix = new Float32Array(16)
  const zUp = [0, 0, 1]
  function getMatrix () {
    let m = camera.matrix
    if (started && state !== 'user' && poseValid) {
      lookAtMatrix(directMatrix, eye, target, zUp)
      m = directMatrix
    }
    for (let i = 0; i < 16; i++) outMatrix[i] = m[i]
    // view' = T(offset) * view : translate in view space
    outMatrix[12] += nudgeOffset[0]
    outMatrix[13] -= nudgeOffset[1]
    outMatrix[14] += nudgeOffset[2]
    return outMatrix
  }

  function getCenter () {
    return camera.center
  }

  function getState () {
    return state
  }

  return {
    tick,
    start,
    getMatrix,
    getCenter,
    getState,
    setShot,
    setFrame,
    cut,
    getShot: () => shot,
    hasVariation: () => !isIdentity(curVar),
    shots: CAMERA_SHOTS,
    nudge,
    kick: nudge,
    settings
  }
}
