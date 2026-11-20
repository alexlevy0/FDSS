// Turns the raw analyser spectrum into features the visuals can use:
//
//   bands     log-spaced bands (~30 Hz .. ~16 kHz), each normalised 0..1 by
//             its own automatic gain control, so a quiet passage of an
//             hour-long mix still moves the fabric
//   bass / mid / treble / energy   smoothed aggregates, 0..1
//   kick      0..1 envelope: jumps to 1 on a low-end onset, then decays
//   onKick    true only on the frame an onset is detected
//   snare / onSnare   same for snares / claps (broadband mid flux plus a
//             noisy 2-6 kHz component), kept apart from the kick
//   hat / onHat       same for hi-hats (treble flux above ~6 kHz)
//   bandsL / bandsR   the same bands for each channel (own AGC); `bands`
//             is the mono mix (average of both channels). With a mono
//             source all three are identical.
//   section, sectionName, onSectionChange, tension, bpm, bpmConfidence,
//   beatPhase, beat, onBeat, onBar, onPhrase   see music-structure.js
//
// index.js calls update(dt) once per frame and hands `features` around.

import createMusicStructure from './music-structure'

const DEFAULTS = {
  bandCount: 200, // fixed at creation
  minFreq: 30,
  maxFreq: 16000,

  // AGC
  agcAmount: 0.65, // 0 = raw level, 1 = fully normalised per band
  agcRelease: 12, // seconds for a band's running max to halve its excess
  agcFloorRise: 0.04, // how fast (units/s) the per-band floor creeps back up
  maxGain: 4, // never amplify a band more than this (keeps noise as noise)
  noiseGate: 0.06, // mean raw level under which everything fades out

  // aggregates smoothing (seconds)
  attack: 0.04,
  release: 0.25,

  // kick detection
  kickLowFreq: 35,
  kickHighFreq: 150,
  kickSensitivity: 1.6, // flux must exceed mean + sensitivity * stddev
  kickMinFlux: 0.015, // absolute floor on the flux (per band, per frame)
  kickRefractory: 0.25, // seconds between two onsets
  kickDecay: 0.3, // seconds for the envelope to (nearly) vanish

  // snare / clap detection: positive flux of the body (mid band) blended
  // with the noise burst (2-6 kHz) that tells a snare from a tom or a bass
  // note. Band layout fixed at creation, like the kick's.
  snareLowFreq: 150,
  snareHighFreq: 2500,
  snareNoiseLowFreq: 2000,
  snareNoiseHighFreq: 6000,
  snareNoiseWeight: 0.5, // 0 = body only, 1 = noise only
  snareSensitivity: 1.8,
  snareMinFlux: 0.012,
  snareRefractory: 0.12,
  snareDecay: 0.35,
  // a kick also splashes into the mids: a snare candidate this soon after a
  // kick must beat its threshold by snareKickMargin AND show its own noise
  // burst, so a plain kick never fires the snare too
  snareKickWindow: 0.07, // s
  snareKickMargin: 1.6,

  // hi-hat detection: flux above hatLowFreq (to maxFreq)
  hatLowFreq: 6000,
  hatSensitivity: 1.5,
  hatMinFlux: 0.01,
  hatRefractory: 0.06, // 16ths at 175 bpm are ~86 ms apart
  hatDecay: 0.12
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)

export default function createAnalysis (audio, opts = {}) {
  opts = Object.assign({}, DEFAULTS, opts)
  const analyser = audio.analyser
  const sampleRate = audio.sampleRate || 44100
  const binCount = analyser.frequencyBinCount
  const binHz = sampleRate / analyser.fftSize
  const bandCount = opts.bandCount | 0

  // --- band layout --------------------------------------------------------
  // Each band covers [lo, hi) in fractional bin units. Bands narrower than a
  // bin (the low end) interpolate between bins; wider ones average them.
  const maxFreq = Math.min(opts.maxFreq, sampleRate / 2 - binHz)
  const bandLo = new Float32Array(bandCount)
  const bandHi = new Float32Array(bandCount)
  const bandFreq = new Float32Array(bandCount)
  const ratio = maxFreq / opts.minFreq
  for (let i = 0; i < bandCount; i++) {
    const f0 = opts.minFreq * Math.pow(ratio, i / bandCount)
    const f1 = opts.minFreq * Math.pow(ratio, (i + 1) / bandCount)
    bandLo[i] = f0 / binHz
    bandHi[i] = f1 / binHz
    bandFreq[i] = Math.sqrt(f0 * f1)
  }

  const bandRange = (fLo, fHi) => {
    let a = bandCount
    let b = 0
    for (let i = 0; i < bandCount; i++) {
      if (bandFreq[i] >= fLo && bandFreq[i] < fHi) {
        a = Math.min(a, i)
        b = Math.max(b, i + 1)
      }
    }
    return a < b ? [a, b] : [0, 1]
  }
  const bassRange = bandRange(0, 250)
  const midRange = bandRange(250, 2000)
  const trebleRange = bandRange(2000, Infinity)
  const kickRange = bandRange(opts.kickLowFreq, opts.kickHighFreq)
  // the percussion ranges may not exist at all (low sample rate, maxFreq
  // under the hat range): null disables that detector instead of falling
  // back to the first band like bandRange does
  const optRange = (fLo, fHi) => {
    const r = bandRange(fLo, fHi)
    return r[0] === 0 && r[1] === 1 && !(bandFreq[0] >= fLo && bandFreq[0] < fHi) ? null : r
  }
  const snareBodyRange = optRange(opts.snareLowFreq, opts.snareHighFreq)
  const snareNoiseRange = optRange(opts.snareNoiseLowFreq, opts.snareNoiseHighFreq)
  const hatRange = optRange(opts.hatLowFreq, Infinity)

  // --- state --------------------------------------------------------------
  const raw = new Float32Array(bandCount) // 0..~1.3, from dB (mono)
  const prevRaw = new Float32Array(bandCount)
  const rawL = new Float32Array(bandCount)
  const rawR = new Float32Array(bandCount)
  // per-band AGC state and output, for mono / left / right
  const createAgc = () => ({
    runMax: new Float32Array(bandCount).fill(0.5),
    runMin: new Float32Array(bandCount),
    out: new Float32Array(bandCount)
  })
  const agcMono = createAgc()
  const agcL = createAgc()
  const agcR = createAgc()
  const bands = agcMono.out

  let gate = 0
  let fluxMean = 0
  let fluxVar = 0
  let sinceKick = Infinity
  // adaptive threshold state of the other onset detectors: exponential
  // moving mean / variance of their flux over ~1 s, time since the last
  // onset
  const createOnsetState = () => ({ mean: 0, variance: 0, since: Infinity })
  const snareState = createOnsetState()
  const snareNoiseState = createOnsetState() // the noise part alone
  const hatState = createOnsetState()

  const features = {
    bands,
    bandsL: agcL.out,
    bandsR: agcR.out,
    stereo: !!(audio.floatFrequenciesR && audio.analyserR),
    bandCount,
    bass: 0,
    mid: 0,
    treble: 0,
    energy: 0,
    kick: 0,
    onKick: false,
    snare: 0,
    onSnare: false,
    hat: 0,
    onHat: false
  }

  const smooth = (prev, target, dt) => {
    const tau = target > prev ? opts.attack : opts.release
    return prev + (target - prev) * (1 - Math.exp(-dt / Math.max(tau, 1e-3)))
  }

  const mean = (arr, [a, b]) => {
    let s = 0
    for (let i = a; i < b; i++) s += arr[i]
    return s / (b - a)
  }

  // mean positive spectral flux (raw levels) over a band range
  function rangeFlux (r) {
    if (!r) return 0
    let f = 0
    for (let i = r[0]; i < r[1]; i++) {
      const d = raw[i] - prevRaw[i]
      if (d > 0) f += d
    }
    return f / (r[1] - r[0])
  }

  // updates the moving stats of `state` with this frame's flux; returns how
  // far the flux is above mean + sensitivity * std (in flux units, <= 0 =
  // no onset), computed BEFORE the stats absorb this frame (as the kick)
  function onsetExcess (state, flux, sensitivity, dt) {
    const std = Math.sqrt(Math.max(state.variance, 0))
    const excess = flux - (state.mean + sensitivity * std)
    const a = 1 - Math.exp(-dt / 1.0)
    const diff = flux - state.mean
    state.mean += a * diff
    state.variance = (1 - a) * (state.variance + a * diff * diff)
    // a NaN would latch the detector off for good
    if (!(state.mean === state.mean) || !(state.variance === state.variance)) {
      state.mean = 0
      state.variance = 0
    }
    return excess === excess ? excess : -1
  }

  // exp decay reaching ~5% after `decay` seconds
  const decayEnv = (env, decay, dt) => env * Math.exp((-3 * dt) / Math.max(decay, 0.01))

  // spectrum (dB) -> raw band levels in `out`; returns their mean
  function readRaw (db, out) {
    const minDb = analyser.minDecibels
    const span = analyser.maxDecibels - minDb
    const level = (k) => {
      const v = db[k]
      // -Infinity on true silence, NaN never expected but guard anyway
      if (!(v > minDb)) return 0
      return Math.min((v - minDb) / span, 1.3)
    }
    let total = 0
    for (let i = 0; i < bandCount; i++) {
      const lo = bandLo[i]
      const hi = bandHi[i]
      let v
      if (hi - lo < 1) {
        const c = Math.min((lo + hi) * 0.5, binCount - 1.001)
        const k = Math.floor(c)
        const t = c - k
        v = level(k) * (1 - t) + level(k + 1) * t
      } else {
        const k0 = Math.floor(lo)
        const k1 = Math.min(Math.ceil(hi), binCount)
        let s = 0
        for (let k = k0; k < k1; k++) s += level(k)
        v = s / Math.max(1, k1 - k0)
      }
      out[i] = v
      total += v
    }
    return total / bandCount
  }

  function readChannels () {
    const levelL = readRaw(audio.floatFrequencies(), rawL)
    const dbR = features.stereo ? audio.floatFrequenciesR() : null
    const levelR = dbR ? readRaw(dbR, rawR) : 0
    // a mono file leaves the splitter's second output silent (and a lone
    // silent channel is not worth showing): use the other channel for it
    if (!dbR || levelR < levelL * 0.15) rawR.set(rawL)
    else if (levelL < levelR * 0.15) rawL.set(rawR)
    for (let i = 0; i < bandCount; i++) {
      prevRaw[i] = raw[i]
      raw[i] = (rawL[i] + rawR[i]) * 0.5
    }
  }

  // per-band AGC of `src` into agc.out
  function applyAgc (src, agc, dt) {
    const maxDecay = Math.pow(0.5, dt / Math.max(opts.agcRelease, 0.1))
    const minRange = 1 / Math.max(opts.maxGain, 1)
    const amount = opts.agcAmount
    const runMax = agc.runMax
    const runMin = agc.runMin
    const out = agc.out
    for (let i = 0; i < bandCount; i++) {
      const v = src[i]
      // the running max decays toward the floor, and jumps up on peaks
      const floor = runMin[i]
      runMax[i] = Math.max(v, floor + (runMax[i] - floor) * maxDecay)
      // the floor follows dips at once, creeps back up slowly; it is only
      // allowed to remove the bottom half of the dynamic range
      runMin[i] = Math.min(v, runMin[i] + opts.agcFloorRise * dt, runMax[i] * 0.5)
      const range = Math.max(runMax[i] - runMin[i], minRange)
      const normalised = clamp01((v - runMin[i]) / range)
      out[i] = (clamp01(v) * (1 - amount) + normalised * amount) * gate
    }
  }

  function update (dt) {
    dt = Math.min(Math.max(dt || 0, 0), 0.1)
    readChannels()

    // noise gate on the overall level, smoothed so it never pops
    let total = 0
    for (let i = 0; i < bandCount; i++) total += raw[i]
    const level = total / bandCount
    const gateTarget = clamp01((level - opts.noiseGate * 0.5) / (opts.noiseGate * 0.5 || 1e-3))
    gate += (gateTarget - gate) * (1 - Math.exp(-dt / 0.15))

    // per-band AGC: mono (used by everything) and each channel
    applyAgc(raw, agcMono, dt)
    applyAgc(rawL, agcL, dt)
    applyAgc(rawR, agcR, dt)

    // aggregates
    features.bass = smooth(features.bass, mean(bands, bassRange), dt)
    features.mid = smooth(features.mid, mean(bands, midRange), dt)
    features.treble = smooth(features.treble, mean(bands, trebleRange), dt)
    let all = 0
    for (let i = 0; i < bandCount; i++) all += bands[i]
    features.energy = smooth(features.energy, all / bandCount, dt)

    // kick: positive spectral flux over the low bands vs its moving stats
    let flux = 0
    for (let i = kickRange[0]; i < kickRange[1]; i++) {
      const d = raw[i] - prevRaw[i]
      if (d > 0) flux += d
    }
    flux /= kickRange[1] - kickRange[0]

    sinceKick += dt
    const std = Math.sqrt(Math.max(fluxVar, 0))
    const isOnset =
      gate > 0.5 &&
      sinceKick >= opts.kickRefractory &&
      flux > opts.kickMinFlux &&
      flux > fluxMean + opts.kickSensitivity * std

    // moving mean / variance over ~1s (exponential)
    const a = 1 - Math.exp(-dt / 1.0)
    const diff = flux - fluxMean
    fluxMean += a * diff
    fluxVar = (1 - a) * (fluxVar + a * diff * diff)

    features.onKick = isOnset
    if (isOnset) {
      sinceKick = 0
      features.kick = 1
    } else {
      // exp decay reaching ~5% after kickDecay seconds
      features.kick *= Math.exp((-3 * dt) / Math.max(opts.kickDecay, 0.01))
    }

    // snare / clap: body + noise flux. Its threshold is mean + k * std of
    // the blend, so steady mids (pads, vocals) do not trigger it; the
    // noise part must also be rising on its own within the kick window
    const noiseW = clamp01(opts.snareNoiseWeight)
    const bodyFlux = rangeFlux(snareBodyRange)
    const noiseFlux = rangeFlux(snareNoiseRange)
    const snareFlux = bodyFlux * (1 - noiseW) + noiseFlux * noiseW
    snareState.since += dt
    const snareStd = Math.sqrt(Math.max(snareState.variance, 0))
    const snareThreshold = snareState.mean + opts.snareSensitivity * snareStd
    const snareExcess = onsetExcess(snareState, snareFlux, opts.snareSensitivity, dt)
    const noiseExcess = onsetExcess(snareNoiseState, noiseFlux, 1, dt)
    const nearKick = sinceKick < opts.snareKickWindow
    const isSnare =
      !!snareBodyRange &&
      gate > 0.5 &&
      snareState.since >= opts.snareRefractory &&
      snareFlux > opts.snareMinFlux &&
      snareExcess > 0 &&
      (!nearKick ||
        (noiseExcess > 0 && snareFlux > snareThreshold * Math.max(1, opts.snareKickMargin)))
    features.onSnare = isSnare
    if (isSnare) {
      snareState.since = 0
      features.snare = 1
    } else {
      features.snare = decayEnv(features.snare, opts.snareDecay, dt)
    }

    // hi-hats: treble flux only (kicks and snares barely reach > 6 kHz,
    // and an open hat or a cymbal is still one rising edge)
    const hatFlux = rangeFlux(hatRange)
    hatState.since += dt
    const hatExcess = onsetExcess(hatState, hatFlux, opts.hatSensitivity, dt)
    const isHat =
      !!hatRange &&
      gate > 0.5 &&
      hatState.since >= opts.hatRefractory &&
      hatFlux > opts.hatMinFlux &&
      hatExcess > 0
    features.onHat = isHat
    if (isHat) {
      hatState.since = 0
      features.hat = 1
    } else {
      features.hat = decayEnv(features.hat, opts.hatDecay, dt)
    }

    // sections and tempo, from the raw (pre-AGC) levels: the AGC would
    // flatten exactly the long-term changes they look for
    structure.update(dt, level, mean(raw, bassRange), gate, isOnset)
  }

  const structure = createMusicStructure(features)

  return {
    update,
    features,
    opts,
    bandFreq,
    // music-structure settings (sections, tempo)
    structureOpts: structure.opts,
    // forget the sections / tempo history (e.g. on track change)
    resetStructure: structure.reset
  }
}
