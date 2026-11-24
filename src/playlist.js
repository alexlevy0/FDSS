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
//
// Failures. A track has one of four statuses: 'pending' (not probed yet),
// 'ok', 'damaged' (it played, then failed part way and could not be
// recovered: it stays clickable, a later play retries it) and 'error' (it
// cannot start at all, or its File can no longer be read: skipped). Only the
// last one is "illisible" in the panel.
//   A deck can fail in two ways: its element fires 'error' (MediaError: a
// run of damaged MP3 frames gives MEDIA_ERR_DECODE part way through; a
// format change mid-file too), or it stops progressing while it should play
// (the stall watchdog in check(): a dropped File changed / moved / deleted
// on disk after it was added hangs the element silently, Chrome only fires
// MEDIA_ERR_NETWORK ~30 s later). Either way onDeckFailure() first checks
// that the File can still be read (a changed File cannot: re-dropping it is
// the only cure, so it is not retried), then reloads the same URL on the
// same deck and resumes a little past the failure point (RETRY_SKIPS:
// seeking into the damaged area fails again at once, and the decoder fails
// ~1.5 s before it), the deck's gain / fade untouched. Only when the retries
// run out is the track given up: 'damaged' (or 'error' if it never played),
// a precise message, and the next track starts. Playback never just stops
// on a failure while another playable track follows. A track that played
// and later cannot even be opened (MEDIA_ERR_SRC_NOT_SUPPORTED) has changed
// on disk: 'error' / 'file' at once, no retry. A seek while a failure is
// being handled wins over the recovery (the deck reloads at the new spot).
//   A pause that does not come from the app (media key, browser media
// controls, headphones removed) pauses the playlist (onDeckPause), so it is
// neither mistaken for a stall nor left out of sync with the transport.

import { crossfadeLength, fadeGain, MIN_FADE } from './crossfade'

const DECKS = 3
const PRELOAD_AHEAD = 20 // s before the fade: set the next deck's src
const MANUAL_FADE = 2 // s, upper bound for jumps and removals
const CURVE_POINTS = 64
const STORAGE_KEY = 'fdss.production'
// recovery (see Failures above)
const STALL_MS = 6000 // no progress for this long while playing: a failure
const RETRY_SKIPS = [0.5, 2, 5, 10] // s past the failure point, one per retry
const STALL_RETRIES = 2 // a stall costs STALL_MS to detect: fewer retries
const HEAL_AFTER = 3 // s of clean playback past a retry point: recovered

// m:ss (h:mm:ss past an hour), for messages
function formatTime (s) {
  s = Math.max(0, Math.floor(s || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

// Can the dropped File still be read? A File is a snapshot of a file on
// disk: once that file is modified (tags written by a DJ tool, a sync
// client...), Chrome refuses to read it again (NotReadableError), and every
// <audio> load of it fails or hangs. Reads the first and last byte; a slow
// disk (no answer within 3 s) counts as readable.
function fileReadable (file) {
  if (!file || typeof file.slice !== 'function') return Promise.resolve(true)
  const size = file.size || 0
  const read = (a, b) => file.slice(a, b).arrayBuffer()
  return Promise.race([
    Promise.all([read(0, 1), size > 1 ? read(size - 1, size) : null]).then(() => true, () => false),
    new Promise((resolve) => setTimeout(() => resolve(true), 3000))
  ])
}

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

  // { id, file, url, name, duration, status: 'pending'|'ok'|'damaged'|'error',
  //   reason ('format'|'file', for 'error'), failedAt (s, for 'damaged'),
  //   played (it has produced sound at least once), preloadFailed }
  let tracks = []
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
      // seq: bumped by every (re)load / unload, so a late async step (file
      // check, retry) of an older load is dropped. lastTime / progressAt:
      // last position reached and when (the stall watchdog). played: it
      // produced sound since this load. rec: the recovery episode in
      // progress { base, tries, stalls }. busy: a failure is being handled.
      // retryTarget: where a recovery reload resumes (until its metadata).
      const deck = {
        el,
        gain,
        trackId: null,
        index: i,
        seq: 0,
        lastTime: 0,
        progressAt: 0,
        played: false,
        rec: null,
        busy: false,
        onMeta: null,
        retryTarget: null
      }
      el.addEventListener('error', () => onDeckFailure(deck, 'error'))
      el.addEventListener('ended', () => onDeckEnded(deck))
      el.addEventListener('pause', () => onDeckPause(deck))
      el.addEventListener('play', () => onDeckPlay(deck))
      el.addEventListener('timeupdate', () => {
        noteProgress(deck)
        if (deck === current) check()
      })
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

  // forget any failure handling / progress of the previous load
  function resetDeck (deck) {
    deck.seq++
    deck.lastTime = 0
    deck.played = false
    deck.rec = null
    deck.busy = false
    if (deck.onMeta) deck.el.removeEventListener('loadedmetadata', deck.onMeta)
    deck.onMeta = null
    deck.retryTarget = null
    arm(deck)
  }

  // A deck that is sounding was paused (or started) by something other than
  // the app: a hardware media key, the browser's media controls / Media
  // Session, headphones taken off... The app follows (pause() / play()), so
  // the transport stays truthful, a fade is held, and the stall watchdog
  // does not take the pause for a hang. The events are async: the element's
  // state *now* is what counts, and the app's own pauses / starts have
  // already changed `playing` (or are a reload: onMeta / busy) by then.
  function sounding (deck) {
    return deck === current || inFade(deck)
  }
  function onDeckPause (deck) {
    const el = deck.el
    if (!active || !playing || !el.paused || el.ended || deck.trackId === null) return
    if (deck.onMeta || deck.busy || !sounding(deck)) return
    console.info(`[playlist] pause externe (lecteur ${deck.index}) : la playlist se met en pause`)
    pause()
  }
  function onDeckPlay (deck) {
    const el = deck.el
    if (!active || playing || el.paused || deck !== current || deck.trackId !== currentId) return
    console.info(`[playlist] lecture externe (lecteur ${deck.index}) : la playlist reprend`)
    play()
  }

  // restart the stall watchdog's clock (a deck starting, resuming, seeking)
  function arm (deck) {
    deck.progressAt = performance.now()
  }

  function load (deck, track) {
    resetDeck(deck)
    if (deck.trackId === track.id && deck.el.getAttribute('src') === track.url && !deck.el.error) return
    deck.trackId = track.id
    deck.el.src = track.url
    deck.el.load()
  }

  function unload (deck) {
    resetDeck(deck)
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
        resetDeck(d)
        d.trackId = null
        d.el.removeAttribute('src')
        try { d.el.load() } catch (e) {}
      }
    })
    pendingRevoke.forEach((t) => {
      // never revoke a URL an element still uses (revoking it before or
      // during a load fails that load at once with a format error)
      if (decks.some((d) => d.trackId === t.id)) return
      if (probe && probe.track === t) return
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
      // the current track was given up: go on with the one after it, not
      // back to the top of the list
      const n = track ? nextIndex(track.id) : -1
      const i = n >= 0 ? n : firstPlayable()
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
    sounding.forEach(arm)
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
    const deck = current
    const track = trackById(currentId)
    // a new position: a recovery episode in progress is over (a failure
    // there starts a new one from that position)
    deck.rec = null
    if (deck.retryTarget !== null) {
      // a recovery reload is pending (no duration yet): it resumes here
      const d = track ? trackDuration(track, null) : 0
      deck.retryTarget = Math.max(0, d ? Math.min(t, d - 0.3) : t)
      arm(deck)
      emit('change')
      return
    }
    if (deck.busy || deck.el.error) {
      // a failure is being handled (its file check pending) or the element
      // is dead: the user's position wins -- the pending step is dropped
      // (seq) and the deck reloads straight at the new position
      if (!track) return
      const d = trackDuration(track, deck)
      retryAt(deck, track, Math.max(0, d ? Math.min(t, d - 0.3) : t))
      emit('change')
      return
    }
    const d = deck.el.duration
    if (!isFinite(d)) return
    deck.el.currentTime = Math.min(Math.max(0, t), Math.max(0, d - 0.05))
    arm(deck)
    if (!playing) holdGain(deck, 1)
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
    watchdog()
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
      // (a preload that failed is not retried every check: crossTo loads
      // it again, and a failure there is handled as the current deck's)
      if (free && next !== track && !next.preloadFailed) load(free, next)
    }
    if (x > MIN_FADE && left <= x + 0.02) crossTo(ni, Math.max(0.05, Math.min(x, left)))
  }

  // Stall watchdog: the current deck should be progressing (playing intent,
  // not ended). No progress for STALL_MS -- a load that never completes, a
  // read that hangs (a File changed on disk after the drop), a play() that
  // never resolves -- is handled like a media error, instead of silence
  // with the transport saying "playing". Not while the context is not
  // running (an interruption suspends the output; the clock restarts then).
  function watchdog () {
    const d = current
    if (!d || d.trackId === null || d.trackId !== currentId || d.busy || d.el.ended) return
    if (context.state !== 'running') { arm(d); return }
    // a paused element is not a hang (an external pause the 'pause' handler
    // has not seen yet), unless it is a recovery reload (paused by load()
    // until its metadata arrives: a reload that never gets there is one)
    if (d.el.paused && !d.onMeta) { arm(d); return }
    if (performance.now() - d.progressAt > STALL_MS) onDeckFailure(d, 'stall')
  }

  // Called on every 'timeupdate' (and from check()): records the progress
  // of a deck that is playing, which feeds the watchdog, marks the track as
  // played, closes a recovery episode once playback has gone HEAL_AFTER
  // past the retry point, and clears 'damaged' once a replay gets past the
  // spot that failed.
  function noteProgress (deck) {
    const el = deck.el
    if (deck.trackId === null || el.paused || el.seeking) return
    const t = el.currentTime
    if (!(t > 0) || t === deck.lastTime) return
    deck.lastTime = t
    arm(deck)
    deck.played = true
    const track = trackById(deck.trackId)
    if (!track) return
    track.played = true
    track.preloadFailed = false
    if (deck.rec && t > deck.rec.base + HEAL_AFTER + RETRY_SKIPS[Math.max(0, deck.rec.tries - 1)]) {
      console.info(`[playlist] « ${track.name} » : lecture rétablie (${formatTime(t)})`)
      deck.rec = null
    }
    if (track.status === 'damaged' && t > (track.failedAt || 0) + HEAL_AFTER) {
      track.status = 'ok'
      track.failedAt = null
      emit('change')
    }
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

  // ---- failures (see Failures at the top) ----

  // where the deck was when it failed: the element's position (a seek
  // target, a frozen position), else the last position it reached
  function failurePosition (deck) {
    const t = deck.el.currentTime
    return isFinite(t) && t > 0 ? t : deck.lastTime
  }

  // take a deck out of any fade and empty it (silent, paused)
  function releaseDeck (deck) {
    if (fade) {
      fade.entries = fade.entries.filter((e) => e.deck !== deck)
      if (!fade.entries.length) fade = null
    }
    unload(deck)
  }

  // kind: 'error' (the element's 'error' event) or 'stall' (watchdog)
  function onDeckFailure (deck, kind) {
    const el = deck.el
    // an element emptied on purpose (unload) or a failure already being
    // handled: nothing to do. load() / changing src drop the events queued
    // for the previous resource, so an old load's error cannot get here
    // with the new trackId.
    if (deck.trackId === null || !el.getAttribute('src') || deck.busy) return
    const track = trackById(deck.trackId)
    const err = kind === 'error' ? el.error : null
    const pos = failurePosition(deck)
    console.warn(
      `[playlist] ${kind === 'stall' ? `lecture bloquée (aucune progression depuis ${STALL_MS / 1000} s)` : 'erreur média'}` +
      ` sur le lecteur ${deck.index}, « ${track ? track.name : '(retiré)'} » à ${formatTime(pos)} (${pos.toFixed(2)} s)` +
      (err ? ` — MediaError ${err.code}${err.message ? ' : ' + err.message : ''}` : '') +
      ` [readyState ${el.readyState}, networkState ${el.networkState}]`
    )
    if (deck !== current || !track) {
      // an outgoing deck (fading out) or a preloaded one: there is nothing
      // to recover, it just leaves (crossTo loads a preloaded track again
      // when its turn comes, and handles a failure then)
      releaseDeck(deck)
      if (!track) return
      track.preloadFailed = true
      fileReadable(track.file).then((readable) => {
        if (!trackById(track.id)) return
        if (!readable) markError(track, 'file')
        else if (err && err.code === 4) markError(track, track.played ? 'file' : 'format')
      })
      return
    }
    deck.busy = true
    const seq = deck.seq
    fileReadable(track.file).then((readable) => {
      if (seq !== deck.seq) return // reloaded / unloaded meanwhile (busy reset there)
      deck.busy = false
      if (deck !== current || deck.trackId !== track.id || !trackById(track.id)) return
      // the File cannot be read any more: no retry can help
      if (!readable) { giveUp(deck, track, pos, 'file'); return }
      // MEDIA_ERR_SRC_NOT_SUPPORTED before any sound: a format the browser
      // does not play (AIFF / ALAC in Chrome...). Really unreadable.
      if (err && err.code === 4 && !track.played) { giveUp(deck, track, pos, 'format'); return }
      // ...after it played: the same File opened before and cannot be
      // opened now, so it changed on disk (moved / deleted files can still
      // pass the byte check). No retry or replay can help: re-drop it.
      if (err && err.code === 4) { giveUp(deck, track, pos, 'file'); return }
      const rec = deck.rec || (deck.rec = { base: pos, tries: 0, stalls: 0 })
      rec.tries++
      if (kind === 'stall') rec.stalls++
      // a track that never played gets one plain retry (a transient
      // failure); one that played gets the escalating skips
      const max = track.played ? RETRY_SKIPS.length : 1
      if (rec.tries > max || rec.stalls > STALL_RETRIES) {
        giveUp(deck, track, rec.base, track.played ? 'damaged' : 'format')
        return
      }
      const skip = !track.played || (kind === 'stall' && rec.tries === 1) ? 0 : RETRY_SKIPS[rec.tries - 1]
      const target = rec.base + skip
      const dur = trackDuration(track, deck)
      if (dur && target >= dur - 0.5) {
        // failed in its last moments: as good as its end
        console.warn(`[playlist] « ${track.name} » : erreur à la fin du morceau, passage au suivant`)
        releaseDeck(deck)
        advanceFrom(track, null)
        return
      }
      retryAt(deck, track, target, rec.tries, max)
    })
  }

  // Reload the same URL on the same deck and resume at `target`. The gain
  // is left alone when the deck is part of a fade (the fade's ramps go on
  // on the context clock); otherwise it is muted and faded back in once the
  // deck plays again, so the restart does not click.
  // The target is kept on the deck (retryTarget) until the metadata is in:
  // currentTime() shows it meanwhile (the reloaded element says 0), and a
  // seek in that window moves it. `attempt` / `max` only label the log (a
  // reload asked by a seek has none).
  function retryAt (deck, track, target, attempt, max) {
    const el = deck.el
    const seq = ++deck.seq
    deck.busy = false
    deck.lastTime = target
    deck.retryTarget = target
    arm(deck)
    if (!inFade(deck)) holdGain(deck, 0)
    if (deck.onMeta) el.removeEventListener('loadedmetadata', deck.onMeta)
    const onMeta = deck.onMeta = () => {
      el.removeEventListener('loadedmetadata', onMeta)
      deck.onMeta = null
      if (seq !== deck.seq) return
      const to = deck.retryTarget !== null ? deck.retryTarget : target
      deck.retryTarget = null
      deck.lastTime = to
      const d = el.duration
      try { el.currentTime = isFinite(d) ? Math.min(to, Math.max(0, d - 0.3)) : to } catch (e) {}
      // paused meanwhile: the position is set, play() resumes from there
      if (!playing || deck !== current) return
      arm(deck)
      el.play().then(() => {
        if (seq !== deck.seq || !playing || deck !== current) return
        if (fade && fade.start === null && fade.pausedAt === null && inFade(deck)) {
          // it failed while its crossfade was starting: the fade had not
          // been scheduled (crossTo's play() never resolved), do it now
          if (fade.dur <= 0.02) finishFade()
          else scheduleFade(0)
        } else if (!inFade(deck)) {
          holdGain(deck)
          deck.gain.gain.linearRampToValueAtTime(1, context.currentTime + 0.25)
        }
        emit('change')
      }, () => {}) // a failure comes back through 'error' or the watchdog
    }
    el.addEventListener('loadedmetadata', onMeta)
    console.info(`[playlist] « ${track.name} » : ${attempt ? `nouvel essai ${attempt}/${max}` : 'rechargement'}, reprise à ${formatTime(target)} (${target.toFixed(2)} s)`)
    el.src = track.url
    el.load()
  }

  // Retries exhausted (or pointless): mark the track and move on.
  // 'damaged': it played, then failed at `pos` -- kept clickable, a later
  // play tries it again. 'file' / 'format': status 'error', skipped.
  function giveUp (deck, track, pos, reason) {
    releaseDeck(deck)
    let msg
    if (reason === 'damaged') {
      track.status = 'damaged'
      track.failedAt = pos
      msg = `Erreur de lecture à ${formatTime(pos)} dans « ${track.name} »`
    } else {
      track.status = 'error'
      track.reason = reason
      msg = reason === 'file'
        ? `« ${track.name} » a été modifié, déplacé ou supprimé depuis son ajout : redéposez le fichier`
        : `Lecture impossible : ${track.name}`
    }
    console.warn(`[playlist] abandon de « ${track.name} » (${reason}) à ${formatTime(pos)}`)
    advanceFrom(track, msg)
  }

  // after `track` was abandoned: the next playable track starts (short
  // crossfade, so a deck still fading out is not cut). Stops only when
  // there is no other track to play (the end of the playlist).
  function advanceFrom (track, msg) {
    if (!playing) {
      if (msg) emit('error', msg)
      emit('change')
      return
    }
    const ni = nextIndex(track.id)
    if (ni >= 0 && tracks[ni].id !== track.id) {
      if (msg) emit('error', `${msg} — passage au morceau suivant`)
      crossTo(ni, Math.min(settings.crossfade, MANUAL_FADE))
    } else {
      if (msg) emit('error', msg)
      stopAll()
    }
  }

  // from the probe or a preloaded deck: the track cannot be played
  function markError (track, reason) {
    if (track.status === 'error') return
    track.status = 'error'
    track.reason = reason
    emit('error', reason === 'file'
      ? `« ${track.name} » a été modifié, déplacé ou supprimé depuis son ajout : redéposez le fichier`
      : `Lecture impossible : ${track.name}`)
    emit('change')
  }

  // ---- durations (metadata only, one file at a time) ----

  // Each probe has its own element, listeners and `finished` flag: done()
  // removes its listeners and empties its element, so a late event from an
  // old probe element can neither mark its track nor end the probe that is
  // running now. `probe` is the one running (null between two).
  const probeQueue = []
  let probe = null // { track, abort (id | null) => void }
  function abortProbe (id) {
    if (probe) probe.abort(id)
  }
  function probeNext () {
    if (probe) return
    const track = probeQueue.shift()
    if (!track) return
    if (!trackById(track.id)) { probeNext(); return }
    const el = new window.Audio()
    el.preload = 'metadata'
    let finished = false
    const onMeta = () => done(true)
    const onError = () => done(false)
    const self = probe = {
      track,
      abort: (id) => { if (id === null || id === track.id) done(true) }
    }
    function done (ok) {
      if (finished) return
      finished = true
      if (probe === self) probe = null
      clearTimeout(timeout)
      el.removeEventListener('loadedmetadata', onMeta)
      el.removeEventListener('error', onError)
      const duration = el.duration
      el.removeAttribute('src')
      try { el.load() } catch (e) {}
      if (!trackById(track.id)) {
        // removed (or cleared) meanwhile: its URL may be revoked already,
        // a failure here says nothing about the file
      } else if (ok && isFinite(duration) && duration > 0) {
        track.duration = duration
        if (track.status === 'pending') track.status = 'ok'
      } else if (!ok) {
        // only a track nothing has vouched for yet: a deck that loaded or
        // played it knows better than the probe
        if (track.status === 'pending' && !track.played) {
          fileReadable(track.file).then((readable) => {
            if (trackById(track.id) && track.status === 'pending' && !track.played) {
              markError(track, readable ? 'format' : 'file')
            }
          })
        }
      } else if (track.status === 'pending') {
        track.status = 'ok'
      }
      emit('change')
      probeNext()
    }
    // a file the browser hangs on: give up on the duration, not the track
    const timeout = setTimeout(() => done(true), 10000)
    el.addEventListener('loadedmetadata', onMeta)
    el.addEventListener('error', onError)
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
    currentTime () {
      if (!current || current.trackId !== currentId) return 0
      // during a recovery reload the element says 0: show where it resumes
      if (current.retryTarget !== null) return current.retryTarget
      return current.el.currentTime || 0
    },
    duration () {
      const t = trackById(currentId)
      return t ? trackDuration(t, current) : 0
    },
    totalDuration
  }
}
