// Export of the production playlist as ONE audio file: a 16-bit PCM stereo
// WAV at 44.1 kHz, with exactly the transitions the playlist plays.
//
// Same transitions. The fade length and curve come from crossfade.js, the
// definitions playlist.js plays with: between two consecutive readable
// tracks, the setting clamped to 45% of the shorter track (0.05 s or less: a
// cut), with the equal-power or linear curve. The next track starts when
// the previous one has `fade` seconds left, so the result lasts the sum of
// the tracks minus the sum of the fades. Loop is ignored (a file has an
// end); unreadable tracks are skipped (the neighbours fade into each other,
// as in playback) and reported. Durations are the DECODED ones, at 44.1 kHz:
// playback clamps with the element's duration, which can differ from the
// decoded length by a few ms (MP3 encoder delay / padding, VBR estimates),
// hence by at most a few ms of fade.
//
// Streaming. The mix is never held whole: tracks are decoded one at a time
// (decodeAudioData of an OfflineAudioContext at 44.1 kHz, which resamples)
// and at most two are in memory at once, the one being written and the next
// (its length decides the fade and its head is mixed into the overlap). Each
// stretch is converted to 16-bit in chunks; the chunks are gathered in Blobs
// of ~16 MB (the browser may keep large Blobs on disk), and the 44-byte
// header, written last, becomes the first Blob part. A decoded track is
// released as soon as its last frame is written.
//
// Limiter. Two tracks summed in an overlap (or a hot down-mix) can exceed
// full scale. Instead of clipping, a look-ahead peak limiter scales such
// peaks down to the 0 dBFS ceiling: the gain needed by each sample is the
// minimum over the next 5 ms, smoothed by a 5 ms moving average (so it
// reaches the right value exactly at the peak, without a step), and it
// recovers with a 200 ms release. Where nothing exceeds full scale the gain
// is exactly 1: every sample passes unchanged (bit-exact for a 16-bit
// 44.1 kHz source); the window average is reset to exactly 1 as soon as no
// frame of the window needed limiting, so rounding error from a long hot
// passage cannot leave the gain a hair under 1 afterwards. The output is delayed by the look-ahead internally and
// realigned, so the frame count is unchanged.
//
// Channels. Mono files are copied to both sides; 4 channels (quad) and 6
// (5.1) are down-mixed with the Web Audio speaker rules; other layouts keep
// their first two channels.
//
// The UI stays responsive: the work is cut in ~10 ms slices separated by
// yields (a MessageChannel, not throttled in a background tab like
// setTimeout); progress is reported after each slice; an AbortSignal
// cancels between slices. The core (timeline, overlap mix, limiter, header)
// is pure and works on plain arrays.

import { crossfadeLength, fadeGain } from './crossfade'

export const EXPORT_RATE = 44100
const CHANNELS = 2
const BYTES_PER_FRAME = CHANNELS * 2
// the RIFF size field (file size - 8) is 32-bit: 36 + data bytes must fit
export const MAX_WAV_FRAMES = Math.floor((0xFFFFFFFF - 36) / BYTES_PER_FRAME)
const CHUNK = 16384 // frames per mixing step
const OUT_FRAMES = 65536 // frames per Int16 part
const BLOB_BYTES = 16 * 1024 * 1024 // parts gathered into a Blob past this
const SLICE_MS = 10

// ---- pure core ----

// frames of overlap between two decoded tracks (crossfade.js rule on the
// decoded durations); never more than either track
export function overlapFrames (lengthA, lengthB, rate, setting) {
  const x = crossfadeLength(setting, lengthA / rate, lengthB / rate)
  return Math.max(0, Math.min(Math.round(x * rate), lengthA, lengthB))
}

// where each track starts in the export, the overlap before each one, and
// the total length (all in frames)
export function computeTimeline (lengths, rate, setting) {
  const starts = []
  const overlaps = []
  let end = 0
  lengths.forEach((n, i) => {
    const ov = i ? overlapFrames(lengths[i - 1], n, rate, setting) : 0
    overlaps.push(ov)
    starts.push(end - ov)
    end = end - ov + n
  })
  return { starts, overlaps, total: Math.max(0, end) }
}

// Mixes `count` frames of a transition into out (stereo {L, R}): frame k of
// the overlap (k0 + i) is a's frame aFrom + i faded out plus b's frame
// bFrom + i faded in, at progress k / ov.
export function mixOverlap (out, a, aFrom, b, bFrom, k0, count, ov, curve) {
  for (let i = 0; i < count; i++) {
    const p = (k0 + i) / ov
    const ga = fadeGain(curve, 1, 0, p)
    const gb = fadeGain(curve, 0, 1, p)
    out.L[i] = a.L[aFrom + i] * ga + b.L[bFrom + i] * gb
    out.R[i] = a.R[aFrom + i] * ga + b.R[bFrom + i] * gb
  }
}

// {L, R, length} from anything shaped like an AudioBuffer
export function stereoChannels (buffer) {
  const n = buffer.length
  const c = buffer.numberOfChannels
  const ch = (i) => buffer.getChannelData(i)
  if (c === 1) {
    const m = ch(0)
    return { L: m, R: m, length: n }
  }
  if (c === 4 || c === 6) {
    const L = new Float32Array(n)
    const R = new Float32Array(n)
    const l = ch(0)
    const r = ch(1)
    if (c === 4) {
      // quad: L, R, SL, SR
      const sl = ch(2)
      const sr = ch(3)
      for (let i = 0; i < n; i++) {
        L[i] = 0.5 * (l[i] + sl[i])
        R[i] = 0.5 * (r[i] + sr[i])
      }
    } else {
      // 5.1: L, R, C, LFE, SL, SR (LFE dropped)
      const k = Math.SQRT1_2
      const cc = ch(2)
      const sl = ch(4)
      const sr = ch(5)
      for (let i = 0; i < n; i++) {
        L[i] = l[i] + k * (cc[i] + sl[i])
        R[i] = r[i] + k * (cc[i] + sr[i])
      }
    }
    return { L, R, length: n }
  }
  return { L: ch(0), R: ch(1), length: n }
}

// Look-ahead peak limiter (see the top of the file). push(l, r) takes one
// frame and returns true when a frame came out, in outL / outR (false while
// the first look-ahead fills). flush(onFrame) pushes the look-ahead out
// after the last frame: onFrame() is called once per frame still held, so
// frames out === frames in, however few there were.
export function createLimiter (rate, { ceiling = 1, lookahead = 0.005, release = 0.2 } = {}) {
  const L = Math.max(2, Math.round(lookahead * rate))
  const rc = 1 - Math.exp(-1 / (release * rate))
  const inL = new Float32Array(L)
  const inR = new Float32Array(L)
  const C = L + 1 // deque capacity
  const dqVal = new Float64Array(C)
  const dqIdx = new Float64Array(C)
  let head = 0
  let cnt = 0
  const mRing = new Float64Array(L).fill(1)
  let sum = L
  let below = 0 // entries of mRing under 1 (0: the window is clean)
  let g = 1
  let j = 0 // index of the next frame in
  let skip = L - 1 // steps before the first frame has its look-ahead
  const state = { outL: 0, outR: 0, gain: 1, minGain: 1 }

  function step (l, r) {
    const peak = Math.max(Math.abs(l), Math.abs(r))
    const req = peak > ceiling ? ceiling / peak : 1
    const slot = j % L
    inL[slot] = l
    inR[slot] = r
    // sliding minimum of req over [j - L + 1, j]
    while (cnt && dqVal[(head + cnt - 1) % C] >= req) cnt--
    const t = (head + cnt) % C
    dqVal[t] = req
    dqIdx[t] = j
    cnt++
    while (dqIdx[head] < j - L + 1) { head = (head + 1) % C; cnt-- }
    const m = dqVal[head]
    // n = j - L + 1: its window min is m; box average over the last L mins
    const ms = (j + 1) % L
    const old = mRing[ms]
    if (old < 1) below--
    if (m < 1) below++
    mRing[ms] = m
    // exact once the window is clean: untouched frames stay bit-exact
    let b
    if (below === 0) {
      sum = L
      b = 1
    } else {
      sum += m - old
      b = Math.min(1, sum / L)
    }
    let up = g + (1 - g) * rc
    if (up > 0.999999) up = 1
    g = Math.min(b, up)
    j++
    if (skip > 0) { skip--; return false }
    // (the clamp only catches the last-bit rounding of ceiling / peak * peak)
    const ol = inL[ms] * g
    const or = inR[ms] * g
    state.outL = ol > ceiling ? ceiling : ol < -ceiling ? -ceiling : ol
    state.outR = or > ceiling ? ceiling : or < -ceiling ? -ceiling : or
    state.gain = g
    if (g < state.minGain) state.minGain = g
    return true
  }

  let flushed = false
  return {
    state,
    lookahead: L,
    push: (l, r) => step(l, r),
    // after the last real frame: L - 1 silent steps push out every frame
    // still held (those of a mix shorter than the look-ahead included)
    flush (onFrame) {
      if (flushed) return
      flushed = true
      for (let k = 0; k < L - 1; k++) if (step(0, 0)) onFrame()
    }
  }
}

export function wavHeader (frames, rate = EXPORT_RATE) {
  const dataBytes = frames * BYTES_PER_FRAME
  const h = new DataView(new ArrayBuffer(44))
  const str = (o, s) => { for (let i = 0; i < 4; i++) h.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF')
  h.setUint32(4, 36 + dataBytes, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  h.setUint32(16, 16, true) // fmt chunk size
  h.setUint16(20, 1, true) // PCM
  h.setUint16(22, CHANNELS, true)
  h.setUint32(24, rate, true)
  h.setUint32(28, rate * BYTES_PER_FRAME, true)
  h.setUint16(32, BYTES_PER_FRAME, true)
  h.setUint16(34, 16, true)
  str(36, 'data')
  h.setUint32(40, dataBytes, true)
  return h.buffer
}

// local date and time (to the minute): two exports of the same day get
// distinct names, so the name shown is the name the browser saves
export function exportFileName (date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `FDSS-production-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}h${p(date.getMinutes())}.wav`
}

// Float frames in, 16-bit interleaved Blob parts out, through the limiter.
export function createEncoder (rate) {
  const limiter = createLimiter(rate)
  const blobs = []
  let pending = []
  let pendingBytes = 0
  let out = new Int16Array(OUT_FRAMES * CHANNELS)
  let o = 0
  let framesIn = 0
  let framesOut = 0

  const q = (x) => {
    const s = Math.round(x * 32768)
    return s > 32767 ? 32767 : s < -32768 ? -32768 : s
  }
  function emit () {
    out[o++] = q(limiter.state.outL)
    out[o++] = q(limiter.state.outR)
    framesOut++
    if (o === out.length) flushPart()
  }
  function flushPart () {
    if (!o) return
    const part = o === out.length ? out : out.slice(0, o)
    pending.push(part)
    pendingBytes += part.byteLength
    out = new Int16Array(OUT_FRAMES * CHANNELS)
    o = 0
    if (pendingBytes >= BLOB_BYTES) gather()
  }
  function gather () {
    if (!pending.length) return
    blobs.push(new Blob(pending))
    pending = []
    pendingBytes = 0
  }

  return {
    // frames [from, from + count) of the stereo arrays L / R
    write (L, R, from, count) {
      if (framesIn + count > MAX_WAV_FRAMES) throw new ExportError('tooLong')
      for (let i = from, e = from + count; i < e; i++) {
        if (limiter.push(L[i], R[i])) emit()
      }
      framesIn += count
    },
    frames: () => framesIn,
    minGain: () => limiter.state.minGain,
    finish () {
      limiter.flush(emit)
      flushPart()
      gather()
      return { blob: new Blob([wavHeader(framesOut, rate)].concat(blobs), { type: 'audio/wav' }), frames: framesOut }
    }
  }
}

export class ExportError extends Error {
  constructor (code, detail) {
    super(code)
    this.code = code
    this.detail = detail
  }
}

// ---- the export ----

function yieldToLoop () {
  return new Promise((resolve) => {
    const c = new window.MessageChannel()
    c.port1.onmessage = () => { c.port1.close(); resolve() }
    c.port2.postMessage(0)
  })
}

function decodeWith (ctx, data) {
  return new Promise((resolve, reject) => {
    // callback form too: older Safari's OfflineAudioContext has no promise
    const p = ctx.decodeAudioData(data, resolve, reject)
    if (p && p.then) p.then(resolve, reject)
  })
}

// Estimated output length in seconds, from the playlist's (metadata)
// durations: progress and the up-front size check. Unknown durations count
// as the mean of the known ones.
export function estimateSeconds (durations, setting) {
  const known = durations.filter((d) => d > 0)
  const mean = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 180
  const d = durations.map((x) => (x > 0 ? x : mean))
  let sum = 0
  d.forEach((x, i) => { sum += x - (i ? crossfadeLength(setting, d[i - 1], x) : 0) })
  return Math.max(0, sum)
}

// tracks: [{ name, file, duration }] in order (readable ones; the caller
// leaves out those already known to be unreadable). settings: { crossfade,
// curve }. onProgress({ fraction, name, phase: 'decode' | 'mix' }).
// Resolves { blob, frames, seconds, skipped: [names], filename }; rejects
// with an AbortError (signal) or an ExportError ('empty', 'tooLong',
// 'memory', 'failed').
export async function exportPlaylist (tracks, settings, { onProgress, signal } = {}) {
  const rate = EXPORT_RATE
  const setting = settings.crossfade
  const curve = settings.curve
  const estimate = estimateSeconds(tracks.map((t) => t.duration || 0), setting) * rate
  if (estimate > MAX_WAV_FRAMES) throw new ExportError('tooLong')

  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext
  const ctx = new Offline(CHANNELS, 1, rate)
  const encoder = createEncoder(rate)
  const skipped = []
  const scratch = { L: new Float32Array(CHUNK), R: new Float32Array(CHUNK) }
  let sliceStart = performance.now()
  let phase = 'decode'
  let name = ''

  const checkAbort = () => {
    if (signal && signal.aborted) throw new DOMException('Export annulé', 'AbortError')
  }
  const report = () => {
    if (!onProgress) return
    const fraction = estimate > 0 ? Math.min(0.99, encoder.frames() / estimate) : 0
    onProgress({ fraction, name, phase })
  }
  async function slice () {
    if (performance.now() - sliceStart < SLICE_MS) return
    report()
    await yieldToLoop()
    checkAbort()
    sliceStart = performance.now()
  }

  async function decode (track) {
    phase = 'decode'
    name = track.name
    report()
    await yieldToLoop()
    checkAbort()
    let data
    try {
      data = await track.file.arrayBuffer()
    } catch (e) {
      skipped.push(track.name)
      return null
    }
    checkAbort()
    let buffer
    try {
      buffer = await decodeWith(ctx, data)
    } catch (e) {
      if (e && e.name === 'RangeError') throw new ExportError('memory', track.name)
      skipped.push(track.name)
      return null
    }
    data = null
    checkAbort()
    if (!buffer || !buffer.length) {
      skipped.push(track.name)
      return null
    }
    const st = stereoChannels(buffer)
    st.name = track.name
    sliceStart = performance.now()
    return st
  }

  // frames [from, to) of a decoded track, as is
  async function writeRange (t, from, to) {
    phase = 'mix'
    name = t.name
    for (let p = from; p < to; p += CHUNK) {
      encoder.write(t.L, t.R, p, Math.min(CHUNK, to - p))
      await slice()
    }
  }

  // the transition: a's last ov frames under b's first ov frames
  async function writeOverlap (a, b, ov) {
    phase = 'mix'
    name = b.name
    const aFrom = a.length - ov
    for (let k = 0; k < ov; k += CHUNK) {
      const n = Math.min(CHUNK, ov - k)
      mixOverlap(scratch, a, aFrom + k, b, k, k, n, ov, curve)
      encoder.write(scratch.L, scratch.R, 0, n)
      await slice()
    }
  }

  try {
    let prev = null // the track being written
    let pos = 0 // its first frame not yet written
    for (const track of tracks) {
      checkAbort()
      const next = await decode(track)
      if (!next) continue
      if (!prev) {
        prev = next
        pos = 0
        continue
      }
      const ov = Math.min(overlapFrames(prev.length, next.length, rate, setting), prev.length - pos)
      await writeRange(prev, pos, prev.length - ov)
      await writeOverlap(prev, next, ov)
      prev = next // the previous track is released here
      pos = ov
    }
    if (!prev) throw new ExportError('empty')
    await writeRange(prev, pos, prev.length)
    prev = null
    checkAbort()
    const { blob, frames } = encoder.finish()
    if (onProgress) onProgress({ fraction: 1, name: '', phase: 'done' })
    return { blob, frames, seconds: frames / rate, skipped, filename: exportFileName(), minGain: encoder.minGain() }
  } catch (e) {
    if (e && (e.name === 'AbortError' || e instanceof ExportError)) throw e
    if (e && e.name === 'RangeError') throw new ExportError('memory')
    throw new ExportError('failed', e && e.message)
  }
}

// hands a Blob to the browser as a download
export function downloadBlob (blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // the download has its own reference once started
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}
