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
// the eye, so the shot also takes in the far side of the history rings
// around the grid, where their lows face (0 = look at the centre).
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

// Adaptive framing per shot (see the framing section below). The framing
// is relative to each shot's own nominal framing of the whole fabric, so the
// shots' designed dollies and rises survive; [fmin, fmax] bound the distance
// factor so each shot keeps its character (wide stays wide, graze and dive
// keep their low / close feel and are barely touched), and `center` is the
// fraction of the fabric's off-centre offset that is corrected (wide and
// graze look past the centre on purpose, to take in the history rings,
// so they are only partly re-centred).
const SHOT_FRAMING = {
  classic: { fmin: 0.6, fmax: 1.5, center: 0.8 },
  wide: { fmin: 0.8, fmax: 1.4, center: 0.35 },
  top: { fmin: 0.6, fmax: 1.5, center: 0.9 },
  graze: { fmin: 0.95, fmax: 1.05, center: 0.3 },
  dive: { fmin: 0.9, fmax: 1.1, center: 0.7 }
}
function framingParams (o, name) {
  const f = SHOT_FRAMING[name]
  o.fmin = f.fmin; o.fmax = f.fmax; o.center = f.center
  return o
}

const PARAMS = ['rx', 'ry', 'z', 'tz', 'speed', 'drift', 'lookAhead', 'fmin', 'fmax', 'center']
const newParams = () => ({
  rx: 0, ry: 0, z: 0, tz: 0, speed: 1, drift: 1, lookAhead: 0, fmin: 0.6, fmax: 1.5, center: 1
})

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
    cutVariation: 1, // 0..1, how far a hard cut varies its shot's path
    // adaptive framing of the roaming path (see the framing section)
    autoFraming: true,
    // target extent of the lit fabric, relative to the shot's own framing of
    // the whole fabric: at 0.8 the lit part is framed like the whole fabric
    // (closer when only a part is lit), higher fills more, lower leaves room
    framingFill: 0.8,
    framingSpeed: 6 // s for the dolly / re-centring to settle (x 2 reduced motion)
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
    framingParams(pCur, shot)
    applyVariation(pCur, curVar)
    if (blendT >= 1) {
      for (const k of PARAMS) out[k] = pCur[k]
      return out
    }
    if (fromShot) {
      SHOTS[fromShot](pFrom, rads, fromTime)
      framingParams(pFrom, fromShot)
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
    framing.snap = true // a cut lands framed: no visible dolly after it
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
    const radius = frame.radius * framing.factor
    out[0] *= radius
    out[1] *= radius
    out[2] = out[2] * radius + frame.targetZ + frame.eyeRise
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
    const la = params.lookAhead * Math.max(0, settings.lookAhead) * frame.radius * framing.factor
    out[0] -= Math.sin(r) * la
    out[1] -= Math.cos(r) * la
    return out
  }

  // ---- adaptive framing ---------------------------------------------------
  //
  // index.js hands over a few world points of the deformed fabric
  // (setFramingPoints): the lit part of the base plane on the 3D shape, at
  // the floor and at a slow height estimate, plus a reference lattice of the
  // whole plane at the floor. Each frame both are projected (same fov as
  // the scene, unjittered): the lit points through the framed path pose,
  // the reference through the shot's own un-framed pose (factor 1, no
  // offset). The target is the reference's extent, so the whole fabric at
  // the default framingFill keeps each shot's nominal framing (its own dolly
  // and rise survive); only how the lit region deviates from the whole
  // fabric (music, shape morph) is corrected, by two slow critically damped
  // springs:
  //   - a distance factor on the path (like setFrame's radius: the path is
  //     scaled around the shape's centre, so the shot's angles are kept),
  //   - an offset of the look-at point in the camera's right / up plane
  //     (only the target moves: rotating never lowers the eye into the
  //     fabric on low shots).
  // Distance is smoothed in log space and bounded per shot. Only the
  // roaming path is adjusted: while the user holds the camera nothing is
  // measured, and resuming eases onto the framed path. A hard cut snaps the
  // framing for the new shot in the cut frame.
  const TAN_HALF_FOV = Math.tan(Math.PI / 8) // the scene's fov is PI / 4
  const FRAME_LIM = 2 // NDC clamp of the measured box (overflow saturates)
  const FILL_NOMINAL = 0.8 // framingFill that keeps the shots' own framing
  const framing = {
    factor: 1, // distance factor applied to the path
    logF: 0, // log of factor, and its spring velocity
    logV: 0,
    ox: 0, // look-at offset: right, in half-widths of the view at the target
    oy: 0, // up, in half-heights
    vx: 0,
    vy: 0,
    snap: true, // next update lands at once (first frame, after a cut)
    points: null,
    count: 0,
    refPoints: null,
    refCount: 0,
    aspect: 16 / 9,
    // last measurement
    ratio: 1, // current extent / target extent (> 1: too big)
    cx: 0, // off-centre offset of the lit fabric in the framed pose, NDC
    cy: 0,
    fill: 0, // measured extent, fraction of the frame on its fuller axis (GUI readout)
    fillRef: 0 // the whole fabric's extent in the shot's own pose
  }

  // points: flat array of xyz (count points), the lit fabric; refPoints /
  // refCount: the whole plane; aspect: canvas width / height
  const clampCount = (n, arr) => Math.max(0, Math.min(n | 0, arr ? Math.floor(arr.length / 3) : 0))
  function setFramingPoints (points, count, aspect, refPoints, refCount) {
    framing.points = points
    framing.count = clampCount(count, points)
    framing.refPoints = refPoints || null
    framing.refCount = clampCount(refCount, refPoints)
    if (aspect > 0 && isFinite(aspect)) framing.aspect = Math.min(Math.max(aspect, 0.2), 5)
  }

  const fF = [0, 0, 0]
  const fR = [0, 0, 0]
  const fU = [0, 0, 0]
  // camera basis of the pose (z up, as lookAtMatrix); false if degenerate
  function poseBasis (e, c) {
    let fx = c[0] - e[0]
    let fy = c[1] - e[1]
    let fz = c[2] - e[2]
    const fl = Math.hypot(fx, fy, fz)
    if (!(fl > 1e-6)) return 0
    fx /= fl; fy /= fl; fz /= fl
    // right = f x z
    let rx = fy
    let ry = -fx
    const rl = Math.hypot(rx, ry)
    if (!(rl > 1e-6)) return 0 // looking straight down: shots never do
    rx /= rl; ry /= rl
    fF[0] = fx; fF[1] = fy; fF[2] = fz
    fR[0] = rx; fR[1] = ry; fR[2] = 0
    // up = r x f
    fU[0] = ry * fz
    fU[1] = -rx * fz
    fU[2] = rx * fy - ry * fx
    return fl
  }

  // screen bounding box (NDC, clamped to +-FRAME_LIM) of n points seen from
  // the pose e -> c, into box; false if nothing projects
  const box = { minX: 0, maxX: 0, minY: 0, maxY: 0 }
  function projectBox (pts, n, e, c) {
    if (!n || !pts || !poseBasis(e, c)) return false
    const a = framing.aspect
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i < n; i++) {
      const dx = pts[i * 3] - e[0]
      const dy = pts[i * 3 + 1] - e[1]
      const dz = pts[i * 3 + 2] - e[2]
      const x = dx * fR[0] + dy * fR[1] + dz * fR[2]
      const y = dx * fU[0] + dy * fU[1] + dz * fU[2]
      // a point at or behind the eye is projected at a small positive depth:
      // it lands far off-screen on the axis it is really off on, and near
      // its real position on the other (no false overflow on both axes)
      const z = Math.max(dx * fF[0] + dy * fF[1] + dz * fF[2], 0.05)
      let nx = x / (z * TAN_HALF_FOV * a)
      let ny = y / (z * TAN_HALF_FOV)
      if (!isFinite(nx) || !isFinite(ny)) continue
      nx = Math.min(Math.max(nx, -FRAME_LIM), FRAME_LIM)
      ny = Math.min(Math.max(ny, -FRAME_LIM), FRAME_LIM)
      if (nx < minX) minX = nx
      if (nx > maxX) maxX = nx
      if (ny < minY) minY = ny
      if (ny > maxY) maxY = ny
    }
    if (!(maxX >= minX) || !(maxY >= minY)) return false
    box.minX = minX; box.maxX = maxX; box.minY = minY; box.maxY = maxY
    return true
  }
  // extent of the box on its fuller axis (full frame = 1): a roughly square
  // fabric is framed by the shorter side, a wide one (graze, a flat plane
  // seen low) by the width
  const boxFill = () => Math.max((box.maxX - box.minX) / 2, (box.maxY - box.minY) / 2)

  // measures the framed pose pe -> pt (the lit points) against the shot's
  // un-framed pose at (r, t) (the whole plane); fills framing.ratio / cx / cy
  const refEye = [0, 0, 0]
  const refTarget = [0, 0, 0]
  function measureFraming (pe, pt, r, t) {
    // the reference first: pathEye / pathTarget at factor 1, no offset
    let fillRef = 0
    if (framing.refCount) {
      const f = framing.factor
      framing.factor = 1
      pathEye(refEye, r, t)
      pathTarget(refTarget, t, r)
      framing.factor = f
      if (projectBox(framing.refPoints, framing.refCount, refEye, refTarget)) fillRef = boxFill()
    }
    if (!(fillRef > 0.02)) return false
    if (!projectBox(framing.points, framing.count, pe, pt)) return false
    const fill = boxFill()
    const target = Math.min(Math.max(fillRef * Number(settings.framingFill) / FILL_NOMINAL, 0.1), 2)
    // and never past the frame's edges, unless the shot's own framing
    // already overflows them (graze's near edge, dive's close-in)
    const ratio = Math.max(fill / target, fill / Math.max(1.02, fillRef))
    framing.fill = fill
    framing.fillRef = fillRef
    framing.ratio = isFinite(ratio) ? Math.min(Math.max(ratio, 0.4), 2.5) : 1
    // centre of the visible part of the box; an axis the fabric overflows
    // on both sides has no meaningful centre
    const vx0 = Math.max(box.minX, -1)
    const vx1 = Math.min(box.maxX, 1)
    const vy0 = Math.max(box.minY, -1)
    const vy1 = Math.min(box.maxY, 1)
    framing.cx = box.minX < -1 && box.maxX > 1 ? 0 : (vx0 + vx1) / 2
    framing.cy = box.minY < -1 && box.maxY > 1 ? 0 : (vy0 + vy1) / 2
    return true
  }

  // critically damped spring step of x toward goal (time constant tau),
  // exact for a constant goal: no overshoot, no pumping. Results in sp (no
  // per-frame allocation)
  const sp = { x: 0, v: 0 }
  function spring (x, v, goal, tau, dt) {
    const w = 1 / Math.max(tau, 1e-3)
    const d = x - goal
    const e = Math.exp(-w * dt)
    sp.x = goal + (d + (v + w * d) * dt) * e
    sp.v = (v - w * (v + w * d) * dt) * e
  }

  // framing goals from the last measurement (or identity when off)
  const goal = { logF: 0, ox: 0, oy: 0 }
  function framingGoal (measured) {
    if (!settings.autoFraming || !measured) {
      goal.logF = 0
      goal.ox = 0
      goal.oy = 0
      return
    }
    const lo = Math.log(Math.max(params.fmin, 0.1))
    const hi = Math.log(Math.max(params.fmax, params.fmin, 0.1))
    // projected size ~ 1 / distance: scale the distance by the ratio
    goal.logF = Math.min(Math.max(framing.logF + Math.log(framing.ratio), lo), hi)
    // a fraction k of the whole off-centre error: cx is measured with the
    // current offset applied, so ox + cx is about the un-offset error (the
    // offset moves the content at the target's depth by -ox); with k < 1
    // the shot keeps (1 - k) of its own look past the centre
    const k = Math.min(Math.max(params.center, 0), 1)
    goal.ox = Math.min(Math.max(k * (framing.ox + framing.cx), -0.6), 0.6)
    goal.oy = Math.min(Math.max(k * (framing.oy + framing.cy), -0.6), 0.6)
  }

  function applyFramingGoal () {
    framing.logF = goal.logF
    framing.ox = goal.ox
    framing.oy = goal.oy
    framing.logV = framing.vx = framing.vy = 0
    framing.factor = Math.exp(framing.logF)
  }

  // shifts the look-at point c (seen from e) by the framing offset
  function offsetTarget (e, c) {
    const d = poseBasis(e, c)
    if (!d || (framing.ox === 0 && framing.oy === 0)) return c
    const h = d * TAN_HALF_FOV
    const sx = framing.ox * h * framing.aspect
    const sy = framing.oy * h
    for (let i = 0; i < 3; i++) c[i] += fR[i] * sx + fU[i] * sy
    return c
  }

  // the framed roaming pose at (rads, t) into pe / pt
  function pathPose (pe, pt, r, t) {
    pathEye(pe, r, t)
    pathTarget(pt, t, r)
    offsetTarget(pe, pt)
  }

  // measures the path pose and steps the springs; a snap (cut, first frame)
  // iterates measure -> apply a few times so the new shot lands framed
  function updateFraming (pe, pt, r, t, dt, reducedMotion) {
    // nothing to measure when off: the springs ease back to the plain path
    const measure = () => settings.autoFraming && measureFraming(pe, pt, r, t)
    if (framing.snap) {
      framing.snap = false
      for (let k = 0; k < 4; k++) {
        framingGoal(measure())
        applyFramingGoal()
        pathPose(pe, pt, r, t)
      }
      return
    }
    framingGoal(measure())
    // the springs' time constant: framingSpeed is roughly the settle time
    const tau = Math.max(0.5, Number(settings.framingSpeed) || 6) / 4 * (reducedMotion ? 2 : 1)
    spring(framing.logF, framing.logV, goal.logF, tau, dt)
    framing.logF = sp.x; framing.logV = sp.v
    spring(framing.ox, framing.vx, goal.ox, tau, dt)
    framing.ox = sp.x; framing.vx = sp.v
    spring(framing.oy, framing.vy, goal.oy, tau, dt)
    framing.oy = sp.x; framing.vy = sp.v
    if (!isFinite(framing.logF) || !isFinite(framing.logV)) framing.logF = framing.logV = 0
    if (!isFinite(framing.ox) || !isFinite(framing.vx)) framing.ox = framing.vx = 0
    if (!isFinite(framing.oy) || !isFinite(framing.vy)) framing.oy = framing.vy = 0
    framing.factor = Math.exp(framing.logF)
    // the next frame's path uses the new state; this frame keeps its pose
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
  const tmpTarget = [0, 0, 0]
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

    const reducedMotion = !!(opts && opts.reducedMotion)
    if (state === 'roaming') {
      roamTime += dt
      shotParams(params, rads)
      rads = (rads + settings.roamSpeed * params.speed * dt) % TAU
      pathPose(eye, target, rads, roamTime)
      updateFraming(eye, target, rads, roamTime, dt, reducedMotion)
      camera.lookAt(eye, target)
      poseValid = checkPose()
    } else if (state === 'resuming') {
      resumeT += dt / Math.max(0.01, settings.resumeDuration)
      const s = smooth(Math.min(1, resumeT))
      // speed ramps up with the blend so the motion starts gently
      roamTime += dt * s
      shotParams(params, rads)
      rads = (rads + settings.roamSpeed * params.speed * dt * s) % TAU
      // framing follows the path pose, not the blended one (which starts
      // from wherever the user left the camera)
      pathPose(tmp, tmpTarget, rads, roamTime)
      updateFraming(tmp, tmpTarget, rads, roamTime, dt, reducedMotion)
      for (let i = 0; i < 3; i++) eye[i] = resumeEye[i] + (tmp[i] - resumeEye[i]) * s
      for (let i = 0; i < 3; i++) target[i] = resumeTarget[i] + (tmpTarget[i] - resumeTarget[i]) * s
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
    setFramingPoints,
    getFraming: () => framing,
    cut,
    getShot: () => shot,
    hasVariation: () => !isIdentity(curVar),
    shots: CAMERA_SHOTS,
    nudge,
    kick: nudge,
    settings
  }
}
