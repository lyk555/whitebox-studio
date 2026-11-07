// Where a player has got to in a story they walk around in, worked out from what they have done. No rendering and no
// server in here: the game, the play page and the checks before anything is paid for all read the same answers.
//
// A plan is the story as far as playing it goes:
// { start, chapters: [{ id, title, anchors: [{ id, title, needs: [anchor ids], steps: [{ scene, beat, objective, gives, takes }] }] }],
//   places: { [scene id]: { title, exits: [{ id, to, opensAfter }] } } }
// Chapters come one after another. Inside a chapter, an anchor can happen once the anchors it needs have. Inside an anchor,
// steps come in order. Everything only ever opens, so whichever order a player takes things in, they cannot get stuck in
// a way another order would have avoided, and playing it through once in any order says whether it can be finished.

export const stepKey = (scene, beat) => `${scene}/${beat}`

const anchorsOf = plan => plan.chapters.flatMap(chapter => chapter.anchors)
const stepDone = (step, done) => done.has(stepKey(step.scene, step.beat))
const anchorDone = (anchor, done) => anchor.steps.every(step => stepDone(step, done))

export const newProgress = plan => ({ at: plan.start, done: [], items: [], seen: [], chapter: firstOpenChapter(plan, new Set(), 0) })

function firstOpenChapter(plan, done, from) {
  let index = from
  while (index < plan.chapters.length && plan.chapters[index].anchors.every(anchor => anchorDone(anchor, done))) index++
  return index
}

export const storyFinished = (plan, progress) => progress.chapter >= plan.chapters.length

// What can be done now, in the order the story was written. More than one when anchors can come in any order.
export function dueSteps(plan, progress) {
  const chapter = plan.chapters[progress.chapter]
  if (!chapter) return []
  const done = new Set(progress.done)
  const finished = new Set(anchorsOf(plan).filter(anchor => anchorDone(anchor, done)).map(anchor => anchor.id))
  return chapter.anchors.flatMap(anchor => {
    if (finished.has(anchor.id) || !anchor.needs.every(id => finished.has(id))) return []
    const step = anchor.steps.find(candidate => !stepDone(candidate, done))
    return step ? [{ ...step, anchor: anchor.id }] : []
  })
}

export function exitIsOpen(plan, progress, exit) {
  if (!exit.opensAfter) return true
  const anchor = anchorsOf(plan).find(candidate => candidate.id === exit.opensAfter)
  // An anchor that is no longer in the story cannot keep a door shut for ever.
  return !anchor || anchorDone(anchor, new Set(progress.done))
}

// A chapter that finishes takes the player to where the next one starts.
export function completeStep(plan, progress, scene, beat) {
  const step = dueSteps(plan, progress).find(candidate => candidate.scene === scene && candidate.beat === beat)
  if (!step) throw new Error(`还没轮到 ${stepKey(scene, beat)}`)
  const items = [...progress.items]
  for (const id of step.takes ?? []) if (items.includes(id)) items.splice(items.indexOf(id), 1)
  for (const id of step.gives ?? []) if (!items.includes(id)) items.push(id)
  const next = { ...progress, done: [...progress.done, stepKey(scene, beat)], items }
  const chapter = firstOpenChapter(plan, new Set(next.done), progress.chapter)
  if (chapter === progress.chapter) return { progress: next, chapterEnded: false, storyEnded: false }
  next.chapter = chapter
  const storyEnded = chapter >= plan.chapters.length
  if (!storyEnded) next.at = dueSteps(plan, next)[0]?.scene ?? next.at
  return { progress: next, chapterEnded: true, storyEnded }
}

export const arrive = (progress, scene) => ({ ...progress, at: scene, seen: progress.seen.includes(scene) ? progress.seen : [...progress.seen, scene] })

// The way there through what is open now, not counting where they stand. Null when there is none.
export function pathTo(plan, progress, from, to) {
  if (from === to) return []
  const cameFrom = new Map([[from, null]])
  const queue = [from]
  while (queue.length) {
    const here = queue.shift()
    for (const exit of plan.places[here]?.exits ?? []) {
      if (cameFrom.has(exit.to) || !exitIsOpen(plan, progress, exit)) continue
      cameFrom.set(exit.to, here)
      if (exit.to === to) {
        const path = [to]
        for (let at = here; at !== from; at = cameFrom.get(at)) path.unshift(at)
        return path
      }
      queue.push(exit.to)
    }
  }
  return null
}

// Where the story has got to when a place is first needed. For trying a place out by itself, with nothing else played.
export function progressBefore(plan, scene) {
  let progress = newProgress(plan)
  while (!storyFinished(plan, progress)) {
    const due = dueSteps(plan, progress)
    if (!due.length || due.some(step => step.scene === scene)) break
    progress = completeStep(plan, progress, due[0].scene, due[0].beat).progress
  }
  return { ...progress, at: scene }
}

// What the screen tells the player. Something to do here comes first; otherwise where the next thing is.
export function objectiveIn(plan, progress, scene) {
  const due = dueSteps(plan, progress)
  const here = due.find(step => step.scene === scene)
  if (here) return here.objective
  if (!due.length) return ''
  return `${due[0].objective}（在${plan.places[due[0].scene]?.title ?? '别处'}）`
}

// Plays the story through in the order it was written, as the film will show it. Says what stops it being finished.
export function walkThrough(plan) {
  const film = []
  const problems = []
  if (!plan.places[plan.start]) return { film, problems: ['还没有起点。'] }
  let progress = newProgress(plan)
  const enter = scene => {
    if (!progress.seen.includes(scene)) film.push({ scene, clip: 'opening' })
    progress = arrive(progress, scene)
  }
  enter(progress.at)
  while (!storyFinished(plan, progress)) {
    const due = dueSteps(plan, progress)
    if (!due.length) {
      problems.push(`第 ${progress.chapter + 1} 章走不下去了：没有能做的事，但这一章还没完。`)
      break
    }
    const step = due.find(candidate => pathTo(plan, progress, progress.at, candidate.scene))
    if (!step) {
      problems.push(`走不到“${plan.places[due[0].scene]?.title ?? due[0].scene}”：“${due[0].objective}”在那里，但这时从“${plan.places[progress.at]?.title ?? progress.at}”过去的路还没通。`)
      break
    }
    for (const scene of pathTo(plan, progress, progress.at, step.scene)) enter(scene)
    film.push({ scene: step.scene, clip: step.beat })
    const result = completeStep(plan, progress, step.scene, step.beat)
    progress = result.progress
    if (result.chapterEnded && !result.storyEnded) enter(progress.at)
  }
  // With every door open, because whether a place can be reached in the end does not depend on when.
  const everOpen = { ...plan, places: Object.fromEntries(Object.entries(plan.places).map(([id, place]) => [id, { ...place, exits: place.exits.map(({ id: exit, to }) => ({ id: exit, to })) }])) }
  for (const [id, place] of Object.entries(plan.places)) {
    if (!problems.length && !film.some(shot => shot.scene === id) && !pathTo(everOpen, newProgress(plan), plan.start, id)) problems.push(`“${place.title}”和其他地方都不相连，走不到。`)
  }
  return { film, problems }
}
