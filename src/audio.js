// Streams a track through an <audio> element and exposes its spectrum.
//
// Replaces web-audio-player + web-audio-analyser. The analyser reads the
// left channel with the Web Audio defaults (fftSize 2048 -> 1024 bins,
// -100..-30 dB, smoothing 0.8): that is what the old stereo setup actually
// used, since the fftSize/decibel tweaks were set on an array and ignored.
// The visuals were tuned against these values, so they are kept as is.
// A second analyser with the same settings reads the right channel, for the
// stereo features (bandsL / bandsR).
//
// Live input: useStream(stream) swaps the analysers' input from the file
// to a MediaStream (microphone, virtual device, shared tab), through a gain
// node so a quiet mic can be lifted without touching the file-mode tuning.
// The stream is never connected to the destination: the sound is already
// playing in the room / the other tab, so routing it out again would echo
// (and feed back with a mic). useFile() switches back. Both paths share the
// splitter, so everything downstream is unchanged.
export default function createAudio (src) {
  const element = new window.Audio()
  element.preload = 'auto'
  element.src = src

  const AudioContext = window.AudioContext || window.webkitAudioContext
  const context = new AudioContext()
  const source = context.createMediaElementSource(element)
  source.connect(context.destination)

  const splitter = context.createChannelSplitter(2)
  const createChannelAnalyser = () => {
    const a = context.createAnalyser()
    a.fftSize = 2048
    a.minDecibels = -100
    a.maxDecibels = -30
    a.smoothingTimeConstant = 0.8
    return a
  }
  // one analyser per channel, same settings; `analyser` stays the left one
  // (layout, bin count and decibel range are read from it)
  const analyser = createChannelAnalyser()
  source.connect(splitter)
  splitter.connect(analyser, 0)
  let analyserR = null
  try {
    analyserR = createChannelAnalyser()
    splitter.connect(analyserR, 1)
  } catch (e) {
    analyserR = null
  }

  // A silent sink pulls the analysers: a branch that never reaches the
  // destination may not be rendered at all (Chrome left a live stream's
  // analysers at -Infinity in testing). Gain 0, so nothing is heard.
  const sink = context.createGain()
  sink.gain.value = 0
  sink.connect(context.destination)
  analyser.connect(sink)
  if (analyserR) analyserR.connect(sink)

  // live path: MediaStreamSource -> liveGain -> splitter (never audible)
  const liveGain = context.createGain()
  // Most mics (built-in, USB) give a mono stream even when stereo is asked
  // for, and the splitter is 'discrete': a mono input would leave the right
  // analyser silent and every stereo feature hard left. Forcing 2 channels
  // with the 'speakers' rule copies mono to both sides; stereo passes as is.
  liveGain.channelCount = 2
  liveGain.channelCountMode = 'explicit'
  liveGain.channelInterpretation = 'speakers'
  liveGain.gain.value = 1
  liveGain.connect(splitter)
  let streamSource = null
  let fileConnected = true
  // webkitAudioContext (Safari < 14.1) only has disconnect(output): a node
  // argument is coerced to output 0 instead of throwing, which would also
  // cut the speakers. There, drop everything and re-add the speakers.
  const prefixed = !window.AudioContext

  function disconnectFile () {
    if (!fileConnected) return
    fileConnected = false
    if (prefixed) {
      source.disconnect()
      source.connect(context.destination)
      return
    }
    try {
      source.disconnect(splitter)
    } catch (e) {
      source.disconnect()
      source.connect(context.destination)
    }
  }

  // WebKit also has an 'interrupted' state (iOS audio session taken, e.g.
  // by starting a mic capture): anything but running / closed is resumed
  const needsResume = () => context.state !== 'running' && context.state !== 'closed'

  function resumeContext () {
    if (needsResume()) context.resume().catch(() => {})
  }

  // resume() may stay pending forever without a gesture: bounded wait
  function resumeBounded () {
    return Promise.race([
      context.resume().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 500))
    ])
  }

  const freqData = new Uint8Array(analyser.frequencyBinCount)
  const floatFreqData = new Float32Array(analyser.frequencyBinCount)
  const floatFreqDataR = analyserR ? new Float32Array(analyserR.frequencyBinCount) : null

  // Resolves once the track's metadata is known; rejects if it fails to
  // load. Nothing should block on it: iOS Safari fetches nothing before a
  // user gesture, so it may only settle after the first play().
  const ready = new Promise((resolve, reject) => {
    element.addEventListener('loadedmetadata', resolve, { once: true })
    element.addEventListener('error', () => reject(element.error), { once: true })
  })

  return {
    element,
    ready,
    context,
    analyser,
    analyserR,
    sampleRate: context.sampleRate,
    frequencies () {
      analyser.getByteFrequencyData(freqData)
      return freqData
    },
    // Same spectrum in dB (not clipped to min/maxDecibels), so the analysis
    // keeps headroom on loud passages. Silent bins can be -Infinity.
    floatFrequencies () {
      analyser.getFloatFrequencyData(floatFreqData)
      return floatFreqData
    },
    // right channel, same format; null when there is no second analyser.
    // A mono file gives a silent right channel here (the splitter does not
    // up-mix): the analysis detects that and falls back to the left one.
    floatFrequenciesR () {
      if (!analyserR) return null
      analyserR.getFloatFrequencyData(floatFreqDataR)
      return floatFreqDataR
    },
    // Feeds the analysers from `stream` (its audio tracks) instead of the
    // file. The file is paused. Throws if the stream has no usable audio
    // (createMediaStreamSource does), leaving the current input in place.
    useStream (stream) {
      const next = context.createMediaStreamSource(stream)
      if (streamSource) streamSource.disconnect()
      streamSource = next
      next.connect(liveGain)
      disconnectFile()
      element.pause()
      resumeContext()
    },
    // back to the file (left paused: the caller decides whether to play)
    useFile () {
      if (streamSource) {
        streamSource.disconnect()
        streamSource = null
      }
      if (!fileConnected) {
        source.connect(splitter)
        fileConnected = true
      }
    },
    isLive () {
      return !!streamSource
    },
    // what the visuals treat as "sound is flowing": a live input always
    // counts, the file only while it plays
    isPlaying () {
      return streamSource ? true : !element.paused
    },
    setLiveGain (value) {
      const v = Number(value)
      if (isFinite(v) && v >= 0) liveGain.gain.value = v
    },
    resumeContext,
    // Resolves true if playback started, false if the browser blocked it
    // (autoplay policy: no user gesture yet). In live mode there is nothing
    // to start but the context itself.
    play () {
      if (streamSource) {
        if (!needsResume()) return Promise.resolve(context.state === 'running')
        return resumeBounded().then(() => context.state === 'running')
      }
      // Wait for the context to resume as well: on a real gesture the element
      // can start before resume() settles. resume() may also stay pending
      // forever without a gesture, so the wait is bounded.
      const resumed = needsResume() ? resumeBounded() : null
      // the element can "play" while the context is still suspended (silent),
      // so only count it as started once the context is running too
      return Promise.all([resumed, element.play()])
        .then(() => context.state === 'running', () => false)
    },
    pause () {
      element.pause()
    }
  }
}
