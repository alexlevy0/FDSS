// Makes tweakable settings wander slightly around their value over time.
//
// Each registered parameter moves in straight lines (linear interpolation)
// from one random offset to the next, within ±amount of its base value.
// Every parameter has its own segment length so they never move in sync.
//
// The base is the value at registration (the default). If the user moves a
// slider in the GUI, that new value becomes the base: the drift continues
// around what they picked instead of fighting it.
//
// Usage:
//   const drift = createSettingsDrift()
//   drift.add(gui.add(settings, 'exposure', 0.1, 3))        // ±amount of 0.75
//   drift.add(controller, { amount: 0.015, absolute: true }) // ±0.015
//   drift.update(dt, guiVisible) // once per frame

export default function createSettingsDrift (opts = {}) {
  const settings = {
    enabled: opts.enabled !== false,
    amount: opts.amount ?? 0.1, // ±10% of each base value
    period: opts.period ?? 20 // average seconds per linear segment
  }
  const params = []
  // amount actually applied: eases toward settings.amount so moving the
  // "amount" slider widens/narrows the drift smoothly instead of jumping
  let effectiveAmount = settings.amount

  function randomOffset () {
    return Math.random() * 2 - 1
  }

  function newSegment (p) {
    p.from = p.to
    p.to = randomOffset()
    p.t = 0
    // 70%..130% of the period, so the parameters stay out of phase. Stored
    // as a factor so a new period applies at once (only the speed changes)
    p.factor = 0.7 + Math.random() * 0.6
  }

  // start every parameter again from its base, moving away linearly
  function restart (p) {
    p.to = 0
    newSegment(p)
    p.from = 0
  }

  // controller: a lil-gui number controller (object, property, _min, _max)
  // options.amount: override the relative amount for this parameter
  // options.absolute: amount is an absolute ± range instead of a fraction
  function add (controller, options = {}) {
    const object = controller.object
    const property = controller.property
    const base = object[property]
    if (typeof base !== 'number' || !isFinite(base)) return controller
    // the drifting values are not on the slider's step grid: show them with
    // as many decimals as the step has, not 16 digits
    const step = controller._step
    if (typeof controller.decimals === 'function' && step > 0 && isFinite(step)) {
      const s = String(step)
      const decimals = s.includes('e-') ? Number(s.split('e-')[1]) : (s.split('.')[1] || '').length
      controller.decimals(Math.min(decimals + 1, 6))
    }
    const p = {
      controller,
      object,
      property,
      base,
      min: isFinite(controller._min) ? controller._min : -Infinity,
      max: isFinite(controller._max) ? controller._max : Infinity,
      amount: options.amount,
      absolute: !!options.absolute,
      from: 0,
      to: 0,
      t: 0,
      factor: 1,
      written: base
    }
    // start from the default, then head somewhere, part-way through a
    // segment so every parameter starts moving at once but not in phase
    restart(p)
    p.t = Math.random() * 0.5
    params.push(p)
    return controller
  }

  function range (p) {
    // per-parameter overrides scale with the global amount (default 0.1)
    const scale = effectiveAmount / 0.1
    return p.absolute ? p.amount * scale : Math.abs(p.base) * (p.amount ?? 0.1) * scale
  }

  function update (dt, guiVisible) {
    dt = Math.min(Math.max(dt || 0, 0), 0.1)
    effectiveAmount += (settings.amount - effectiveAmount) * (1 - Math.exp(-dt / 1.5))
    for (let i = 0; i < params.length; i++) {
      const p = params[i]
      const current = p.object[p.property]
      // the user changed it from the GUI: re-centre on their value
      if (current !== p.written) {
        p.base = current
        restart(p)
      }
      let value = p.base
      if (settings.enabled) {
        p.t += dt / Math.max(settings.period * p.factor, 0.1)
        if (p.t >= 1) newSegment(p)
        const offset = p.from + (p.to - p.from) * p.t
        value = p.base + offset * range(p)
      }
      value = Math.min(p.max, Math.max(p.min, value))
      p.object[p.property] = value
      p.written = value
      if (guiVisible) p.controller.updateDisplay()
    }
  }

  // put every parameter back on its base value (used when disabling); when
  // re-enabled they leave the base linearly instead of popping back
  function reset () {
    for (const p of params) {
      restart(p)
      p.object[p.property] = p.base
      p.written = p.base
      p.controller.updateDisplay()
    }
  }

  return { settings, add, update, reset }
}
