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
// opts.live: optional live input (live-input.js). Adds the LIVE button and
// its chooser (micro / tab or screen), the L shortcut, and a live state in
// which the seek bar and time are hidden, play/pause stops the live input
// and a track button goes back to the file player.
// opts.production: optional playlist (playlist.js). While its mode is active
// the bar drives it instead of the mixes: title = current playlist track,
// play/pause, seek bar and time act on that track; a mix (or LIVE) leaves
// the mode. pin(key, on) keeps the bar on screen while something (the
// production panel) is open.

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
  const live = opts.live || null
  const liveEl = container.querySelector('.live')
  const liveToggleEl = container.querySelector('.live-toggle')
  const liveMenuEl = container.querySelector('.live-menu')
  const liveDeviceEl = container.querySelector('.live-device')
  const messageEl = container.querySelector('.live-message')
  const isLive = () => !!(live && live.isActive())
  const production = opts.production || null
  const isProd = () => !!(production && production.isActive())

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
      // a mix picked while live, or while a live start waits on its
      // permission prompt / share picker: back to the file player. stop()
      // also cancels a pending start (the late stream is discarded), so
      // granting the prompt afterwards does not override this choice.
      if (live) live.stop()
      // a mix also leaves production mode (the playlist is paused)
      if (isProd()) production.leave()
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
    if (!isLive() && !isProd()) renderMeta()
    renderTime(true)
    if (changed && onTrackChange) onTrackChange(i, track)
  }

  function renderMeta () {
    if (isProd() && !isLive()) {
      const t = production.getCurrentTrack()
      titleEl.textContent = t ? t.name : 'Glisse des morceaux'
      artistEl.textContent = 'production'
      return
    }
    const state = isLive() ? live.getState() : null
    titleEl.textContent = state ? state.label : tracks[current].title
    // the source type, not "live" again (the toggle and the dot say it)
    artistEl.textContent = state ? (state.kind === 'mic' ? 'micro' : 'partage') : tracks[current].artist
  }

  // chain the mixes: when one ends, play the next one
  element.addEventListener('ended', () => {
    if (isProd()) return
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
    const d = isProd() ? production.duration() : element.duration
    return isFinite(d) && d > 0 ? d : 0
  }

  function position () {
    return (isProd() ? production.currentTime() : element.currentTime) || 0
  }

  function renderTime (force) {
    // per-frame calls skip the work while the player is not on screen;
    // wake() re-renders it with force when it comes back
    if (!force && (!visible || idle)) return
    if (isLive()) return // no position in a live input (bar and time hidden)
    const d = duration()
    const t = dragTime !== null ? dragTime : position()
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
    if (isProd()) production.seek(t)
    else element.currentTime = Math.min(Math.max(0, t), Math.max(0, d - 0.05))
    renderTime(true)
  }

  let dragPointer = null
  seekerEl.addEventListener('pointerdown', (e) => {
    if (isLive() || !duration() || (e.pointerType === 'mouse' && e.button !== 0)) return
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
    if (!d || isLive()) return
    const step = e.shiftKey ? 30 : 5
    const now = position()
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
    // live: the button is a stop button (back to the paused file player)
    if (isLive()) {
      live.stop()
      return
    }
    // going back to the file cancels a live start still waiting on its
    // prompt / picker (also the startup one of ?live=mic)
    if (live) live.stop()
    if (isProd()) {
      production.togglePlay()
      return
    }
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
    const liveNow = isLive()
    const playing = liveNow || (isProd() ? production.wantsPlay() : !element.paused)
    playPauseEl.classList.toggle('is-playing', playing)
    playPauseEl.setAttribute('aria-label', liveNow ? 'Arrêter le live' : playing ? 'Pause' : 'Lecture')
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
  const pins = new Set()

  // focus left on a button after a mouse click should not pin the player,
  // only keyboard navigation inside it does: shortcuts such as G or Space
  // do not count, only keys that move focus or drive a control
  let lastInputWasKeyboard = false
  const NAV_KEYS = new Set([
    'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
    'Home', 'End', 'PageUp', 'PageDown', 'Enter'
  ])

  function busy () {
    if (!isLive() && (isProd() ? !production.wantsPlay() : element.paused)) return true
    if (pins.size > 0) return true
    if (hoverCount > 0 || dragPointer !== null || menuOpen || messageTimer) return true
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

  // ---- live input ----

  let menuOpen = false
  let messageTimer = null
  let pending = false
  let queuedMessage = null // shown by show() when the player was not on screen

  // short message above the bar (errors, "live ended"); fades by itself.
  // Before the first show() the bar is invisible: keep it for show().
  function showMessage (text, ms = 4500) {
    if (!messageEl || !text) return
    if (!visible) {
      queuedMessage = { text, ms }
      return
    }
    messageEl.textContent = text
    messageEl.classList.add('is-shown')
    clearTimeout(messageTimer)
    messageTimer = setTimeout(() => {
      messageTimer = null
      messageEl.classList.remove('is-shown')
      scheduleIdle()
    }, ms)
    if (visible) wake()
  }

  function setMenu (open) {
    if (!liveMenuEl) return
    menuOpen = open
    liveMenuEl.hidden = !open
    if (live && live.supported.display) liveToggleEl.setAttribute('aria-expanded', String(open))
    if (open) wake()
    else scheduleIdle()
  }

  function startLive (kind, deviceId) {
    setMenu(false)
    if (!live || pending) return
    pending = true
    liveToggleEl.classList.add('is-pending')
    live.start(kind, deviceId).then((result) => {
      pending = false
      liveToggleEl.classList.remove('is-pending')
      if (result && !result.ok && result.message) showMessage(result.message)
    }, () => {
      pending = false
      liveToggleEl.classList.remove('is-pending')
    })
  }

  function toggleLive () {
    if (!live) return
    if (isLive()) {
      live.stop()
    } else if (live.supported.display) {
      setMenu(!menuOpen)
    } else {
      // a single source: no menu to go through
      startLive('mic')
    }
  }

  function renderDevices (state) {
    if (!liveDeviceEl) return
    const show = state.active && state.kind === 'mic' && state.devices.length > 1
    liveDeviceEl.hidden = !show
    if (!show) return
    liveDeviceEl.textContent = ''
    state.devices.forEach((d) => {
      const option = liveDeviceEl.appendChild(document.createElement('option'))
      option.value = d.deviceId
      option.textContent = d.label
    })
    if (state.deviceId) liveDeviceEl.value = state.deviceId
  }

  function renderLive (state) {
    container.classList.toggle('is-live', state.active)
    liveToggleEl.setAttribute('aria-pressed', String(state.active))
    liveToggleEl.setAttribute('aria-label', state.active ? 'Quitter le live (L)' : 'Entrée live (L)')
    seekerEl.tabIndex = state.active ? -1 : 0
    seekerEl.setAttribute('aria-hidden', String(state.active))
    renderMeta()
    renderDevices(state)
    renderPlayState()
    if (!state.active) renderTime(true)
  }

  if (live && liveEl) {
    // only offer it when a source can work; an insecure page keeps it so
    // the https hint can be shown
    liveEl.hidden = !(live.supported.mic || live.supported.display || window.isSecureContext === false)
    // no chooser without a second source: a click starts the mic directly
    if (!live.supported.display) {
      liveToggleEl.removeAttribute('aria-haspopup')
      liveToggleEl.removeAttribute('aria-expanded')
    }
    if (liveMenuEl) {
      liveMenuEl.querySelectorAll('[data-live]').forEach((button) => {
        if (!live.supported[button.dataset.live]) button.hidden = true
        button.addEventListener('click', () => startLive(button.dataset.live))
      })
    }
    liveToggleEl.addEventListener('click', (e) => {
      toggleLive()
      // as for the track pills: a mouse click must not leave focus on the
      // button, or Space would re-activate it (isTypingTarget)
      if (e.detail > 0 && !menuOpen) liveToggleEl.blur()
      // opened from the keyboard: move into the menu (Escape comes back)
      if (e.detail === 0 && menuOpen) {
        const first = liveMenuEl.querySelector('[data-live]:not([hidden])')
        if (first) first.focus()
      }
    })
    if (liveDeviceEl) {
      liveDeviceEl.addEventListener('change', () => {
        if (!liveDeviceEl.value) return
        // a start is already waiting: this choice is dropped, so put the
        // select back on the device that really feeds the analysers
        if (pending) {
          liveDeviceEl.value = live.getState().deviceId
          return
        }
        startLive('mic', liveDeviceEl.value)
      })
    }
    // the menu closes on any press outside it, and on Escape
    window.addEventListener('pointerdown', (e) => {
      if (menuOpen && !liveEl.contains(e.target)) setMenu(false)
    }, true)
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && menuOpen) {
        setMenu(false)
        liveToggleEl.focus()
        return
      }
      // L toggles the live mic once the player is on screen
      if (e.code !== 'KeyL' || e.repeat || !visible || liveEl.hidden) return
      // only real text fields block it: L does nothing on a focused button,
      // link or slider (unlike Space)
      if (e.ctrlKey || e.metaKey || e.altKey || isTextField(e.target)) return
      e.preventDefault()
      setMenu(false)
      if (isLive()) live.stop()
      else startLive('mic')
    })
    live.subscribe((state) => {
      if (state.reason === 'devices') {
        renderDevices(state)
        return
      }
      renderLive(state)
      if (state.reason === 'ended') showMessage('Live terminé — retour au lecteur')
      if (visible) wake()
    })
  }

  // ---- production mode ----

  function renderProd () {
    const on = isProd()
    container.classList.toggle('is-prod', on)
    renderMeta()
    renderPlayState()
    renderTime(true)
  }
  if (production) production.subscribe((type) => { if (type === 'change' || type === 'mode') renderProd() })

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
    if (queuedMessage) {
      const { text, ms } = queuedMessage
      queuedMessage = null
      showMessage(text, ms)
    }
  }

  return {
    el: container,
    tick,
    show,
    wake,
    addHoverZone,
    // keeps the bar on screen while `on` (e.g. a panel is open)
    pin (key, on) {
      if (on) pins.add(key)
      else pins.delete(key)
      if (visible) wake()
    },
    isShown: () => visible,
    isIdle: () => idle,
    showMessage,
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
