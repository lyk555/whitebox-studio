// The others in a story stand in the room, where the player sees them before they say anything.
// Seen on 《雾都码头谜案》: with nobody in the room, Watson and the coal heaver turned up out of nowhere in the cut to their faces.

// Who stands in a place, by which of its steps, and from when. Worked out from the steps, so it is worked out again whenever
// they change: someone shown in a step's face shot (named in it, or speaking) stands by that step's thing from the start, unless
// the step says they come in then (arrives). From then on they stay.
export function onStageFrom(cast, scene) {
  const player = cast.find(person => person.playable) ?? cast[0]
  const found = new Map()
  for (const beat of scene.beats ?? []) {
    for (const name of beat.faceCast ?? []) {
      const person = cast.find(candidate => candidate.name === name)
      if (!person || person === player || found.has(person.id)) continue
      // Listed for a shot but neither seen nor heard in it is not yet there.
      const shown = (beat.face ?? '').includes(name) || (beat.lines ?? []).some(line => line.who === name)
      if (!shown) continue
      found.set(person.id, { cast: person.id, by: beat.id, ...((beat.arrives ?? []).includes(name) ? { after: beat.id } : {}) })
    }
  }
  return [...found.values()]
}

// Who is in the picture where a clip starts and where it ends. A step comes after the ones listed before it in its place,
// which is also the order the game takes its frames in.
export function inPicture(scene) {
  const order = (scene.beats ?? []).map(beat => beat.id)
  const entries = scene.onStage ?? []
  const there = doneBefore => entries.filter(entry => !entry.after || doneBefore.has(entry.after))
  return clipId => {
    if (clipId === 'opening') return { first: there(new Set()), last: there(new Set()) }
    // The door and the ending come after every step.
    if (!order.includes(clipId)) return { first: there(new Set(order)), last: there(new Set(order)) }
    const before = new Set(order.slice(0, order.indexOf(clipId)))
    return { first: there(before), last: there(new Set([...before, clipId])) }
  }
}

// Names for an arriving list written by a model: only people of the story, only ones the shot shows.
export const arrivalsIn = (value, faceCast) => (Array.isArray(value) ? value : []).map(name => String(name ?? '').trim()).filter(name => faceCast.includes(name))
