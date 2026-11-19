// Minimal player overlay: play/pause, title/artist, track list, seek bar
// (click, drag, keyboard), elapsed / total time, Instagram link.
//
// It stays hidden until show() is called (index.js, after the intro), then
// auto-hides (fade + hidden cursor) after `idleDelay` ms without pointer,
// touch or key activity. It never hides while paused, while the pointer is
// over the player (or another registered zone such as the GUI), while a
// control has keyboard focus, or while seeking.
//
// opts.onTrackChange(index, track) is called whenever the selected track
// changes (initial selection, click in the list, auto-advance).
// opts.idleDelay: ms of inactivity before hiding (default 3000).

const reducedMotionQuery = typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null

export function prefersReducedMotion () {
  return !!(reducedMotionQuery && reducedMotionQuery.matches)
}

export default function createAudioControls (audio, tracks, opts = {}) {
  const onTrackChange = typeof opts.onTrackChange === 'function' ? opts.onTrackChange : null
  const idleDelay = opts.idleDelay || 3000
  const element = audio.element
  tracks = tracks.map((t) => Object.assign({}, t))

  const container = document.querySelector('.controls-container')
  const trackSelector = container.querySelector('.track-selector')
  const titleEl = container.querySelector('.title')
  const artistEl = container.querySelector('.artist')
  const currentTimeEl = container.querySelector('.elapsed-time .current')
  const totalTimeEl = container.querySelector('.elapsed-time .total')
  const seekerEl = container.querySelector('.seeker')
  const progressEl = container.querySelector('.progress')
  const thumbEl = container.querySelector('.seeker-thumb')
  const playPauseEl = container.querySelector('.play-pause')

  let current = -1 // set by setTrack(0) below

  // ---- track list ----

  tracks.forEach((track, i) => {
    const li = trackSelector.appendChild(document.createElement('li'))
    li.classList.add('track')
    const button = li.appendChild(document.createElement('button'))
    button.type = 'button'
    button.textContent = track.title
    button.setAttribute('aria-label', `Mix ${track.title}, ${track.artist}`)
    button.addEventListener('click', (e) => {
      setTrack(i)
      audio.play()
      // after a pointer click (detail > 0), do not leave focus on the pill:
      // Space would re-activate it (replay) instead of the global play/pause
      if (e.detail > 0) button.blur()
    })
    track.el = li
    track.button = button
  })

  function setTrack (i) {
    const changed = i !== current
    current = i
    const track = tracks[i]
    if (!element.src.endsWith(track.path)) element.src = track.path
    tracks.forEach((t) => {
      t.el.classList.remove('selected')
      t.button.removeAttribute('aria-current')
    })
    track.el.classList.add('selected')
    track.button.setAttribute('aria-current', 'true')
    titleEl.textContent = track.title
    artistEl.textContent = track.artist
    renderTime(true)
    if (changed && onTrackChange) onTrackChange(i, track)
  }

  // chain the mixes: when one ends, play the next one
  element.addEventListener('ended', () => {
    setTrack((current + 1) % tracks.length)
    audio.play()
  })

  // ---- time / progress ----

  let dragTime = null // seconds shown while dragging the seek bar
  let lastShown = -1
  let lastDuration = -1
  let lastStep = -1 // progress quantised to 1/PROGRESS_STEPS
  const PROGRESS_STEPS = 2000 // finer than any seek bar is wide in pixels

  function duration () {
    const d = element.duration
    return isFinite(d) && d > 0 ? d : 0
  }

  function renderTime (force) {
    // per-frame calls skip the work while the player is not on screen;
    // wake() re-renders it with force when it comes back
    if (!force && (!visible || idle)) return
    const d = duration()
    const t = dragTime !== null ? dragTime : (element.currentTime || 0)
    if (!force && t === lastShown && d === lastDuration) return
    lastShown = t
    const f = d ? Math.min(1, Math.max(0, t / d)) : 0
    // only touch the styles when the bar moves by a visible amount (it
    // otherwise changes every frame while playing)
    const step = Math.round(f * PROGRESS_STEPS)
    if (force || step !== lastStep) {
      lastStep = step
      progressEl.style.transform = `scaleX(${f})`
      thumbEl.style.left = `${f * 100}%`
    }
    const text = formatSeconds(t)
    if (currentTimeEl.textContent !== text) {
      currentTimeEl.textContent = text
      seekerEl.setAttribute('aria-valuenow', String(Math.round(t)))
      seekerEl.setAttribute('aria-valuetext', d ? `${text} sur ${formatSeconds(d)}` : text)
    }
    if (d !== lastDuration) {
      lastDuration = d
      totalTimeEl.textContent = d ? formatSeconds(d) : '–:––'
      seekerEl.setAttribute('aria-valuemax', String(Math.round(d)))
    }
  }

  element.addEventListener('durationchange', () => renderTime(true))
  element.addEventListener('loadedmetadata', () => renderTime(true))

  // called every animation frame by index.js
  function tick () {
    renderTime(false)
  }

  // ---- seek: click, drag (mouse / touch / pen), keyboard ----

  function timeAt (clientX) {
    // measured on each event so the seek stays right after a resize
    const { left, width } = seekerEl.getBoundingClientRect()
    const f = width > 0 ? Math.min(1, Math.max(0, (clientX - left) / width)) : 0
    return f * duration()
  }

  function seekTo (t) {
    const d = duration()
    if (!d) return
    element.currentTime = Math.min(Math.max(0, t), Math.max(0, d - 0.05))
    renderTime(true)
  }

  let dragPointer = null
  seekerEl.addEventListener('pointerdown', (e) => {
    if (!duration() || (e.pointerType === 'mouse' && e.button !== 0)) return
    e.preventDefault()
    dragPointer = e.pointerId
    try { seekerEl.setPointerCapture(e.pointerId) } catch (err) {}
    seekerEl.classList.add('is-dragging')
    dragTime = timeAt(e.clientX)
    renderTime(true)
  })
  seekerEl.addEventListener('pointermove', (e) => {
    if (e.pointerId !== dragPointer) return
    dragTime = timeAt(e.clientX)
    renderTime(true)
  })
  function endDrag (e, commit) {
    if (e.pointerId !== dragPointer) return
    dragPointer = null
    seekerEl.classList.remove('is-dragging')
    const t = commit ? timeAt(e.clientX) : null
    dragTime = null
    // seek once on release (seeking a streamed mp3 on every move stutters)
    if (t !== null) seekTo(t)
    else renderTime(true)
    scheduleIdle()
  }
  seekerEl.addEventListener('pointerup', (e) => endDrag(e, true))
  seekerEl.addEventListener('pointercancel', (e) => endDrag(e, false))
  seekerEl.addEventListener('lostpointercapture', (e) => {
    if (e.pointerId === dragPointer) endDrag(e, false)
  })

  seekerEl.addEventListener('keydown', (e) => {
    const d = duration()
    if (!d) return
    const step = e.shiftKey ? 30 : 5
    const now = element.currentTime
    let t = null
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp': t = now + step; break
      case 'ArrowLeft':
      case 'ArrowDown': t = now - step; break
      case 'PageUp': t = now + 60; break
      case 'PageDown': t = now - 60; break
      case 'Home': t = 0; break
      case 'End': t = d; break
    }
    if (t === null) return
    e.preventDefault()
    seekTo(t)
  })

  // ---- play / pause ----

  function togglePlay () {
    // While the audio context is still locked (autoplay policy) the element
    // may report "playing" in silence: treat that as paused and start it.
    const locked = audio.context && audio.context.state !== 'running'
    if (element.paused || locked) {
      audio.play()
    } else {
      audio.pause()
    }
  }

  function renderPlayState () {
    const playing = !element.paused
    playPauseEl.classList.toggle('is-playing', playing)
    playPauseEl.setAttribute('aria-label', playing ? 'Pause' : 'Lecture')
    if (!playing) wake()
    else scheduleIdle()
  }
  element.addEventListener('play', renderPlayState)
  element.addEventListener('pause', renderPlayState)
  playPauseEl.addEventListener('click', togglePlay)

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || isTypingTarget(e.target)) return
    if (e.ctrlKey || e.metaKey || e.altKey) return
    e.preventDefault()
    togglePlay()
  })

  // ---- visibility / auto-hide ----

  let visible = false
  let idle = false
  let idleTimer = null
  const hoverZones = new Set()
  let hoverCount = 0

  // focus left on a button after a mouse click should not pin the player,
  // only keyboard navigation inside it does: shortcuts such as G or Space
  // do not count, only keys that move focus or drive a control
  let lastInputWasKeyboard = false
  const NAV_KEYS = new Set([
    'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
    'Home', 'End', 'PageUp', 'PageDown', 'Enter'
  ])

  function busy () {
    if (element.paused || hoverCount > 0 || dragPointer !== null) return true
    return lastInputWasKeyboard && container.contains(document.activeElement)
  }

  function setIdle (value) {
    if (idle === value) return
    idle = value
    container.classList.toggle('is-idle', value)
    document.body.classList.toggle('ui-idle', value)
  }

  function scheduleIdle () {
    clearTimeout(idleTimer)
    if (!visible) return
    idleTimer = setTimeout(() => {
      if (busy()) scheduleIdle()
      else setIdle(true)
    }, idleDelay)
  }

  function wake () {
    const wasHidden = idle
    setIdle(false)
    scheduleIdle()
    if (wasHidden) renderTime(true)
  }

  const activity = () => { if (visible) wake() }
  window.addEventListener('pointermove', activity, { passive: true })
  window.addEventListener('pointerdown', (e) => {
    lastInputWasKeyboard = false
    activity(e)
  }, { passive: true })
  window.addEventListener('touchstart', activity, { passive: true })
  window.addEventListener('wheel', activity, { passive: true })
  window.addEventListener('keydown', (e) => {
    if (NAV_KEYS.has(e.key)) lastInputWasKeyboard = true
    activity()
  })

  // Pointer over a zone (the player, the GUI...) keeps everything visible.
  // Only real hover counts: touch "enter" has no matching hover state.
  function addHoverZone (el) {
    if (!el || hoverZones.has(el)) return
    hoverZones.add(el)
    let inside = false
    el.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'touch' || inside) return
      inside = true
      hoverCount++
      wake()
    })
    el.addEventListener('pointerleave', (e) => {
      if (!inside) return
      inside = false
      hoverCount = Math.max(0, hoverCount - 1)
      scheduleIdle()
    })
  }
  addHoverZone(container)
  container.addEventListener('focusin', wake)

  // initial selection, once every piece of state above exists
  setTrack(0)
  renderPlayState()

  // First appearance (after the intro). `fade` = { duration (ms), easing }.
  function show (fade = {}) {
    if (visible) return
    visible = true
    const ms = prefersReducedMotion() ? 0 : (fade.duration || 0)
    if (ms) {
      container.style.transition =
        `opacity ${ms}ms ${fade.easing || 'ease'}, visibility 0s`
      setTimeout(() => { container.style.transition = '' }, ms + 50)
    }
    container.classList.add('is-visible')
    wake()
    renderTime(true)
  }

  return {
    el: container,
    tick,
    show,
    wake,
    addHoverZone,
    isIdle: () => idle,
    getCurrentTrack: () => current
  }
}

// Keyboard shortcuts must not fire while typing in a field (lil-gui inputs).
export function isTextField (target) {
  if (!target || !target.tagName) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

// Space is also left alone when a focused control handles it natively
// (buttons, links) or uses keys itself (the seek slider).
export function isTypingTarget (target) {
  if (isTextField(target)) return true
  if (!target || !target.tagName) return false
  const tag = target.tagName
  if (tag === 'BUTTON' || tag === 'A') return true
  return target.getAttribute('role') === 'slider'
}

function formatSeconds (seconds) {
  seconds = Math.max(0, seconds || 0)
  const hours = (seconds / 3600) | 0
  const minutes = ((seconds % 3600) / 60) | 0
  const secs = String(seconds % 60 | 0).padStart(2, '0')
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}`
    : `${minutes}:${secs}`
}
