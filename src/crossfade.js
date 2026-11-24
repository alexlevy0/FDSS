// The crossfade rule, shared by the playlist (playlist.js, live playback) and
// the export (playlist-export.js, one WAV file), so the two can never
// disagree on how long a transition is or how it sounds.
//
// Length. The crossfade between two tracks is the setting, clamped to 45% of
// the shorter of the two (so a track is never more than 90% inside fades:
// two fades never overlap, at most two tracks sound at once). A length of
// MIN_FADE or less is no fade at all: the next track starts when the
// previous one ends (a cut). An unknown duration (0) does not clamp.
//
// Curve. Gain of a deck going from `from` to `to` at progress p (0..1):
// 'equal' (equal power, cos / sin: constant loudness for uncorrelated
// material) or 'linear'.

export const MAX_FADE_SHARE = 0.45 // of the shorter track
export const MIN_FADE = 0.05 // s: at or below, a cut

export function crossfadeLength (setting, durationA, durationB) {
  let x = Number(setting) || 0
  if (durationA > 0) x = Math.min(x, durationA * MAX_FADE_SHARE)
  if (durationB > 0) x = Math.min(x, durationB * MAX_FADE_SHARE)
  return x > MIN_FADE ? x : 0
}

export function fadeGain (curve, from, to, p) {
  if (curve === 'linear') return from + (to - from) * p
  const a = p * Math.PI / 2
  return Math.min(1, from * Math.cos(a) + to * Math.sin(a))
}
