// Live input: feeds the visuals from what is playing elsewhere (Spotify, a
// DJ set...) instead of the bundled mixes.
//
//   'mic'      getUserMedia: a microphone, or a virtual device such as
//              BlackHole / Loopback that carries the computer's own output
//   'display'  getDisplayMedia: the audio of a shared tab / window / screen
//              (desktop Chromium only: Firefox and Safari never return
//              audio from it; the video track is dropped at once)
//
// Opening, switching and closing the streams lives here; audio.useStream /
// audio.useFile only rewire the analysers. Every state change is reported to
// subscribers as { active, kind, label, deviceId, devices, reason } where
// reason is 'start' | 'stop' | 'ended' (the stream died on its own: "stop
// sharing" clicked, device unplugged) | 'devices' (input list refreshed).
// start() never rejects: it resolves { ok, message? } so the UI can show a
// short French message instead of an alert (none when the user cancelled
// the share picker on purpose).

const STORAGE_KEY = 'fdss.liveDeviceId'

// raw signal: the browser's voice processing would duck and "clean" music
const RAW_AUDIO = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false
}

function readStoredDevice () {
  try { return window.localStorage.getItem(STORAGE_KEY) || '' } catch (e) { return '' }
}

function storeDevice (id) {
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id)
  } catch (e) {}
}

function stopTracks (stream) {
  if (!stream) return
  stream.getTracks().forEach((t) => {
    try { t.stop() } catch (e) {}
  })
}

const SURFACE_LABELS = { browser: 'Onglet', window: 'Fenêtre', monitor: 'Écran' }

function errorMessage (kind, err) {
  const name = (err && err.name) || ''
  if (name === 'NoAudioError') return 'Aucun son partagé — coche « Partager l\'audio » dans la fenêtre de partage'
  // a window, or a whole screen without system audio: no checkbox to tick
  if (name === 'NoAudioSurfaceError') return 'Cette source ne transmet pas le son — partage un onglet Chrome'
  if (name === 'InsecureContextError') return 'Le live demande une page en https'
  if (name === 'UnsupportedError') return 'Entrée live non disponible sur ce navigateur'
  // Firefox: a mic whose sample rate differs from the context's
  if (name === 'NotSupportedError') return 'Ce navigateur ne peut pas analyser ce micro (fréquence d\'échantillonnage)'
  if (kind === 'display') {
    // a cancelled picker (Chrome reports it as NotAllowedError too) is a
    // deliberate choice: nothing to say
    if (name === 'NotAllowedError' || name === 'AbortError') return ''
    if (name === 'NotReadableError') return 'Impossible de capturer cette source'
    return 'Partage impossible'
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Accès au micro refusé'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Aucun micro trouvé'
  if (name === 'NotReadableError') return 'Micro indisponible (déjà utilisé ?)'
  return 'Micro inaccessible'
}

function namedError (name) {
  const e = new Error(name)
  e.name = name
  return e
}

function isMobile () {
  const nav = window.navigator || {}
  if (nav.userAgentData && typeof nav.userAgentData.mobile === 'boolean') return nav.userAgentData.mobile
  return /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent || '')
}

function supportsCaptureAudio (md) {
  try {
    const c = typeof md.getSupportedConstraints === 'function' ? md.getSupportedConstraints() : {}
    return !!c.suppressLocalAudioPlayback || typeof window.CaptureController === 'function'
  } catch (e) {
    return false
  }
}

export default function createLiveInput (audio) {
  const md = window.navigator && window.navigator.mediaDevices
  const supported = {
    mic: !!(md && typeof md.getUserMedia === 'function'),
    // Only Chromium shares tab / system audio; Firefox and Safari have
    // getDisplayMedia but never return an audio track, so the option could
    // never work there. suppressLocalAudioPlayback is a Chromium-only
    // constraint, which makes it a feature test for capture audio. Mobile
    // browsers either lack getDisplayMedia or never share audio.
    display: !!(md && typeof md.getDisplayMedia === 'function') && !isMobile() &&
      supportsCaptureAudio(md)
  }

  let stream = null
  let kind = null
  let label = ''
  let deviceId = ''
  let devices = [] // [{ deviceId, label }] audio inputs, once labels exist
  let seq = 0 // bumped by every start / stop: a late stream is discarded
  let inFlight = 0 // start() calls waiting on a prompt / picker
  const listeners = new Set()

  function state (reason) {
    return { active: !!stream, kind, label, deviceId, devices, reason }
  }

  function emit (reason) {
    const s = state(reason)
    listeners.forEach((fn) => {
      try { fn(s) } catch (e) { console.error(e) }
    })
  }

  async function openMic (wanted) {
    const id = wanted || readStoredDevice()
    if (id) {
      try {
        return await md.getUserMedia({ audio: Object.assign({}, RAW_AUDIO, { channelCount: 2, deviceId: { exact: id } }) })
      } catch (err) {
        // a remembered device that is gone falls back to the default one;
        // an explicit choice that fails is reported
        const gone = err && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')
        if (wanted || !gone) throw err
      }
    }
    return md.getUserMedia({ audio: Object.assign({}, RAW_AUDIO, { channelCount: 2 }) })
  }

  async function openDisplay () {
    const s = await md.getDisplayMedia({
      // Chrome refuses an audio-only request; the video is dropped below
      video: true,
      audio: Object.assign({}, RAW_AUDIO, { suppressLocalAudioPlayback: false }),
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      systemAudio: 'include'
    })
    let surface = ''
    s.getVideoTracks().forEach((t) => {
      try {
        const settings = t.getSettings ? t.getSettings() : {}
        surface = surface || settings.displaySurface || ''
      } catch (e) {}
      try { t.stop() } catch (e) {}
      s.removeTrack(t)
    })
    if (!s.getAudioTracks().length) {
      stopTracks(s)
      // only a tab offers the "share audio" checkbox in Chrome's picker
      throw namedError(surface && surface !== 'browser' ? 'NoAudioSurfaceError' : 'NoAudioError')
    }
    s._fdssLabel = SURFACE_LABELS[surface] || 'Onglet ou écran'
    return s
  }

  async function refreshDevices () {
    if (!md || typeof md.enumerateDevices !== 'function') return
    try {
      const list = await md.enumerateDevices()
      devices = list
        .filter((d) => d.kind === 'audioinput' && d.deviceId)
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Entrée ${i + 1}` }))
      emit('devices')
    } catch (e) {}
  }
  if (md && typeof md.addEventListener === 'function') {
    md.addEventListener('devicechange', () => {
      if (kind === 'mic') refreshDevices()
    })
  }

  function attach (s, which) {
    const prev = stream
    audio.useStream(s) // throws on a stream the context cannot read
    stream = s
    kind = which
    const track = s.getAudioTracks()[0]
    if (which === 'mic') {
      let settings = {}
      try { settings = track && track.getSettings ? track.getSettings() : {} } catch (e) {}
      deviceId = settings.deviceId || ''
      storeDevice(deviceId)
      label = (track && track.label) || 'Micro'
    } else {
      deviceId = ''
      label = s._fdssLabel || 'Onglet ou écran'
    }
    if (prev && prev !== s) stopTracks(prev)
    // "stop sharing", device unplugged, permission revoked: back to the
    // file player (our own stop() does not fire 'ended'). Ignored while a
    // start is pending: WebKit allows one mic capture per page and ends the
    // current track as soon as the next device is granted, which must not
    // end live mode (and discard the new stream) mid-switch; start()
    // re-checks once it settles.
    s.getAudioTracks().forEach((t) => {
      t.addEventListener('ended', () => {
        if (stream === s && !inFlight) stop('ended')
      })
    })
  }

  // after a start settles: if the current stream died meanwhile (failed or
  // cancelled switch, WebKit single capture), leave live mode now
  function checkEnded () {
    if (!stream || inFlight) return
    const tracks = stream.getAudioTracks()
    if (tracks.length && tracks.every((t) => t.readyState === 'ended')) stop('ended')
  }

  async function start (which = 'mic', wantedDevice) {
    inFlight++
    try {
      return await startNow(which, wantedDevice)
    } finally {
      inFlight--
      checkEnded()
    }
  }

  async function startNow (which, wantedDevice) {
    const id = ++seq
    // resume inside the click / key gesture, before the first await
    if (audio.resumeContext) audio.resumeContext()
    let s = null
    try {
      if (!supported[which]) {
        throw namedError(window.isSecureContext === false ? 'InsecureContextError' : 'UnsupportedError')
      }
      s = which === 'mic' ? await openMic(wantedDevice) : await openDisplay()
      if (id !== seq) {
        // stopped or restarted while the prompt was open
        stopTracks(s)
        return { ok: false, stale: true }
      }
      attach(s, which)
    } catch (err) {
      stopTracks(s)
      if (id !== seq) return { ok: false, stale: true }
      console.warn('live input failed', err)
      return { ok: false, message: errorMessage(which, err) }
    }
    emit('start')
    // labels are only exposed once a permission is granted
    if (which === 'mic') refreshDevices()
    return { ok: true }
  }

  function stop (reason = 'stop') {
    seq++
    if (!stream) return
    const s = stream
    stream = null
    kind = null
    label = ''
    deviceId = ''
    stopTracks(s)
    audio.useFile()
    emit(reason)
  }

  return {
    supported,
    start,
    stop,
    isActive: () => !!stream,
    getState: () => state(null),
    subscribe (fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }
  }
}
