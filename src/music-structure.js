// Slow, "story of the mix" features, computed from the per-frame analysis:
//
// Sections
//   section   { breakdown, build, drop, groove }: smoothed weights, 0..1,
//             summing to 1. `groove` is the neutral state (the mix running
//             at its usual level), so a long steady passage does not count
//             as a drop. Weights move over a few seconds, never flicker.
//   sectionName      dominant section ('breakdown' | 'build' | 'drop' | 'groove')
//   onSectionChange  true on the frame the dominant section changes (with
//                    hysteresis and a minimum duration)
//   tension   0..1: builds up during breakdowns / builds, released by drops
//
//   The short-term level (~2 s) is compared with a long-term background
//   (rises in ~20 s, falls in ~90 s, so it remembers the groove through a
//   breakdown), in units of its own typical deviation:
//     breakdown = level and especially bass clearly under the background,
//                 or the kicks gone
//     build     = level rising for several seconds without the bass back
//     drop      = bass / level back at or above the background while there
//                 is tension (right after a build or a breakdown)
//
// Tempo
//   bpm, bpmConfidence (0..1)  from the kick onsets of the last ~12 s:
//             every pair of onsets votes for the periods it is a multiple
//             of (70..180 BPM), shorter multiples weigh more
//   beatPhase 0..1 within the beat, onBeat / onBar (4 beats) /
//             onPhrase (opts.phraseBeats), beat (running beat index)
//   The beat clock free-runs at the current tempo; kicks only pull its phase
//   gently (spread over a few frames), so it keeps going through
//   breakdowns and re-locks smoothly when the kicks come back.
//
// The input clock only advances while the music is audible, so pausing
// does not expire the tempo nor push the sections around.

const DEFAULTS = {
  // sections
  sectionShort: 2, // s, short-term level
  sectionMid: 6, // s, reference for the trend (build)
  sectionLongRise: 20, // s, background follows rising levels
  sectionLongFall: 90, // s, and falls slowly (remembers the groove)
  sectionSmoothing: 2.5, // s, weights smoothing
  sectionMinDuration: 8, // s, minimum time before the dominant changes again
  sectionSensitivity: 1, // > 1 detects smaller level changes
  sectionWarmup: 15, // s of audible music before sections can leave groove

  // tempo
  minBpm: 70,
  maxBpm: 180,
  tempoWindow: 12, // s of kick onsets used for the estimate
  phraseBeats: 16, // beats per phrase (onPhrase)
  beatLock: 0.3 // how hard each kick pulls the beat clock's phase (0..1)
}

const SECTION_NAMES = ['breakdown', 'build', 'drop', 'groove']
const GROOVE_BASELINE = 0.35 // raw score of the neutral state

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)
const ease = (dt, tau) => 1 - Math.exp(-dt / Math.max(tau, 1e-3))

export default function createMusicStructure (features, opts = {}) {
  opts = Object.assign({}, DEFAULTS, opts)

  const section = { breakdown: 0, build: 0, drop: 0, groove: 1 }
  Object.assign(features, {
    section,
    sectionName: 'groove',
    onSectionChange: false,
    tension: 0,
    bpm: 120,
    bpmConfidence: 0,
    beatPhase: 0,
    beat: 0,
    onBeat: false,
    onBar: false,
    onPhrase: false
  })

  // --- section state ------------------------------------------------------
  let started = false
  let audible = 0 // seconds of audible music since the last reset
  let eS, eM, eL, bS, bL // level / bass: short, mid, long
  let varE, varB // running variance of short - long
  let trend = 0
  let kickRateS = 0 // kicks per second, ~3 s
  let kickRateL = 0 // ~30 s
  let tension = 0
  let current = 'groove'
  let held = 0 // seconds since the dominant last changed
  let challenger = null // section leading the current one
  let challenged = 0 // seconds it has been leading
  const scores = { breakdown: 0, build: 0, drop: 0, groove: 1 }

  // --- tempo state ----------------------------------------------------------
  let clock = 0 // audible seconds
  const kicks = [] // onset times (clock), oldest first
  let estimateTimer = 0
  let locked = false
  let bpmTarget = 120
  let candidate = 0
  let candidateCount = 0
  let confTarget = 0
  let beatPos = 0 // running beat position (beats)
  let pendingShift = 0 // phase correction still to apply (beats)
  const STEP = 0.5 // BPM resolution of the candidate grid
  const MAX_PAIRS = 1024
  const deltas = new Float32Array(MAX_PAIRS)
  let candScores = new Float32Array(1)

  // A new track: everything learnt from the previous one is dropped. The
  // section weights are not snapped: with the warm-up restarted (and no
  // tension) the scores are plain groove, so the weights ease back to it
  // over sectionSmoothing, and the dominant section may follow as soon as
  // groove leads (no minimum duration inherited from the old track).
  function reset () {
    started = false
    audible = 0
    trend = 0
    kickRateS = kickRateL = 0
    tension = features.tension = 0
    held = opts.sectionMinDuration
    challenger = null
    challenged = 0
    features.onSectionChange = false
    // tempo: no lock, no confidence (so phrase-driven consumers fall back to
    // their timers right away), the beat clock restarts at beat 0 and the
    // next estimate runs as soon as there are enough kicks
    kicks.length = 0
    estimateTimer = 0
    confTarget = 0
    features.bpmConfidence = 0
    locked = false
    candidate = 0
    candidateCount = 0
    bpmTarget = features.bpm
    pendingShift = 0
    beatPos = 0
    features.beatPhase = 0
    features.beat = 0
    features.onBeat = features.onBar = features.onPhrase = false
  }

  // ------------------------------------------------------------------------
  function updateSections (dt, level, bass, onKick) {
    if (!started) {
      eS = eM = eL = level
      bS = bL = bass
      varE = 0.03 * 0.03
      varB = 0.04 * 0.04
      started = true
    }
    audible += dt

    eS += (level - eS) * ease(dt, opts.sectionShort)
    eM += (level - eM) * ease(dt, opts.sectionMid)
    bS += (bass - bS) * ease(dt, opts.sectionShort)
    eL += (eS - eL) * ease(dt, eS > eL ? opts.sectionLongRise : opts.sectionLongFall)
    bL += (bS - bL) * ease(dt, bS > bL ? opts.sectionLongRise : opts.sectionLongFall)

    // kick rates (kicks per second), exponential windows
    kickRateS *= Math.exp(-dt / 5)
    kickRateL *= Math.exp(-dt / 30)
    if (onKick) {
      kickRateS += 1 / 5
      kickRateL += 1 / 30
    }

    const dE = eS - eL
    const dB = bS - bL
    varE += (dE * dE - varE) * ease(dt, 60)
    varB += (dB * dB - varB) * ease(dt, 60)
    // raw levels are dB / 70 (0.014 ~ 1 dB). The floors keep ordinary
    // groove variations (a couple of dB) well under one unit; only very
    // dynamic mixes widen the scale further.
    const scaleE = Math.min(Math.max(Math.sqrt(varE), 0.04), 0.12) // >= ~3 dB
    const scaleB = Math.min(Math.max(Math.sqrt(varB), 0.06), 0.16) // >= ~4 dB
    const sens = Math.max(opts.sectionSensitivity, 0.05)
    const zE = (dE / scaleE) * sens
    const zB = (dB / scaleB) * sens
    // a linear ramp of slope k puts eS - eM at ~k * (mid - short): with the
    // defaults, a 7 dB rise over 15 s gives ~1.9 dB, i.e. trend ~1.3. The
    // slow smoothing tells a sustained rise from a step (a new element)
    trend += (((eS - eM) / 0.02) * sens - trend) * ease(dt, 3)

    // the kicks went away (only meaningful if there were kicks before)
    const kickGone = kickRateL > 0.5 ? clamp01(1 - kickRateS / (0.5 * kickRateL)) : 0

    const low = clamp01((-(0.65 * zB + 0.35 * zE) - 0.6) / 1.2)
    const bassUp = clamp01(0.7 * zB + 0.3 * zE + 0.5)
    const warm = clamp01(audible / Math.max(opts.sectionWarmup, 0.1))

    // rising, but not because the bass is already back (that is the drop)
    scores.build = warm * clamp01((trend - 0.6) / 1.0) * (1 - 0.7 * clamp01(zB - 0.3))
    // a build out of a breakdown is still quiet: let the build take over
    scores.breakdown = warm * clamp01(0.8 * low + 0.35 * kickGone) * (1 - 0.6 * scores.build)
    scores.drop = warm * bassUp * tension * (1 - 0.7 * kickGone)
    // with tension in the air the plain groove is less likely
    scores.groove = GROOVE_BASELINE * (1 - 0.5 * tension)

    let sum = 0
    for (let i = 0; i < 4; i++) sum += scores[SECTION_NAMES[i]]
    const k = ease(dt, opts.sectionSmoothing)
    for (let i = 0; i < 4; i++) {
      const name = SECTION_NAMES[i]
      section[name] += (scores[name] / sum - section[name]) * k
    }

    // tension fills during breakdowns / builds and drains while it drops
    // (only clear breakdowns / builds count, not background noise)
    const charge = Math.max(0, section.breakdown + section.build - 0.3) / 0.7
    tension = Math.min(1, tension + (dt * charge) / 5)
    tension *= Math.exp(-dt / (45 - 33 * section.drop))
    features.tension = tension

    // dominant section, with hysteresis and a minimum duration
    held += dt
    features.onSectionChange = false
    let best = current
    for (let i = 0; i < 4; i++) {
      const name = SECTION_NAMES[i]
      if (section[name] > section[best]) best = name
    }
    // the challenger must lead by a margin for ~1.5 s in a row
    if (best !== current && section[best] > section[current] + 0.08) {
      if (best !== challenger) {
        challenger = best
        challenged = 0
      }
      challenged += dt
    } else {
      challenger = null
      challenged = 0
    }
    if (challenger && challenged >= 1.5 && held >= opts.sectionMinDuration) {
      current = challenger
      challenger = null
      challenged = 0
      held = 0
      features.sectionName = current
      features.onSectionChange = true
    }
  }

  // ------------------------------------------------------------------------
  // Score every candidate tempo against the pairs of recent onsets.
  //
  // A pair only scores for a candidate when its interval is within sigma of
  // a multiple of the period (and sigma < period / 2, so that multiple is
  // the nearest one). With the intervals sorted, each (candidate, multiple)
  // binary-searches its +-sigma window and visits just the pairs in it,
  // instead of the full candidates x pairs product (same scores). The
  // normalisation, which needs every pair, is only computed for the winner.
  function lowerBound (arr, n, x) {
    let lo = 0
    let hi = n
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (arr[mid] < x) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  function estimateTempo () {
    const n = kicks.length
    let pairs = 0
    for (let i = 0; i < n && pairs < MAX_PAIRS; i++) {
      for (let j = i + 1; j < n && pairs < MAX_PAIRS; j++) {
        const d = kicks[j] - kicks[i]
        if (d > 4) break // longer intervals add little and cost a lot
        if (d >= 0.25) deltas[pairs++] = d
      }
    }
    if (pairs < 4) return null
    const sorted = deltas.subarray(0, pairs).sort()
    const dMax = sorted[pairs - 1]

    const minBpm = Math.max(30, Math.min(opts.minBpm, opts.maxBpm - 10))
    const maxBpm = Math.max(minBpm + 10, opts.maxBpm)
    const count = Math.floor((maxBpm - minBpm) / STEP) + 1
    if (candScores.length < count) candScores = new Float32Array(count)
    const sigma = 0.03 // s, onset timing jitter (frames, detection)
    let bestI = 0
    let bestScore = -1
    for (let c = 0; c < count; c++) {
      const bpm = minBpm + c * STEP
      const period = 60 / bpm
      let score = 0
      for (let m = 1; m * period - sigma <= dMax; m++) {
        // 1/sqrt(m): the true period beats both its half (every pair matches
        // with twice the multiple) and its double (half the pairs match)
        const w = 1 / Math.sqrt(m)
        const centre = m * period
        for (let p = lowerBound(sorted, pairs, centre - sigma); p < pairs; p++) {
          const e = (sorted[p] - centre) / sigma
          if (e >= 1) break
          if (e > -1) score += w * (1 - e * e)
        }
      }
      // mild prior toward club tempos, mostly to settle octave ties
      const oct = Math.log2(bpm / 125)
      score *= Math.exp(-0.5 * oct * oct)
      candScores[c] = score
      if (score > bestScore) {
        bestScore = score
        bestI = c
      }
    }
    // total pair weight for the winning candidate
    const bestPeriod = 60 / (minBpm + bestI * STEP)
    let bestNorm = 0
    for (let p = 0; p < pairs; p++) {
      const m = Math.round(sorted[p] / bestPeriod)
      if (m >= 1) bestNorm += 1 / Math.sqrt(m)
    }
    // parabolic refinement around the peak
    let offset = 0
    if (bestI > 0 && bestI < count - 1) {
      const a = candScores[bestI - 1]
      const b = candScores[bestI]
      const c = candScores[bestI + 1]
      const den = a - 2 * b + c
      if (den < 0) offset = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den))
    }
    const bpm = minBpm + (bestI + offset) * STEP
    const oct = Math.log2(bpm / 125)
    // fraction of the pair weight that lines up (random onsets give ~0.1)
    const aligned = bestScore / Math.exp(-0.5 * oct * oct) / Math.max(bestNorm, 1e-6)
    const coverage = clamp01((n - 4) / 8)
    return { bpm, confidence: clamp01((aligned - 0.15) / 0.55) * coverage }
  }

  function updateTempo (dt, onKick, isAudible) {
    if (isAudible) {
      clock += dt
      if (onKick) kicks.push(clock)
      while (kicks.length && kicks[0] < clock - opts.tempoWindow) kicks.shift()

      estimateTimer -= dt
      if (estimateTimer <= 0) {
        estimateTimer = 0.5
        const est = kicks.length >= 6 ? estimateTempo() : null
        if (!est) {
          confTarget = 0
        } else {
          confTarget = est.confidence
          if (!locked) {
            if (est.confidence > 0.25) {
              locked = true
              bpmTarget = features.bpm = est.bpm
            }
          } else if (Math.abs(est.bpm / bpmTarget - 1) < 0.04) {
            bpmTarget = est.bpm
            candidateCount = 0
          } else if (est.confidence > 0.3) {
            // a different tempo (or octave) must persist before it is taken
            if (candidateCount && Math.abs(est.bpm / candidate - 1) < 0.03) {
              candidateCount++
            } else {
              candidate = est.bpm
              candidateCount = 1
            }
            if (candidateCount >= 4) {
              bpmTarget = features.bpm = candidate
              candidateCount = 0
            }
          }
        }
      }
    }

    // tempo and confidence smoothing (confidence fades slowly when kicks stop)
    features.bpm += (bpmTarget - features.bpm) * ease(dt, 2)
    const c = features.bpmConfidence
    features.bpmConfidence = c + (confTarget - c) * ease(dt, confTarget > c ? 1.5 : 6)

    // phase correction: kicks should land on phase 0
    const phase = beatPos - Math.floor(beatPos)
    if (onKick && locked && features.bpmConfidence > 0.15) {
      const e = phase < 0.5 ? phase : phase - 1 // >0: clock is ahead
      const gain = opts.beatLock * features.bpmConfidence * (Math.abs(e) < 0.2 ? 1 : 0.3)
      pendingShift = -e * Math.min(gain, 1)
    }

    // free-running beat clock; corrections are spread over ~0.2 s and the
    // clock never runs backwards, so beats are never repeated
    const bps = features.bpm / 60
    const corr = pendingShift * ease(dt, 0.2)
    pendingShift -= corr
    const before = beatPos
    beatPos += Math.max(dt * bps * 0.3, dt * bps + corr)
    if (beatPos > 1048576) beatPos -= 1048576 // keeps float precision and index % 64

    const crossed = Math.floor(beatPos) > Math.floor(before)
    const index = Math.floor(beatPos)
    const phraseBeats = Math.max(1, Math.round(opts.phraseBeats))
    features.beatPhase = beatPos - index
    features.beat = index
    // the clock keeps its phase through silences, but only fires events
    // while the music is audible (consumers that need a trusted tempo also
    // check bpmConfidence)
    const fire = crossed && isAudible
    features.onBeat = fire
    features.onBar = fire && index % 4 === 0
    features.onPhrase = fire && index % phraseBeats === 0
  }

  // dt: seconds; level / bass: raw (pre-AGC) mean levels, 0..~1.3;
  // gate: 0..1 audibility; onKick: kick onset this frame
  function update (dt, level, bass, gate, onKick) {
    const isAudible = gate > 0.5
    if (isAudible) {
      updateSections(dt, level, bass, onKick)
    } else {
      features.onSectionChange = false
    }
    updateTempo(dt, onKick, isAudible)
  }

  return { update, reset, opts }
}
