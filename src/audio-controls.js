import css from 'dom-css'

export default function createAudioControls (audio, tracks) {
  const element = audio.element
  tracks = tracks.map((t) => Object.assign({}, t))
  const controlsContainer = document.querySelector('.controls-container')
  const trackSelector = document.querySelector('.track-selector')
  const titleEl = document.querySelector('.title')
  const artistEl = document.querySelector('.artist')
  const timeEl = document.querySelector('.elapsed-time')
  const seekerEl = document.querySelector('.seeker')
  const progressEl = document.querySelector('.progress')
  const playPauseEl = document.querySelector('.play-pause')

  let current = 0

  tracks.forEach((track, i) => {
    const trackEl = trackSelector.appendChild(document.createElement('li'))
    trackEl.classList.add('track')
    trackEl.addEventListener('click', () => {
      setTrack(i)
      audio.play()
    })
    const num = trackEl.appendChild(document.createElement('span'))
    num.textContent = `0${i + 1}.`
    trackEl.appendChild(document.createTextNode(' ' + track.title))
    track.el = trackEl
  })

  function setTrack (i) {
    current = i
    const track = tracks[i]
    if (!element.src.endsWith(track.path)) element.src = track.path
    tracks.forEach((t) => t.el.classList.remove('selected'))
    track.el.classList.add('selected')
    titleEl.textContent = track.title
    artistEl.textContent = track.artist
  }

  setTrack(0)

  // chain the mixes: when one ends, play the next one
  element.addEventListener('ended', () => {
    setTrack((current + 1) % tracks.length)
    audio.play()
  })

  let lastTime
  function tick () {
    if (element.currentTime !== lastTime && element.duration) {
      const t = element.currentTime / element.duration
      css(progressEl, 'width', `${t * 100}%`)
      timeEl.textContent = formatSeconds(element.currentTime)
    }
    lastTime = element.currentTime
  }

  seekerEl.addEventListener('click', (e) => {
    // measure on click so the seek stays correct after a resize
    const { left, width } = seekerEl.getBoundingClientRect()
    const t = (e.clientX - left) / width
    if (element.duration) element.currentTime = t * element.duration
  })

  function togglePlay () {
    if (element.paused) {
      audio.play()
    } else {
      audio.pause()
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target === document.body) {
      e.preventDefault()
      togglePlay()
    }
  })
  playPauseEl.addEventListener('click', togglePlay)

  return {
    el: controlsContainer,
    tick
  }
}

function formatSeconds (seconds) {
  const hours = (seconds / 3600) | 0
  const minutes = ((seconds % 3600) / 60) | 0
  const secs = String(seconds % 60 | 0).padStart(2, '0')
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}`
    : `${minutes}:${secs}`
}
