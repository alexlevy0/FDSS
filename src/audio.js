// Streams a track through an <audio> element and exposes its spectrum.
//
// Replaces web-audio-player + web-audio-analyser. The analyser reads the
// left channel with the Web Audio defaults (fftSize 2048 -> 1024 bins,
// -100..-30 dB, smoothing 0.8): that is what the old stereo setup actually
// used, since the fftSize/decibel tweaks were set on an array and ignored.
// The visuals were tuned against these values, so they are kept as is.
export default function createAudio (src) {
  const element = new window.Audio()
  element.preload = 'auto'
  element.src = src

  const AudioContext = window.AudioContext || window.webkitAudioContext
  const context = new AudioContext()
  const source = context.createMediaElementSource(element)
  source.connect(context.destination)

  const splitter = context.createChannelSplitter(2)
  const analyser = context.createAnalyser()
  analyser.fftSize = 2048
  analyser.minDecibels = -100
  analyser.maxDecibels = -30
  analyser.smoothingTimeConstant = 0.8
  source.connect(splitter)
  splitter.connect(analyser, 0)

  const freqData = new Uint8Array(analyser.frequencyBinCount)

  // Resolves as soon as the browser can start playing (no full download).
  const ready = new Promise((resolve, reject) => {
    element.addEventListener('canplay', resolve, { once: true })
    element.addEventListener('error', () => reject(element.error), { once: true })
  })

  return {
    element,
    ready,
    frequencies () {
      analyser.getByteFrequencyData(freqData)
      return freqData
    },
    // Resolves true if playback started, false if the browser blocked it
    // (autoplay policy: no user gesture yet).
    play () {
      if (context.state === 'suspended') context.resume()
      // the element can "play" while the context is still suspended (silent),
      // so only count it as started once the context is running too
      return element.play().then(() => context.state === 'running', () => false)
    },
    pause () {
      element.pause()
    }
  }
}
