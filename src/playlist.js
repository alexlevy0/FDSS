// Production mode engine: a playlist of local audio files (dropped or picked)
// played back to back with a crossfade between each. No DOM here except the
// <audio> decks; the panel lives in production-panel.js.
//
// Mode. enter() makes the playlist the audio source of the whole page: it
// stops the live input, pauses the mix player and feeds the analysers from
// the playlist bus (audio.useNode). leave() pauses the playlist and gives the
// analysers back to the file player (left paused; the caller starts a mix).
// The live input starting on its own (LIVE button, L key) also leaves. The
// panel being open or closed has nothing to do with the mode: the playlist
// keeps playing, and the visuals keep following it, with the panel hidden.
//
// Engine. Each track is an object URL of its File. A small pool of decks
// (DECKS <audio> elements, created on the first enter()) each go through
// their own MediaElementSource -> GainNode -> bus; the bus goes to the
// speakers and, through audio.useNode, into the analysers. Three decks, not
// two: a jump or a removal during a crossfade fades the two decks that are
// sounding out and a third one in, without cutting anything.
//
// Crossfade. A check runs on the current deck's 'timeupdate' and on a 100 ms
// interval (whichever comes first; both keep going in a background tab, the
// interval throttled to ~1 s there): the next track is preloaded 20 s before
// the end, and once the time left is <= the crossfade length, the next deck
// starts and both gains are ramped by AudioParam curves scheduled on the
// context clock. The ramps themselves therefore never depend on timers: a
// late check (background tab) only shortens the fade to the time actually
// left. Crossfade length = the setting, clamped to 45% of the shorter of the
// two tracks (0.05 s or less: a cut). Curves: 'equal' (equal power, cos /
// sin: constant loudness for uncorrelated tracks) or 'linear'. Both rules
// live in crossfade.js, shared with the WAV export (playlist-export.js). Pause holds every gain where it is and
// pauses every sounding deck; play resumes them and reschedules the rest of
// the fade from the same progress. Seeking during a fade first completes it
// (the incoming track becomes the only one) and then seeks that track.
//
// A crossfade exists as soon as crossTo() is called (fade.start === null
// while the incoming deck is still starting), so a pause in that window
// pauses and later resumes the outgoing decks too. A deck that is part of a
// fade is never unloaded, even when its track is removed from the list: it
// finishes its fade out and its URL is revoked afterwards.
//
// The current track (title, seek bar, highlighted row) is the incoming one
// from the moment its fade starts. Listeners get 'change' (list / state /
// current track changed) and 'midpoint' (half way through a crossfade into a
// new track, or at once for a cut: the moment the visuals may follow the new
// track) and 'mode' (entered / left) events, plus 'error' with a message.

import { crossfadeLength, fadeGain, MIN_FADE } from './crossfade'

const DECKS = 3
const PRELOAD_AHEAD = 20 // s before the fade: set the next deck's src
const MANUAL_FADE = 2 // s, upper bound for jumps and removals
const CURVE_POINTS = 64
const STORAGE_KEY = 'fdss.production'

export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'webm']

export function isAudioFile (file) {
  if (!file) return false
  if (file.type && file.type.startsWith('audio/')) return true
  const m = /\.([a-z0-9]+)$/i.exec(file.name || '')
  return !!(m && AUDIO_EXTENSIONS.includes(m[1].toLowerCase()))
}

const DEFAULTS = { crossfade: 8, curve: 'equal', loop: false }

function readSettings () {
  const s = Object.assign({}, DEFAULTS)
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null')
    if (raw && typeof raw === 'object') {
      if (isFinite(raw.crossfade)) s.crossfade = Math.min(20, Math.max(0, Number(raw.crossfade)))
      if (raw.curve === 'equal' || raw.curve === 'linear') s.curve = raw.curve
      if (typeof raw.loop === 'boolean') s.loop = raw.loop
    }
  } catch (e) {}
  return s
}

function trackName (file) {
  return (file.name || 'Sans titre').replace(/\.[a-z0-9]{1,5}$/i, '')
}

// natural order: "2 - x" before "10 - y"
const collator = typeof Intl !== 'undefined' && Intl.Collator
  ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  : null
const byName = (a, b) => collator ? collator.compare(a.name, b.name) : (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

export default function createPlaylist (audio, opts = {}) {
  const context = audio.context
  const live = opts.live || null
  const settings = readSettings()

  let tracks = [] // { id, file, url, name, duration, status: 'pending'|'ok'|'error' }
  let nextId = 1
  let active = false
  let playing = false // intent: the user wants sound
  let current = null // deck holding the current track
  let currentId = null // current track id (may have no deck while stopped)
  let fade = null // { start, dur, entries: [{ deck, from, to }], midFired, pausedAt }
  let token = 0 // bumped by every crossTo: a late play() is dropped
  let bus = null
  let decks = []
  let timer = null
  const listeners = new Set()
  const pendingRevoke = new Set()

  function emit (type, detail) {
    listeners.forEach((fn) => {
      try { fn(type, detail) } catch (e) { console.error(e) }
    })
  }

  function saveSettings () {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)) } catch (e) {}
  }

  // ---- decks ----

  function setupGraph () {
    if (bus) return
    bus = context.createGain()
    // mono files up-mixed to both sides, so the right analyser is not silent
    bus.channelCount = 2
    bus.channelCountMode = 'explicit'
    bus.channelInterpretation = 'speakers'
    bus.connect(context.destination)
    for (let i = 0; i < DECKS; i++) {
      const el = new window.Audio()
      el.preload = 'auto'
      const gain = context.createGain()
      gain.gain.value = 0
      context.createMediaElementSource(el).connect(gain)
      gain.connect(bus)
      const deck = { el, gain, trackId: null, index: i }
      el.addEventListener('error', () => onDeckError(deck))
      el.addEventListener('ended', () => onDeckEnded(deck))
      el.addEventListener('timeupdate', () => { if (deck === current) check() })
      const syncDuration = () => {
        // the deck knows the real duration: the total and the clamps use it
        // even when the metadata probe is still queued or timed out
        const t = deck.trackId !== null ? trackById(deck.trackId) : null
        const d = deck.el.duration
        if (t && isFinite(d) && d > 0 && Math.abs((t.duration || 0) - d) > 0.01) {
          t.duration = d
          if (t.status === 'pending') t.status = 'ok'
          emit('change')
        } else if (deck === current) emit('change')
      }
      el.addEventListener('loadedmetadata', syncDuration)
      el.addEventListener('durationchange', syncDuration)
      decks.push(deck)
    }
  }

  function load (deck, track) {
    if (deck.trackId === track.id && deck.el.src) return
    deck.trackId = track.id
    deck.el.src = track.url
    deck.el.load()
  }

  function unload (deck) {
    deck.el.pause()
    deck.trackId = null
    deck.el.removeAttribute('src')
    try { deck.el.load() } catch (e) {}
    holdGain(deck, 0)
    flushRevokes()
  }

  // a removed track's URL is revoked once no deck uses it any more (a deck
  // still fading it out keeps it until the fade ends)
  function flushRevokes () {
    decks.forEach((d) => {
      if (inFade(d)) return
      if (d.trackId !== null && d.el.paused && !trackById(d.trackId)) {
        d.trackId = null
        d.el.removeAttribute('src')
        try { d.el.load() } catch (e) {}
      }
    })
    pendingRevoke.forEach((t) => {
      if (decks.some((d) => d.trackId === t.id)) return
      pendingRevoke.delete(t)
      try { URL.revokeObjectURL(t.url) } catch (e) {}
    })
  }

  function inFade (deck) {
    return !!fade && fade.entries.some((e) => e.deck === deck)
  }

  // stop any automation and keep the gain where it is now (or at `value`)
  function holdGain (deck, value) {
    const g = deck.gain.gain
    const now = context.currentTime
    const v = value === undefined ? g.value : value
    try {
      if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(now)
      else g.cancelScheduledValues(0)
    } catch (e) {
      g.cancelScheduledValues(0)
    }
    g.setValueAtTime(v, now)
  }

  function curveValue (entry, p) {
    return fadeGain(settings.curve, entry.from, entry.to, p)
  }

  // schedule the fade from progress p0 to 1, starting now
  function scheduleFade (p0) {
    const remaining = (1 - p0) * fade.dur
    const at = context.currentTime + 0.01
    fade.start = at - p0 * fade.dur
    fade.entries.forEach((entry) => {
      holdGain(entry.deck, curveValue(entry, p0))
      if (remaining <= 0.02) {
        entry.deck.gain.gain.setValueAtTime(entry.to, at)
        return
      }
      const curve = new Float32Array(CURVE_POINTS)
      for (let i = 0; i < CURVE_POINTS; i++) {
        curve[i] = curveValue(entry, p0 + (1 - p0) * i / (CURVE_POINTS - 1))
      }
      try {
        entry.deck.gain.gain.setValueCurveAtTime(curve, at, remaining)
      } catch (e) {
        entry.deck.gain.gain.linearRampToValueAtTime(entry.to, at + remaining)
      }
    })
  }

  function fadeProgress () {
    if (!fade) return 0
    if (fade.pausedAt !== null) return fade.pausedAt
    if (fade.start === null) return 0
    return fade.dur > 0 ? Math.min(1, Math.max(0, (context.currentTime - fade.start) / fade.dur)) : 1
  }

  // end the fade now: incoming at full gain, the others silent and paused
  function finishFade () {
    if (!fade) return
    const f = fade
    fade = null
    f.entries.forEach((entry) => {
      holdGain(entry.deck, entry.to)
      if (entry.to === 0) entry.deck.el.pause()
    })
    if (!f.midFired) emit('midpoint', trackIndex(currentId))
    flushRevokes()
  }

  // ---- track order helpers ----

  function trackIndex (id) {
    return tracks.findIndex((t) => t.id === id)
  }

  function trackById (id) {
    return tracks.find((t) => t.id === id) || null
  }

  // index of the track after the current one (skipping unreadable ones),
  // wrapping when looping; -1 at the end
  function nextIndex (fromId = currentId) {
    const n = tracks.length
    const i = trackIndex(fromId)
    for (let k = i + 1; k < n; k++) if (tracks[k].status !== 'error') return k
    if (settings.loop) {
      for (let k = 0; k <= Math.min(i, n - 1); k++) if (tracks[k].status !== 'error') return k
    }
    return -1
  }

  function firstPlayable (from = 0) {
    for (let k = from; k < tracks.length; k++) if (tracks[k].status !== 'error') return k
    return -1
  }

  function trackDuration (track, deck) {
    if (deck && deck.trackId === track.id && isFinite(deck.el.duration) && deck.el.duration > 0) return deck.el.duration
    return track.duration || 0
  }

  // crossfade length between two tracks (crossfade.js: the setting, at most
  // 45% of the shorter one, 0 for a cut; unknown durations do not clamp)
  function fadeLength (a, b, deckB) {
    const da = a ? trackDuration(a, current) : 0
    const db = b ? trackDuration(b, deckB) : 0
    return crossfadeLength(settings.crossfade, da, db)
  }

  // ---- transport ----

  // Make track `index` the current one, fading every other sounding deck out
  // over `dur` seconds (0 = cut). Starts playback.
  function crossTo (index, dur) {
    const track = tracks[index]
    if (!track || track.status === 'error') return
    setupGraph()
    audio.resumeContext()
    // a fade in progress stops where it is: its decks become the outgoing
    // ones of this new fade (from their current gains)
    if (fade) {
      fade.entries.forEach((e) => holdGain(e.deck))
      fade = null
    }
    const pick = decks.find((d) => d !== current && d.trackId === track.id) ||
      decks.filter((d) => d !== current).sort((a, b) => a.gain.gain.value - b.gain.gain.value)[0]
    // the incoming deck always starts silent (a deck reused while it was
    // still fading out is cut: only happens on a jump during a fade)
    pick.el.pause()
    holdGain(pick, 0)
    load(pick, track)
    try { pick.el.currentTime = 0 } catch (e) {}
    current = pick
    currentId = track.id
    playing = true
    const tk = ++token
    const outgoing = decks.filter((d) => d !== pick && !d.el.paused && d.gain.gain.value > 0.0001)
    decks.forEach((d) => { if (d !== pick && !outgoing.includes(d)) d.el.pause() })
    // the fade is recorded now, not once the incoming deck has started: a
    // pause while it starts then pauses (and play resumes) the outgoing
    // decks too, instead of losing them
    const length = outgoing.length ? Math.max(0, dur) : 0
    const f = fade = {
      start: null, // set when the ramps are scheduled
      dur: length,
      pausedAt: null,
      midFired: false,
      entries: [{ deck: pick, from: 0, to: 1 }]
        .concat(outgoing.map((d) => ({ deck: d, from: d.gain.gain.value, to: 0 })))
    }
    emit('change')
    pick.el.play().then(() => {
      if (tk !== token) return
      // paused while starting (pause() paused every deck of the fade and
      // play() will resume them), or the fade was completed by a seek
      if (!playing || fade !== f) return
      if (length <= 0.02) finishFade()
      else scheduleFade(0)
      emit('change')
    }, (err) => {
      if (tk !== token) return
      if (err && err.name === 'NotAllowedError') {
        // no gesture yet (autoplay policy): everything waits paused, at the
        // gains it has; play() retries the whole fade
        decks.forEach((d) => { holdGain(d); d.el.pause() })
        playing = false
        emit('change')
      }
      // decoding errors arrive through the element's 'error' event; an
      // AbortError is a pause() during the start, handled there
    })
  }

  function stopAll () {
    playing = false
    token++
    fade = null
    decks.forEach((d) => { d.el.pause(); holdGain(d, 0) })
    emit('change')
  }

  function play () {
    if (!active || !tracks.length) return
    audio.resumeContext()
    const track = trackById(currentId)
    if (!track || track.status === 'error') {
      const i = firstPlayable()
      if (i >= 0) crossTo(i, 0)
      return
    }
    if (current && current.trackId === currentId && current.el.ended) {
      // stopped at the end of the playlist: from the top
      const i = firstPlayable()
      if (i >= 0) crossTo(i, 0)
      return
    }
    if (!current || current.trackId !== currentId) {
      // a current track with no deck yet (its deck was removed / cleared)
      crossTo(trackIndex(currentId), 0)
      return
    }
    playing = true
    const sounding = fade ? fade.entries.map((e) => e.deck) : [current]
    const tk = token
    // every deck is settled on its own: one failing must not leave the
    // others playing at frozen gains while the state says paused
    Promise.all(sounding.map((d) => d.el.play().then(() => true, () => false))).then((oks) => {
      if (tk !== token) return
      if (!playing) {
        // paused again before the decks started
        sounding.forEach((d) => d.el.pause())
        return
      }
      const failed = sounding.filter((d, i) => !oks[i])
      if (failed.includes(current)) {
        // the current track cannot play (autoplay policy, element gone):
        // everything back to a consistent pause
        decks.forEach((d) => { holdGain(d); d.el.pause() })
        playing = false
        emit('change')
        return
      }
      if (fade && failed.length) {
        // an outgoing deck that cannot resume just drops out of the fade
        failed.forEach((d) => { d.el.pause(); holdGain(d, 0) })
        fade.entries = fade.entries.filter((e) => !failed.includes(e.deck))
      }
      if (fade) {
        const p = fade.pausedAt || 0
        fade.pausedAt = null
        if (fade.dur <= 0.02) finishFade()
        else scheduleFade(p)
      } else {
        holdGain(current, 1)
      }
      flushRevokes()
      emit('change')
    })
    emit('change')
  }

  function pause () {
    if (!playing) return
    playing = false
    // a fade still starting (start === null) resumes from 0
    if (fade) fade.pausedAt = fadeProgress()
    decks.forEach((d) => {
      holdGain(d)
      d.el.pause()
    })
    emit('change')
  }

  function togglePlay () {
    if (playing) pause()
    else play()
  }

  function seek (t) {
    if (!current || current.trackId !== currentId) return
    if (fade) finishFade()
    const d = current.el.duration
    if (!isFinite(d)) return
    current.el.currentTime = Math.min(Math.max(0, t), Math.max(0, d - 0.05))
    if (!playing) holdGain(current, 1)
    emit('change')
  }

  // ---- the crossfade trigger ----

  function check () {
    if (!active || !playing) return
    if (fade && fade.start !== null && fade.pausedAt === null) {
      const p = fadeProgress()
      if (!fade.midFired && p >= 0.5) {
        fade.midFired = true
        emit('midpoint', trackIndex(currentId))
      }
      if (p >= 1) finishFade()
    }
    if (fade || !current || current.el.paused) return
    const track = trackById(currentId)
    const ni = nextIndex()
    if (!track || ni < 0) return
    const next = tracks[ni]
    const d = trackDuration(track, current)
    if (!d) return
    const left = d - current.el.currentTime
    const nextDeck = decks.find((dk) => dk !== current && dk.trackId === next.id) || null
    const x = fadeLength(track, next, nextDeck)
    if (left <= x + PRELOAD_AHEAD) {
      const free = decks.find((dk) => dk !== current && dk.trackId === next.id) ||
        decks.find((dk) => dk !== current && dk.el.paused)
      if (free && next !== track) load(free, next)
    }
    if (x > MIN_FADE && left <= x + 0.02) crossTo(ni, Math.max(0.05, Math.min(x, left)))
  }

  function onDeckEnded (deck) {
    if (deck !== current || !playing) return
    const ni = nextIndex()
    if (ni >= 0) {
      crossTo(ni, 0)
    } else {
      // the end of the playlist: stopped on the last track. A fade still
      // running (a duration unknown when it was clamped) is completed, so
      // no outgoing deck keeps sounding with the state saying stopped
      if (fade) finishFade()
      decks.forEach((d) => { if (d !== current) { d.el.pause(); holdGain(d, 0) } })
      playing = false
      emit('change')
    }
  }

  function onDeckError (deck) {
    if (!deck.trackId || !deck.el.getAttribute('src')) return
    const track = trackById(deck.trackId)
    deck.trackId = null
    if (!track) return
    markError(track)
    if (deck === current && playing) {
      const ni = nextIndex(track.id)
      if (ni >= 0) crossTo(ni, 0)
      else stopAll()
    }
  }

  function markError (track) {
    if (track.status === 'error') return
    track.status = 'error'
    emit('error', `Lecture impossible : ${track.name}`)
    emit('change')
  }

  // ---- durations (metadata only, one file at a time) ----

  const probeQueue = []
  let probing = false
  let abortProbe = null // (id | null) => void, for the file being probed
  function probeNext () {
    if (probing) return
    const track = probeQueue.shift()
    if (!track) return
    if (!trackById(track.id)) { probeNext(); return }
    probing = true
    const el = new window.Audio()
    el.preload = 'metadata'
    const done = (ok) => {
      if (!probing) return
      probing = false
      abortProbe = null
      clearTimeout(timeout)
      if (!trackById(track.id)) {
        // removed (or cleared) meanwhile: its URL may be revoked already,
        // a failure here says nothing about the file
      } else if (ok && isFinite(el.duration) && el.duration > 0) {
        track.duration = el.duration
        if (track.status === 'pending') track.status = 'ok'
      } else if (!ok) {
        markError(track)
      } else if (track.status === 'pending') {
        track.status = 'ok'
      }
      el.removeAttribute('src')
      try { el.load() } catch (e) {}
      emit('change')
      probeNext()
    }
    // a file the browser hangs on: give up on the duration, not the track
    const timeout = setTimeout(() => done(true), 10000)
    abortProbe = (id) => { if (id === null || id === track.id) done(true) }
    el.addEventListener('loadedmetadata', () => done(true), { once: true })
    el.addEventListener('error', () => done(false), { once: true })
    el.src = track.url
  }

  // ---- list editing ----

  // Appends audio files (non-audio ones are skipped). Files of one call are
  // sorted by name (natural order): the order a file manager hands over is
  // arbitrary, the name usually carries the intended one. Returns
  // { added, ignored }. Starts playback when nothing was current.
  function add (fileList) {
    const files = Array.from(fileList || [])
    const ok = files.filter(isAudioFile).sort(byName)
    const ignored = files.length - ok.length
    if (!ok.length) return { added: 0, ignored }
    const wasIdle = !playing && (!currentId || (current && current.el.ended))
    const first = tracks.length
    ok.forEach((file) => {
      const track = {
        id: nextId++,
        file,
        url: URL.createObjectURL(file),
        name: trackName(file),
        duration: 0,
        status: 'pending'
      }
      tracks.push(track)
      probeQueue.push(track)
    })
    probeNext()
    emit('change')
    if (active && wasIdle) crossTo(first, 0)
    return { added: ok.length, ignored }
  }

  function remove (id) {
    const i = trackIndex(id)
    if (i < 0) return
    const track = tracks[i]
    if (id === currentId) {
      let ni = nextIndex(id)
      if (ni >= 0 && tracks[ni].id === id) ni = -1
      if (playing && ni >= 0) {
        crossTo(ni, Math.min(settings.crossfade, MANUAL_FADE))
      } else {
        if (playing) stopAll()
        // paused (possibly mid-fade): nothing is sounding; the fade is
        // dropped and the next play() starts the new current track clean
        if (fade) {
          fade.entries.forEach((e) => holdGain(e.deck, 0))
          fade = null
        }
        decks.forEach((d) => { if (d.trackId === id) { d.el.pause(); holdGain(d, 0) } })
        currentId = ni >= 0 ? tracks[ni].id : (tracks[i + 1] ? tracks[i + 1].id : null)
        current = null
      }
    }
    tracks.splice(i, 1)
    pendingRevoke.add(track)
    if (abortProbe) abortProbe(id)
    // decks that only preloaded it (not sounding) let it go now; a deck
    // fading it out (even paused mid-fade) keeps it until the fade ends
    decks.forEach((d) => {
      if (d.trackId === id && d.el.paused && !inFade(d)) unload(d)
    })
    flushRevokes()
    if (!tracks.length) clear()
    emit('change')
  }

  function move (from, to) {
    if (from === to || from < 0 || to < 0 || from >= tracks.length || to >= tracks.length) return
    const [t] = tracks.splice(from, 1)
    tracks.splice(to, 0, t)
    emit('change')
  }

  // the current track moves to the top and every other one is shuffled
  // after it: everything left is still to come
  function shuffle () {
    const cur = trackById(currentId)
    const rest = tracks.filter((t) => t !== cur)
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const tmp = rest[i]
      rest[i] = rest[j]
      rest[j] = tmp
    }
    tracks = cur ? [cur].concat(rest) : rest
    emit('change')
  }

  function clear () {
    token++
    playing = false
    fade = null
    decks.forEach((d) => unload(d))
    tracks.forEach((t) => pendingRevoke.add(t))
    tracks = []
    probeQueue.length = 0
    if (abortProbe) abortProbe(null)
    current = null
    currentId = null
    flushRevokes()
    emit('change')
  }

  // click on a track: crossfade into it (short fade), or start it
  // The current track itself is not restarted (an accidental tap on the
  // highlighted row would lose the position): resumed if paused, else
  // nothing. Restarting it is the seek bar's job.
  function jump (index) {
    if (!tracks[index] || tracks[index].status === 'error') return
    if (tracks[index].id === currentId && current && current.trackId === currentId && !current.el.ended) {
      if (!playing) play()
      return
    }
    crossTo(index, playing ? Math.min(settings.crossfade, MANUAL_FADE) : 0)
  }

  // ---- mode ----

  function enter () {
    if (active) return
    setupGraph()
    // a live input (or one waiting on its prompt) is dropped first, so its
    // own state and UI follow
    if (live) live.stop()
    bus.connect(context.destination) // no-op unless a prefixed context cut it
    audio.useNode(bus, isPlaying)
    active = true
    if (!timer) timer = setInterval(check, 100)
    emit('mode', true)
    emit('change')
  }

  function leave () {
    if (!active) return
    pause()
    active = false
    clearInterval(timer)
    timer = null
    // only take the analysers back if they are still ours (a live start has
    // already moved them to its stream)
    if (audio.inputKind() === 'node') audio.useFile()
    emit('mode', false)
    emit('change')
  }

  if (live) {
    live.subscribe((state) => {
      if (state.active && state.reason === 'start') leave()
    })
  }

  // ---- state ----

  function isPlaying () {
    return playing && decks.some((d) => !d.el.paused)
  }

  function totalDuration () {
    const ok = tracks.filter((t) => t.status !== 'error')
    let sum = 0
    for (let i = 0; i < ok.length; i++) {
      sum += ok[i].duration || 0
      if (i > 0) sum -= crossfadeLength(settings.crossfade, ok[i - 1].duration, ok[i].duration)
    }
    return Math.max(0, sum)
  }

  return {
    settings,
    setSetting (key, value) {
      if (key === 'crossfade') settings.crossfade = Math.min(20, Math.max(0, Number(value) || 0))
      else if (key === 'curve') settings.curve = value === 'linear' ? 'linear' : 'equal'
      else if (key === 'loop') settings.loop = !!value
      else return
      saveSettings()
      emit('change')
    },
    subscribe (fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    enter,
    leave,
    isActive: () => active,
    isPlaying,
    wantsPlay: () => playing,
    play,
    pause,
    togglePlay,
    seek,
    jump,
    add,
    remove,
    move,
    shuffle,
    clear,
    getTracks: () => tracks.slice(),
    getCurrentIndex: () => trackIndex(currentId),
    getCurrentTrack: () => trackById(currentId),
    currentTime: () => (current && current.trackId === currentId ? current.el.currentTime || 0 : 0),
    duration () {
      const t = trackById(currentId)
      return t ? trackDuration(t, current) : 0
    },
    totalDuration
  }
}
