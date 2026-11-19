import createCamera from '3d-view-controls'

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

export default function createRoamingCamera (canvas, initialEye, initialTarget) {
  const settings = {
    roam: true,
    roamSpeed: 0.084, // rad/s: one revolution in ~75 s (old 0.0014 rad/frame at 60fps)
    resumeDelay: 6, // seconds of inactivity before roaming resumes
    resumeDuration: 4, // seconds to ease back onto the path
    drift: 1, // drift amplitude multiplier (0 = perfect ellipse)
    nudgeFrequency: 2.4, // Hz of the kick spring
    nudgeDamping: 0.55 // damping ratio of the kick spring (<1 overshoots a bit)
  }

  const camera = createCamera(canvas, {
    zoomSpeed: 4,
    rotateSpeed: 4,
    zoomMin: -1,
    zoomMax: 0
  })

  camera.lookAt(initialEye, initialTarget, [0, 0, 1])

  // ---- roaming path -------------------------------------------------------

  function ellipse (out, rads) {
    out[0] = Math.sin(rads) * 1.5
    out[1] = Math.cos(rads) * 2.7
    out[2] = (Math.sin(rads) * 0.5 + 0.5) * 3 + 0.5
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

  const tmpDrift = new Float64Array(3)
  function pathEye (out, rads, t) {
    ellipse(out, rads)
    drift(tmpDrift, t, settings.drift)
    out[0] += tmpDrift[0]
    out[1] += tmpDrift[1]
    out[2] += tmpDrift[2]
    return out
  }
  function pathTarget (out, t) {
    return targetDrift(out, t, settings.drift)
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

    if (!settings.roam) {
      if (state !== 'user') state = 'user'
    } else if (state === 'user' && !pointerDown &&
               nowSec() - lastInteraction >= settings.resumeDelay) {
      beginResume()
    }

    if (state === 'roaming') {
      roamTime += dt
      rads = (rads + settings.roamSpeed * dt) % TAU
      pathEye(eye, rads, roamTime)
      pathTarget(target, roamTime)
      camera.lookAt(eye, target)
    } else if (state === 'resuming') {
      resumeT += dt / Math.max(0.01, settings.resumeDuration)
      const s = smooth(Math.min(1, resumeT))
      // speed ramps up with the blend so the motion starts gently
      roamTime += dt * s
      rads = (rads + settings.roamSpeed * dt * s) % TAU
      pathEye(tmp, rads, roamTime)
      for (let i = 0; i < 3; i++) eye[i] = resumeEye[i] + (tmp[i] - resumeEye[i]) * s
      pathTarget(tmp, roamTime)
      for (let i = 0; i < 3; i++) target[i] = resumeTarget[i] + (tmp[i] - resumeTarget[i]) * s
      camera.lookAt(eye, target)
      if (resumeT >= 1) state = 'roaming'
    }
  }

  const outMatrix = new Float32Array(16)
  function getMatrix () {
    const m = camera.matrix
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
    nudge,
    kick: nudge,
    settings
  }
}
