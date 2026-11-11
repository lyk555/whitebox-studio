// The others in a story stand in the room, where the player sees them before they say anything.
// Seen on 《雾都码头谜案》: with nobody in the room, Watson and the coal heaver turned up out of nowhere in the cut to their faces.

// Who stands in a place, by which of its steps, and from when. Worked out from the steps, so it is worked out again whenever
// they change: someone shown in a step's face shot (named in it, or speaking) stands by that step's thing, unless the step says
// they come in then (arrives, so after it). From then on they stay.
// A place on the map can be come back to in a later part of the story. Then they are there from the first step here of the part
// they belong to (from), not before. Seen on 《雾都码头谜案》: Watson stood in the study at the start, when it says he has just
// gone out, and the study is where he comes back to at the end.
export function onStageFrom(cast, scene, anchors = []) {
  const player = cast.find(person => person.playable) ?? cast[0]
  const here = beat => anchor => (anchor.steps ?? []).some(step => step.scene === scene.id && step.beat === beat.id)
  const beats = scene.beats ?? []
  const found = new Map()
  // Coming in can be said of a step before the one they are seen in: in the study, Watson's boots by the door, then Watson.
  const arrived = new Map()
  for (const beat of beats) {
    for (const name of beat.faceCast ?? []) {
      const person = cast.find(candidate => candidate.name === name)
      if (!person || person === player || found.has(person.id)) continue
      if ((beat.arrives ?? []).includes(name) && !arrived.has(person.id)) arrived.set(person.id, beat.id)
      // Listed for a shot but neither seen nor heard in it is not yet there.
      const shown = (beat.face ?? '').includes(name) || (beat.lines ?? []).some(line => line.who === name)
      if (!shown) continue
      const after = arrived.get(person.id)
      const part = anchors.find(here(beat))
      const firstOfPart = part && beats.find(other => here(other)(part))
      const from = !after && firstOfPart && firstOfPart !== beats[0] ? firstOfPart.id : null
      found.set(person.id, { cast: person.id, by: beat.id, ...(after ? { after } : {}), ...(from ? { from } : {}) })
    }
  }
  return [...found.values()]
}

// Whether someone is in the room, given which steps here have been reached (due or done) and which are done.
export const isThere = (entry, reached, done) => (!entry.from || reached(entry.from)) && (!entry.after || done(entry.after))

// Who is in the picture where a clip starts and where it ends. A step comes after the ones listed before it in its place,
// which is also the order the game takes its frames in.
export function inPicture(scene) {
  const order = (scene.beats ?? []).map(beat => beat.id)
  const entries = scene.onStage ?? []
  // A step's shot is where that step has been reached; everything before it is done.
  const there = (at, done) => entries.filter(entry => isThere(entry, id => order.indexOf(id) <= at, id => done.has(id)))
  return clipId => {
    if (clipId === 'opening') return { first: there(-1, new Set()), last: there(-1, new Set()) }
    // The door and the ending come after every step.
    if (!order.includes(clipId)) return { first: there(order.length, new Set(order)), last: there(order.length, new Set(order)) }
    const at = order.indexOf(clipId)
    const before = new Set(order.slice(0, at))
    return { first: there(at, before), last: there(at, new Set([...before, clipId])) }
  }
}

// Names for an arriving list written by a model: only people of the story, only ones the shot shows.
export const arrivalsIn = (value, faceCast) => (Array.isArray(value) ? value : []).map(name => String(name ?? '').trim()).filter(name => faceCast.includes(name))
