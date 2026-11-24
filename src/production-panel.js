// Production panel: the playlist's UI (playlist.js is the engine).
//
//   P key / PROD button   open the panel (entering production mode if
//                         needed) or close it. Closing (P, Escape, ×) only
//                         hides the panel: the playlist keeps playing and the
//                         visuals keep following it. "Quitter" leaves the
//                         mode (playlist paused, back to the paused mixes),
//                         as picking a mix or LIVE in the player does.
//   drop files anywhere   audio files are appended to the playlist (the mode
//                         is entered if it was not: dropping music is an
//                         unambiguous request for it); a full-window overlay
//                         shows while files are dragged over the page.
//   "Ajouter"             same through a file picker.
//
// The list: click a name to crossfade into that track; drag the handle
// (mouse, touch or pen) or use the arrow buttons to reorder; × removes.
// Settings (crossfade, curve, loop) are kept in localStorage by the engine.
//
// "Exporter" renders the whole playlist, in its current order and with the
// same crossfades, into one WAV file that the browser downloads
// (playlist-export.js). It works on a snapshot taken at the click: the list
// and the settings stay editable and playback goes on meanwhile, and the
// progress block says so ("Figé au lancement : 30 morceaux, fondu 6 s,
// …"). A progress bar with the track being processed and "Annuler" replace
// the button until it is done. Tracks the playlist already marks
// unreadable are left out and reported with those the export fails to
// decode. Reloading or closing the tab while it runs asks for confirmation.
//
// Focus. As everywhere in the player, a control clicked with the mouse (or
// touched) does not keep the focus, so Space stays play / pause and P stays
// the panel toggle; keyboard activation keeps the focus where a keyboard
// user expects it. P opening the panel focuses the panel itself (Tab then
// goes into it, Space still plays / pauses); closing it with the focus on
// one of its controls returns the focus to the PROD button.

import { isTextField } from './audio-controls'
import { AUDIO_EXTENSIONS, isAudioFile } from './playlist'
import { exportPlaylist, downloadBlob } from './playlist-export'

const ACCEPT = 'audio/*,' + AUDIO_EXTENSIONS.map((e) => '.' + e).join(',')

function formatSeconds (seconds) {
  seconds = Math.max(0, seconds || 0)
  const hours = (seconds / 3600) | 0
  const minutes = ((seconds % 3600) / 60) | 0
  const secs = String(seconds % 60 | 0).padStart(2, '0')
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}`
    : `${minutes}:${secs}`
}

function el (tag, className, text) {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

function button (className, text, label) {
  const b = el('button', className, text)
  b.type = 'button'
  if (label) {
    b.setAttribute('aria-label', label)
    b.title = label
  }
  return b
}

export default function createProductionPanel (playlist, controls) {
  // ---- markup ----

  const panel = el('aside', 'prod-panel')
  panel.setAttribute('aria-label', 'Production')
  panel.tabIndex = -1
  panel.hidden = true

  const header = panel.appendChild(el('header', 'prod-header'))
  const titleWrap = header.appendChild(el('div', 'prod-heading'))
  titleWrap.appendChild(el('h2', 'prod-title', 'Production'))
  const summaryEl = titleWrap.appendChild(el('span', 'prod-summary'))
  const closeBtn = header.appendChild(button('prod-icon prod-close', '×', 'Fermer le panneau (P)'))

  const addRow = panel.appendChild(el('div', 'prod-add'))
  const addBtn = addRow.appendChild(button('prod-btn prod-add-btn', '+ Ajouter des morceaux'))
  addRow.appendChild(el('span', 'prod-hint', 'ou glisse-les n\'importe où'))
  const fileInput = addRow.appendChild(document.createElement('input'))
  fileInput.type = 'file'
  fileInput.multiple = true
  fileInput.accept = ACCEPT
  fileInput.hidden = true
  fileInput.tabIndex = -1

  const list = panel.appendChild(el('ol', 'prod-list'))
  list.setAttribute('aria-label', 'Playlist')
  const emptyEl = panel.appendChild(el('p', 'prod-empty', 'Glisse des fichiers audio ici : ils s\'enchaînent en fondu, dans l\'ordre.'))

  const settingsEl = panel.appendChild(el('div', 'prod-settings'))
  const fadeLabel = settingsEl.appendChild(el('label', 'prod-setting'))
  fadeLabel.appendChild(el('span', 'prod-setting-name', 'Fondu'))
  const fadeInput = fadeLabel.appendChild(document.createElement('input'))
  fadeInput.type = 'range'
  fadeInput.min = '0'
  fadeInput.max = '20'
  fadeInput.step = '0.5'
  const fadeValue = fadeLabel.appendChild(el('span', 'prod-setting-value'))

  const curveLabel = settingsEl.appendChild(el('label', 'prod-setting'))
  curveLabel.appendChild(el('span', 'prod-setting-name', 'Courbe'))
  const curveSelect = curveLabel.appendChild(document.createElement('select'))
  ;[['equal', 'Puissance égale'], ['linear', 'Linéaire']].forEach(([v, t]) => {
    const o = curveSelect.appendChild(document.createElement('option'))
    o.value = v
    o.textContent = t
  })

  const loopLabel = settingsEl.appendChild(el('label', 'prod-setting prod-check'))
  const loopInput = loopLabel.appendChild(document.createElement('input'))
  loopInput.type = 'checkbox'
  loopLabel.appendChild(el('span', 'prod-setting-name', 'Boucler la playlist'))

  const actions = panel.appendChild(el('div', 'prod-actions'))
  const shuffleBtn = actions.appendChild(button('prod-btn', 'Mélanger'))
  const clearBtn = actions.appendChild(button('prod-btn', 'Vider'))
  const leaveBtn = actions.appendChild(button('prod-btn prod-leave', 'Quitter la production'))

  // export: the button and its hint, replaced by the progress while it runs
  const exportEl = panel.insertBefore(el('div', 'prod-export'), actions)
  const exportIdle = exportEl.appendChild(el('div', 'prod-export-idle'))
  const exportBtn = exportIdle.appendChild(button('prod-btn prod-export-btn', 'Exporter'))
  exportIdle.appendChild(el('span', 'prod-hint', 'un seul fichier WAV, fondus compris'))
  const exportRun = exportEl.appendChild(el('div', 'prod-export-run'))
  exportRun.hidden = true
  const exportHead = exportRun.appendChild(el('div', 'prod-export-head'))
  const exportLabel = exportHead.appendChild(el('span', 'prod-export-label'))
  const exportCancel = exportHead.appendChild(button('prod-btn prod-export-cancel', 'Annuler'))
  const exportBar = exportRun.appendChild(el('div', 'prod-export-bar'))
  exportBar.setAttribute('role', 'progressbar')
  exportBar.setAttribute('aria-label', 'Export')
  exportBar.setAttribute('aria-valuemin', '0')
  exportBar.setAttribute('aria-valuemax', '100')
  const exportFill = exportBar.appendChild(el('span', 'prod-export-fill'))
  const exportTrack = exportRun.appendChild(el('span', 'prod-export-track'))
  const exportInfo = exportRun.appendChild(el('span', 'prod-export-track prod-export-info'))

  document.body.appendChild(panel)

  const overlay = document.body.appendChild(el('div', 'prod-drop'))
  overlay.setAttribute('aria-hidden', 'true')
  overlay.appendChild(el('span', 'prod-drop-label', 'Dépose tes morceaux'))

  const toggleBtn = document.querySelector('.prod-toggle')

  controls.addHoverZone(panel)

  // ---- open / close ----

  let open = false
  let exporting = null // AbortController of the export running

  function setOpen (value, focus) {
    if (open === value) return
    open = value
    panel.hidden = !value
    controls.pin('prod-panel', value)
    if (value) {
      render()
      if (focus === 'panel') panel.focus({ preventScroll: true })
      else if (focus) (playlist.getTracks().length ? closeBtn : addBtn).focus()
    } else if (panel.contains(document.activeElement)) {
      // a keyboard user inside the panel goes back to where it opened from
      // (not to the top of the document); the panel itself focused by P
      // just lets go, so Space stays play / pause
      const a = document.activeElement
      if (a !== panel && toggleBtn && !toggleBtn.hidden) toggleBtn.focus({ preventScroll: true })
      else a.blur()
    }
    renderToggle()
  }

  // P / PROD: enter the mode when needed and open, else close
  function toggle (focus) {
    if (!playlist.isActive()) {
      playlist.enter()
      setOpen(true, focus)
    } else {
      setOpen(!open, focus)
    }
  }

  function renderToggle () {
    if (!toggleBtn) return
    const on = playlist.isActive()
    toggleBtn.setAttribute('aria-pressed', String(on))
    toggleBtn.setAttribute('aria-expanded', String(open))
  }

  if (toggleBtn) {
    toggleBtn.hidden = false
    toggleBtn.addEventListener('click', (e) => {
      toggle(e.detail === 0)
      // as for the mixes: no focus left on it after a mouse click (Space)
      if (e.detail > 0) toggleBtn.blur()
    })
  }
  closeBtn.addEventListener('click', () => setOpen(false))
  leaveBtn.addEventListener('click', () => {
    setOpen(false)
    playlist.leave()
  })

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) {
      // the LIVE menu handles its own Escape
      if (e.target && e.target.closest && e.target.closest('.live')) return
      setOpen(false)
      return
    }
    if (e.code !== 'KeyP' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
    if (typesP(e.target) || (e.target && e.target.closest && e.target.closest('.lil-gui'))) return
    if (!controls.isShown()) return
    e.preventDefault()
    toggle('panel')
  })

  // P is left to fields that take letters: text entry and selects (type
  // ahead). A slider or a checkbox does not use it.
  function typesP (t) {
    if (!t || !t.tagName) return false
    if (t.tagName === 'INPUT') return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'color'].includes(t.type)
    return isTextField(t)
  }

  // ---- adding files ----

  function addFiles (files) {
    const list = Array.from(files || [])
    if (!list.length) return
    if (!list.some(isAudioFile)) {
      // nothing usable: do not switch the source away from what plays
      controls.showMessage(list.length > 1 ? `${list.length} fichiers ignorés (pas de l'audio)` : '1 fichier ignoré (pas de l\'audio)', 3000)
      return
    }
    const wasActive = playlist.isActive()
    if (!wasActive) playlist.enter()
    // inside the drop / change gesture: unlock the audio context now
    const result = playlist.add(list)
    if (!wasActive) setOpen(true)
    const parts = []
    if (result.added) parts.push(result.added > 1 ? `${result.added} morceaux ajoutés` : '1 morceau ajouté')
    if (result.ignored) parts.push(result.ignored > 1 ? `${result.ignored} fichiers ignorés (pas de l'audio)` : '1 fichier ignoré (pas de l\'audio)')
    if (parts.length) controls.showMessage(parts.join(' · '), 3000)
  }

  addBtn.addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files)
    fileInput.value = ''
  })

  // ---- drag and drop of files onto the page ----

  const isFileDrag = (e) => {
    const types = e.dataTransfer && e.dataTransfer.types
    return !!types && Array.prototype.indexOf.call(types, 'Files') >= 0
  }
  let dragDepth = 0
  function setOverlay (on) {
    overlay.classList.toggle('is-shown', on)
  }
  window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    dragDepth++
    if (controls.isShown()) setOverlay(true)
  })
  window.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return
    // always: a file dropped on the page must never navigate away to it
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = controls.isShown() ? 'copy' : 'none'
  })
  window.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (!dragDepth) setOverlay(false)
  })
  window.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    dragDepth = 0
    setOverlay(false)
    if (!controls.isShown()) return // during the intro
    addFiles(e.dataTransfer.files)
  })

  // ---- list rendering (rows are keyed by track id and moved, not rebuilt,
  // so a drag in progress survives a re-render) ----

  const rows = new Map() // id -> { li, index, name, dur, up, down, progress }

  function makeRow (track) {
    const li = el('li', 'prod-track')
    li.dataset.id = String(track.id)
    const handle = li.appendChild(el('span', 'prod-handle', '⠿'))
    handle.setAttribute('aria-hidden', 'true')
    const index = li.appendChild(el('span', 'prod-index'))
    const name = li.appendChild(button('prod-name', track.name))
    const dur = li.appendChild(el('span', 'prod-dur'))
    const up = li.appendChild(button('prod-icon prod-up', '↑', `Monter ${track.name}`))
    const down = li.appendChild(button('prod-icon prod-down', '↓', `Descendre ${track.name}`))
    const del = li.appendChild(button('prod-icon prod-del', '×', `Retirer ${track.name}`))
    const progress = li.appendChild(el('span', 'prod-progress'))
    const indexOf = () => playlist.getTracks().findIndex((t) => t.id === track.id)
    name.addEventListener('click', () => playlist.jump(indexOf()))
    // keyboard (detail 0): the focus follows the row; an arrow that became
    // disabled (top / bottom) hands it to the other one. Mouse: the panel's
    // click handler drops it (Space stays play / pause).
    up.addEventListener('click', (e) => {
      const i = indexOf()
      if (i > 0) playlist.move(i, i - 1)
      if (e.detail === 0) (up.disabled ? down : up).focus()
    })
    down.addEventListener('click', (e) => {
      const i = indexOf()
      playlist.move(i, i + 1)
      if (e.detail === 0) (down.disabled ? up : down).focus()
    })
    del.addEventListener('click', (e) => {
      const i = indexOf()
      playlist.remove(track.id)
      if (e.detail !== 0) return
      // keyboard: keep the focus in the list
      const next = list.children[Math.min(i, list.children.length - 1)]
      const target = next && next.querySelector('.prod-del')
      if (target) target.focus()
      else addBtn.focus()
    })
    handle.addEventListener('pointerdown', (e) => startDrag(e, track.id))
    return { li, index, name, dur, up, down, progress }
  }

  let lastCurrentId = null

  function render () {
    renderToggle()
    if (!open) return
    const tracks = playlist.getTracks()
    const cur = playlist.getCurrentTrack()
    const ids = new Set(tracks.map((t) => t.id))
    rows.forEach((row, id) => {
      if (!ids.has(id)) {
        row.li.remove()
        rows.delete(id)
      }
    })
    tracks.forEach((track, i) => {
      let row = rows.get(track.id)
      if (!row) {
        row = makeRow(track)
        rows.set(track.id, row)
      }
      if (list.children[i] !== row.li) list.insertBefore(row.li, list.children[i] || null)
      row.index.textContent = String(i + 1).padStart(2, '0')
      const error = track.status === 'error'
      row.dur.textContent = error ? 'illisible' : track.duration ? formatSeconds(track.duration) : '…'
      row.li.classList.toggle('is-error', error)
      row.name.disabled = error
      const isCur = !!cur && cur.id === track.id
      row.li.classList.toggle('is-current', isCur)
      if (isCur) row.name.setAttribute('aria-current', 'true')
      else row.name.removeAttribute('aria-current')
      row.up.disabled = i === 0
      row.down.disabled = i === tracks.length - 1
      if (!isCur) row.progress.style.transform = 'scaleX(0)'
    })
    lastCurrentId = cur ? cur.id : null
    emptyEl.hidden = tracks.length > 0
    list.hidden = tracks.length === 0
    shuffleBtn.disabled = tracks.length < 2
    clearBtn.disabled = tracks.length === 0
    exportBtn.disabled = !!exporting || !tracks.some((t) => t.status !== 'error')
    const n = tracks.length
    summaryEl.textContent = n
      ? `${n} morceau${n > 1 ? 'x' : ''} · ${formatSeconds(playlist.totalDuration())}`
      : ''
    // settings
    const s = playlist.settings
    if (document.activeElement !== fadeInput) fadeInput.value = String(s.crossfade)
    fadeValue.textContent = `${s.crossfade} s`
    curveSelect.value = s.curve
    loopInput.checked = s.loop
  }

  fadeInput.addEventListener('input', () => playlist.setSetting('crossfade', fadeInput.value))
  curveSelect.addEventListener('change', () => playlist.setSetting('curve', curveSelect.value))
  loopInput.addEventListener('change', () => playlist.setSetting('loop', loopInput.checked))
  shuffleBtn.addEventListener('click', () => playlist.shuffle())
  clearBtn.addEventListener('click', (e) => {
    playlist.clear()
    if (e.detail === 0) addBtn.focus() // the button is disabled now
  })

  // ---- export ----

  function setExportProgress ({ fraction, name, phase }) {
    const pct = Math.floor(fraction * 100)
    exportLabel.textContent = `Export… ${pct} %`
    exportFill.style.transform = `scaleX(${fraction})`
    exportBar.setAttribute('aria-valuenow', String(pct))
    exportTrack.textContent = name ? `${phase === 'decode' ? 'Décodage' : 'Mixage'} : ${name}` : ''
  }

  function plural (n, one, many) {
    return n > 1 ? many : one
  }

  // "Alpha, Bravo, Charlie, … (+2)": stays readable on a phone
  function shortList (names, max = 3) {
    const head = names.slice(0, max).join(', ')
    return names.length > max ? `${head}, … (+${names.length - max})` : head
  }

  // a reload / close would throw the running export away
  function onBeforeUnload (e) {
    e.preventDefault()
    e.returnValue = ''
  }

  // keyboard (detail 0): the focus goes to "Annuler", which replaces the
  // button; a pointer click leaves no focus (Space stays play / pause)
  async function startExport (e) {
    if (exporting) return
    const all = playlist.getTracks()
    const snapshot = all.filter((t) => t.status !== 'error')
    // already marked "illisible": left out, but reported like the others
    const preSkipped = all.filter((t) => t.status === 'error').map((t) => t.name)
    if (!snapshot.length) return
    const settings = { crossfade: playlist.settings.crossfade, curve: playlist.settings.curve }
    const controller = new AbortController()
    exporting = controller
    window.addEventListener('beforeunload', onBeforeUnload)
    const focusCancel = !!e && e.detail === 0
    exportIdle.hidden = true
    exportRun.hidden = false
    const n = snapshot.length
    const curveName = settings.curve === 'linear' ? 'linéaire' : 'puissance égale'
    // the export does not follow later edits of the list or the settings
    exportInfo.textContent = `Figé au lancement : ${n} ${plural(n, 'morceau', 'morceaux')}, fondu ${settings.crossfade} s, ${curveName}`
    setExportProgress({ fraction: 0, name: '', phase: 'decode' })
    render()
    if (focusCancel) exportCancel.focus()
    try {
      const result = await exportPlaylist(
        snapshot.map((t) => ({ name: t.name, file: t.file, duration: t.duration })),
        settings,
        { onProgress: setExportProgress, signal: controller.signal }
      )
      downloadBlob(result.blob, result.filename)
      let text = `Export terminé : ${result.filename} (${formatSeconds(result.seconds)}, fondu ${settings.crossfade} s)`
      // count the tracks, list each name once (the same file can be in twice)
      const skipped = preSkipped.concat(result.skipped)
      const k = skipped.length
      if (k) text += ` · ${k} ${plural(k, 'morceau illisible ignoré', 'morceaux illisibles ignorés')} : ${shortList([...new Set(skipped)])}`
      controls.showMessage(text, 7000)
    } catch (e) {
      if (e && e.name === 'AbortError') controls.showMessage('Export annulé', 3000)
      else controls.showMessage(exportErrorText(e), 7000)
    } finally {
      exporting = null
      window.removeEventListener('beforeunload', onBeforeUnload)
      const hadFocus = exportRun.contains(document.activeElement)
      exportRun.hidden = true
      exportIdle.hidden = false
      render()
      if (hadFocus) (exportBtn.disabled ? addBtn : exportBtn).focus()
    }
  }

  function exportErrorText (e) {
    const code = e && e.code
    if (code === 'empty') return 'Export impossible : aucun morceau lisible'
    if (code === 'tooLong') return 'Export impossible : plus de 6 h 45 de musique, au-delà de la limite d\'un fichier WAV (4 Go)'
    if (code === 'memory') return 'Export impossible : mémoire insuffisante' + (e.detail ? ` (${e.detail})` : '')
    return 'Export impossible : ' + ((e && (e.detail || e.message)) || 'erreur inconnue')
  }

  exportBtn.addEventListener('click', startExport)
  exportCancel.addEventListener('click', () => { if (exporting) exporting.abort() })

  // pointer clicks leave no focus on a button (bubbling: runs after the
  // buttons' own handlers), so the next Space is play / pause, not that
  // button again
  panel.addEventListener('click', (e) => {
    const b = e.target && e.target.closest && e.target.closest('button')
    if (b && e.detail > 0 && document.activeElement === b) b.blur()
  })
  // same for the settings once a pointer has changed them (a keyboard user
  // keeps the focus: arrows / Space keep working on them)
  let pointerInput = false
  panel.addEventListener('pointerdown', () => { pointerInput = true }, true)
  panel.addEventListener('keydown', () => { pointerInput = false }, true)
  ;[fadeInput, curveSelect, loopInput].forEach((input) => {
    input.addEventListener('change', () => { if (pointerInput) input.blur() })
  })

  playlist.subscribe((type, detail) => {
    if (type === 'error') controls.showMessage(detail)
    // the panel belongs to the mode: leaving it (a mix, LIVE) closes it
    else if (type === 'mode' && !detail) setOpen(false)
    else render()
  })

  // ---- reorder by dragging the handle ----

  let drag = null // { id, pointerId }

  function startDrag (e, id) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    drag = { id, pointerId: e.pointerId }
    // captured by the list, which is never moved (rows are)
    try { list.setPointerCapture(e.pointerId) } catch (err) {}
    const row = rows.get(id)
    if (row) row.li.classList.add('is-dragging')
    list.classList.add('is-sorting')
  }

  list.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return
    const tracks = playlist.getTracks()
    const from = tracks.findIndex((t) => t.id === drag.id)
    if (from < 0) return
    // the slot under the pointer: past the middle of a row moves there
    let to = from
    const items = Array.from(list.children)
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect()
      if (e.clientY < r.top + r.height / 2) { to = i > from ? i - 1 : i; break }
      to = i
    }
    if (to !== from) playlist.move(from, to)
  })

  function endDrag (e) {
    if (!drag || e.pointerId !== drag.pointerId) return
    const row = rows.get(drag.id)
    if (row) row.li.classList.remove('is-dragging')
    list.classList.remove('is-sorting')
    drag = null
  }
  list.addEventListener('pointerup', endDrag)
  list.addEventListener('pointercancel', endDrag)
  list.addEventListener('lostpointercapture', endDrag)

  // ---- per frame: the current row's progress ----

  let lastStep = -1
  function tick () {
    if (!open || lastCurrentId === null) return
    const row = rows.get(lastCurrentId)
    if (!row) return
    const d = playlist.duration()
    const f = d ? Math.min(1, playlist.currentTime() / d) : 0
    const step = Math.round(f * 1000)
    if (step === lastStep) return
    lastStep = step
    row.progress.style.transform = `scaleX(${f})`
  }

  renderToggle()

  return {
    el: panel,
    tick,
    toggle,
    isOpen: () => open,
    setOpen
  }
}
