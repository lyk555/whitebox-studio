// The others in a story stand in the room, where the player sees them before they say anything.
// Seen on 《雾都码头谜案》: with nobody in the room, Watson and the coal heaver turned up out of nowhere in the cut to their faces.

// Who stands in a place, by which of its steps, and from when. Worked out from the steps, so it is worked out again whenever
// they change: someone shown in a step's face shot (named in it, or speaking) stands by that step's thing, unless the step says
// they come in then (arrives, so after it).
// The story can be in a place more than once, with somewhere else between (a visit each time). Each visit has who it shows, and
// only them: someone there from the first step of a later visit (from), and gone when the next visit begins (before). Seen on
// 《雾都码头谜案》: Watson stood in the study at the start, when it says he has just gone out, and the study is where he comes back
// to at the end. Seen on 《榆园命案》: Bell, taken in the hall at dawn, still stood in the study the morning after.
// Within a visit someone can walk over to a step's thing (moves): they leave where they were as that step ends (until) and stand
// by its thing from then (after). Seen on 《榆园命案》: Watson and Lestrade, there to lie in wait behind the curtains at night,
// stood in the middle of the study where they had stood by day.
// Each entry has a key, the person's own id for their first one, so a person who never moves is kept as before.
// apart says how far apart two of the place's things are, so someone talking from across the room can be seen to walk over.
export function onStageFrom(cast, scene, anchors = [], apart = () => null) {
  const player = cast.find(person => person.playable) ?? cast[0]
  const byName = name => cast.find(candidate => candidate.name === name)
  const entries = []
  const visits = visitsOf(scene, anchors)
  visits.forEach((visit, index) => {
    const current = new Map()
    // Coming in can be said of a step before the one they are seen in: in the study, Watson's boots by the door, then Watson.
    const arrived = new Map()
    for (const beat of visit) {
      for (const name of beat.faceCast ?? []) {
        const person = byName(name)
        if (!person || person === player || current.has(person.id)) continue
        if ((beat.arrives ?? []).includes(name) && !arrived.has(person.id)) arrived.set(person.id, beat.id)
        // Listed for a shot but neither seen nor heard in it is not yet there.
        const shown = (beat.face ?? '').includes(name) || (beat.lines ?? []).some(line => line.who === name)
        if (!shown) continue
        let after = arrived.get(person.id)
        // A step that points the player at someone has them in the room before it is done. Seen on 《榆园命案》: told to look at
        // the visitor by the sofa, the player found nobody there, and the cut to her face brought her in out of nowhere.
        // They come in as the step before ends; with none before it in this visit, they are simply there.
        if (after === beat.id && callsFor(name).some(call => toldBefore(beat).includes(call))) after = visit[visit.indexOf(beat) - 1]?.id
        const from = !after && index > 0 ? visit[0].id : null
        const entry = { cast: person.id, by: beat.id, ...(after ? { after } : {}), ...(from ? { from } : {}), ...tallness(person) }
        current.set(person.id, entry)
        entries.push(entry)
      }
    }
    const objectOf = id => (scene.beats ?? []).find(other => other.id === id)?.object
    visit.forEach((beat, at) => {
      // Whoever speaks in a step from across the room walks over to talk. Seen on 《榆园命案》: Ellen stood by the sofa in the game,
      // at Holmes's shoulder by the experiment table in the shot of her face, and back by the sofa after it. Near enough to talk
      // from where they are, they stay there: following him from thing to thing is not what anyone does.
      const speakers = [...new Set((beat.lines ?? []).map(line => line.who))].filter(name => {
        const entry = byName(name) && current.get(byName(name).id)
        return entry && entry.by !== beat.id && at > visit.findIndex(other => other.id === entry.by) && apart(objectOf(entry.by), beat.object) > TALKS_ACROSS
      })
      for (const name of [...new Set([...(beat.moves ?? []), ...speakers])]) {
        const person = byName(name)
        const entry = person && current.get(person.id)
        if (!entry || entry.by === beat.id) continue
        // Said before they are first seen, of someone here from the start: that is where they stand from the start of the visit.
        if (!entry.after && at <= visit.findIndex(other => other.id === entry.by)) {
          entry.by = beat.id
          continue
        }
        // Not in yet by then.
        if (entry.after && visit.findIndex(other => other.id === entry.after) >= at) continue
        entry.until = beat.id
        const moved = { cast: person.id, by: beat.id, after: beat.id, ...tallness(person) }
        current.set(person.id, moved)
        entries.push(moved)
      }
    })
    const next = visits[index + 1]?.[0]
    if (next) for (const entry of current.values()) entry.before = next.id
  })
  const seen = new Map()
  return entries.map(entry => {
    const count = seen.get(entry.cast) ?? 0
    seen.set(entry.cast, count + 1)
    return count ? { ...entry, key: `${entry.cast}#${count}` } : entry
  })
}

// Metres between the thing someone stands by and the one the player is at, past which they walk over to say their lines.
const TALKS_ACROSS = 4

// How tall someone stands, in metres. Everyone used to stand as tall as a grown man, so the fourteen-year-old boot boy in
// 《榆园命案》 stood as tall as Holmes. A grown man stays at the height the player's walk was always drawn at, so nothing made for
// one changes. Said only when it is not that, so an entry for a grown man is written as it was.
export const MAN_HEIGHT = 1.75
const WOMAN_HEIGHT = 1.63
// Children and the young, by age, as [boy, girl]. Past these, grown.
const GROWING = [[6, [1.15, 1.13]], [10, [1.35, 1.34]], [13, [1.5, 1.5]], [15, [1.62, 1.56]], [17, [1.7, 1.6]]]
const DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
// The first age a text gives, in either kind of numeral: 十四五岁 is 14, 二十三四岁 is 23, 六十六岁 is 66, 五十多岁 is 50.
export function ageIn(text = '') {
  const arabic = String(text).match(/(\d{1,3})\s*(?:岁|多岁|来岁)/)
  if (arabic) return Number(arabic[1])
  const written = String(text).match(/([零〇一二两三四五六七八九十]+)(?:[一二三四五六七八九])?(?:多|来)?岁/)
  if (!written) return /少年|少女|男孩|女孩|孩子|孩童|儿童|小孩|幼/.test(text) ? 14 : null
  const word = written[1]
  if (!word.includes('十')) return DIGITS[word[0]] ?? null
  const [tens, ones] = word.split('十')
  return (tens ? DIGITS[tens] ?? 1 : 1) * 10 + (ones ? DIGITS[ones[0]] ?? 0 : 0)
}
// A skirt says so; an apron or a kilt does not.
const FEMALE = /女|她|小姐|太太|夫人|姑娘|妇|姐|妹|母亲|婆|娘|(?<!苏格兰)(?<!围)裙/
export const isFemale = person => FEMALE.test([person.name, person.role, person.look, person.costume].filter(Boolean).join(' '))
export function heightOf(person) {
  const said = Number(person.height)
  if (Number.isFinite(said) && said >= 0.8 && said <= 2.2) return said
  const age = ageIn(person.age) ?? ageIn(person.look)
  const girl = isFemale(person)
  const young = age === null ? null : GROWING.find(([upTo]) => age <= upTo)
  if (young) return young[1][girl ? 1 : 0]
  return girl ? WOMAN_HEIGHT : MAN_HEIGHT
}
const tallness = person => (heightOf(person) === MAN_HEIGHT ? {} : { height: heightOf(person) })

// The times the story is in this place: runs of its steps with no step anywhere else between them, in the order of the story.
// Between two, the player has been elsewhere, so who is here can change without anyone seeing it happen.
function visitsOf(scene, anchors) {
  const order = anchors.flatMap(anchor => anchor.steps ?? [])
  const at = beat => order.findIndex(step => step.scene === scene.id && step.beat === beat.id)
  const visits = []
  for (const beat of scene.beats ?? []) {
    const previous = visits.at(-1)?.at(-1)
    if (previous && (at(beat) < 0 || at(previous) < 0 || at(beat) === at(previous) + 1)) visits.at(-1).push(beat)
    else visits.push([beat])
  }
  return visits
}

// What a step tells the player before it is done.
const toldBefore = beat => [beat.objective, beat.prompt, beat.tooEarly].filter(Boolean).join(' ')
// How a step may call someone: in full, without a title, or by either half of a foreign name (雷斯垂德警长, 雷斯垂德; 托马斯·贝尔, 贝尔).
const TITLES = /(警长|警官|探长|先生|小姐|太太|夫人|医生|博士|上校|中尉|少爷|老爷)$/
export const callsFor = name => [...new Set([name, name.replace(TITLES, ''), ...name.replace(TITLES, '').split('·')])].filter(call => call.length >= 2)

// Whether someone is in the room, given which steps here have been reached (due or done) and which are done.
// Kept the same as runtime/story.js.
export const isThere = (entry, reached, done) => (!entry.from || reached(entry.from)) && (!entry.after || done(entry.after))
  && (!entry.until || !done(entry.until)) && (!entry.before || !reached(entry.before))

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

// Whether two entries are ever in the room at once: at the start or end of any step, the opening, or after the last step.
// Two that never are can stand in the same place.
export function together(scene) {
  const at = inPicture(scene)
  const moments = ['opening', ...(scene.beats ?? []).map(beat => beat.id), 'after'].flatMap(id => Object.values(at(id)))
  return (one, other) => moments.some(present => present.includes(one) && present.includes(other))
}

// Names for an arriving list written by a model: only people of the story, only ones the shot shows.
export const arrivalsIn = (value, faceCast) => (Array.isArray(value) ? value : []).map(name => String(name ?? '').trim()).filter(name => faceCast.includes(name))
// Names for a list of who walks over to a step's thing: anyone of the story but the player. Only someone already in the room moves.
export const movesIn = (value, names, player) => [...new Set((Array.isArray(value) ? value : []).map(name => String(name ?? '').trim()))].filter(name => name !== player && names.includes(name))
