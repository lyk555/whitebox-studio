// A story made of chapters and anchors, happening in places joined up on a map. The story's order lives in the anchors, and
// each place keeps the steps that happen in it, so a place is built, painted and filmed the way it always was.
import { walkThrough } from '../runtime/journey.js'
import { MOST_WAYS } from '../runtime/shell.js'

export const isWorld = project => project?.flow === 'chapters'
export const chaptersOf = project => project.chapters ?? []
export const anchorsOf = project => chaptersOf(project).flatMap(chapter => chapter.anchors)
export const stepsOf = project => anchorsOf(project).flatMap(anchor => anchor.steps ?? [])

const ids = value => [value].flat().filter(Boolean)
const beatAt = (project, { scene, beat }) => project.scenes.find(candidate => candidate.id === scene)?.beats.find(candidate => candidate.id === beat)

// The story as far as playing it goes. What the game, the play page and the film order all read.
export function planOf(project) {
  return {
    start: project.start ?? project.scenes[0]?.id ?? null,
    chapters: chaptersOf(project).map(chapter => ({
      id: chapter.id, title: chapter.title,
      anchors: chapter.anchors.map(anchor => ({
        id: anchor.id, title: anchor.title, needs: anchor.needs ?? [],
        steps: (anchor.steps ?? []).flatMap(step => {
          const beat = beatAt(project, step)
          return beat ? [{ scene: step.scene, beat: step.beat, objective: beat.objective, gives: ids(beat.gives), takes: ids(beat.takes) }] : []
        }),
      })),
    })),
    places: Object.fromEntries(project.scenes.map(scene => [scene.id, { title: scene.title, exits: (scene.exits ?? []).map(exit => ({ id: exit.id, to: exit.to, name: exit.name, ...(exit.opensAfter ? { opensAfter: exit.opensAfter } : {}) })) }])),
  }
}

// Everything worked out from the story rather than written down, so no order of edits can leave it saying something untrue.
export function settleWorld(project) {
  for (const chapter of chaptersOf(project)) {
    chapter.anchors.forEach((anchor, index) => {
      const earlier = chapter.anchors.slice(0, index).map(other => other.id)
      const kept = (anchor.needs ?? []).filter(id => earlier.includes(id))
      // A chapter ends on its last anchor, however freely the ones before it can be taken.
      anchor.needs = index === chapter.anchors.length - 1 ? earlier : kept
    })
  }
  const order = stepsOf(project)
  const place = new Map(order.map((step, index) => [`${step.scene}/${step.beat}`, index]))
  const endings = new Set(chaptersOf(project).flatMap(chapter => {
    const last = chapter.anchors.at(-1)?.steps?.at(-1)
    return last ? [`${last.scene}/${last.beat}`] : []
  }))
  for (const scene of project.scenes) {
    scene.beats = [...scene.beats].sort((one, other) => (place.get(`${scene.id}/${one.id}`) ?? Infinity) - (place.get(`${scene.id}/${other.id}`) ?? Infinity))
    for (const beat of scene.beats) {
      if (endings.has(`${scene.id}/${beat.id}`)) beat.endsChapter = true
      else delete beat.endsChapter
    }
  }
  // A prop is drawn where it is first handed over and comes along everywhere else, since a player can walk back with it.
  const pool = new Map(project.scenes.flatMap(scene => [...(scene.props ?? []), ...(scene.carried ?? [])].map(({ from, ...prop }) => [prop.id, prop])))
  const owner = new Map()
  for (const step of order) {
    for (const id of ids(beatAt(project, step)?.gives)) if (!owner.has(id)) owner.set(id, step.scene)
  }
  for (const scene of project.scenes) {
    scene.props = [...owner].filter(([id, where]) => where === scene.id && pool.has(id)).map(([id]) => pool.get(id))
    scene.carried = [...owner].filter(([id, where]) => where !== scene.id && pool.has(id)).map(([id, where]) => ({ ...pool.get(id), from: where }))
  }
  return project
}

function ancestorsOf(project, anchor) {
  const seen = new Set()
  const chapters = chaptersOf(project)
  const chapterIndex = chapters.findIndex(chapter => chapter.anchors.includes(anchor))
  for (const chapter of chapters.slice(0, chapterIndex)) for (const other of chapter.anchors) seen.add(other.id)
  const within = chapters[chapterIndex]?.anchors ?? []
  const visit = current => {
    for (const id of current.needs ?? []) {
      if (seen.has(id)) continue
      seen.add(id)
      const found = within.find(other => other.id === id)
      if (found) visit(found)
    }
  }
  visit(anchor)
  return seen
}

// What the protagonist is sure to be holding when this anchor starts, whichever order things were done in.
export function heldBefore(project, anchor) {
  const ancestors = ancestorsOf(project, anchor)
  const held = new Set()
  for (const other of anchorsOf(project)) {
    if (!ancestors.has(other.id)) continue
    for (const step of other.steps ?? []) {
      const beat = beatAt(project, step)
      for (const id of ids(beat?.takes)) held.delete(id)
      for (const id of ids(beat?.gives)) held.add(id)
    }
  }
  return held
}

// What the audience is sure to have seen when this anchor starts, and what they may or may not have.
export function seenBefore(project, anchor) {
  const ancestors = ancestorsOf(project, anchor)
  const list = anchorsOf(project)
  const own = list.indexOf(anchor)
  return { surely: list.filter(other => ancestors.has(other.id)), maybe: list.filter((other, index) => !ancestors.has(other.id) && other !== anchor && chaptersOf(project).find(chapter => chapter.anchors.includes(other)) === chaptersOf(project).find(chapter => chapter.anchors.includes(anchor)) && (index < own || !ancestorsOf(project, other).has(anchor.id))) }
}

// Every reason this story could not be played from beginning to end. The map's own faults are told by name.
export function worldProblems(project) {
  const problems = []
  const titles = new Map(project.scenes.map(scene => [scene.id, scene.title]))
  for (const scene of project.scenes) {
    const exits = scene.exits ?? []
    if (exits.length > MOST_WAYS) problems.push(`“${scene.title}”有 ${exits.length} 个出口，一个地方最多 ${MOST_WAYS} 个，画面里放不下更多。`)
    for (const exit of exits) if (!titles.has(exit.to)) problems.push(`“${scene.title}”的出口“${exit.name}”通向一个不存在的地方。`)
    if (new Set(exits.map(exit => exit.to)).size < exits.length) problems.push(`“${scene.title}”有两个出口通向同一个地方。`)
  }
  for (const anchor of anchorsOf(project)) {
    if (!(anchor.steps ?? []).some(step => beatAt(project, step))) problems.push(`锚点“${anchor.title}”还没有写具体的步骤。`)
  }
  const placed = new Set(stepsOf(project).map(step => `${step.scene}/${step.beat}`))
  for (const scene of project.scenes) {
    for (const beat of scene.beats) if (!placed.has(`${scene.id}/${beat.id}`)) problems.push(`“${scene.title}”的“${beat.objective}”不属于任何锚点，玩家永远走不到这一步。`)
  }
  for (const anchor of anchorsOf(project)) {
    const held = heldBefore(project, anchor)
    for (const step of anchor.steps ?? []) {
      const beat = beatAt(project, step)
      if (!beat) continue
      for (const id of ids(beat.takes)) {
        if (!held.has(id)) problems.push(`“${beat.objective}”要用掉道具 ${id}，但这时主角手里不一定有它。先得到它的锚点要排在前面。`)
        held.delete(id)
      }
      for (const id of ids(beat.gives)) held.add(id)
    }
  }
  if (!problems.length) problems.push(...walkThrough(planOf(project)).problems)
  return problems
}

// The film follows the story as it was written: each step in its order, and a place's opening the first time it is come to.
export const filmOrder = project => walkThrough(planOf(project)).film.map(({ scene, clip }) => `scenes/${scene}/${clip}.mp4`)

// ---------------------------------------------------------------- in words
export const anchorWords = anchor => `【${anchor.title}】之前以为：${anchor.before}；发生：${anchor.happens}；之后以为：${anchor.after}`

export const outlineText = project => chaptersOf(project).map((chapter, index) => `第 ${index + 1} 章：${chapter.title}${chapter.summary ? `。${chapter.summary}` : ''}\n${chapter.anchors.map(anchor => `${anchor.id} ${anchorWords(anchor)}${(anchor.needs ?? []).length ? `（等 ${anchor.needs.join('、')} 之后）` : ''}`).join('\n')}`).join('\n\n')

export const mapText = project => project.scenes.map(scene => {
  const ways = (scene.exits ?? []).map(exit => `${exit.name}通向“${project.scenes.find(other => other.id === exit.to)?.title ?? exit.to}”${exit.opensAfter ? `（${exit.opensAfter} 之后才通）` : ''}`)
  return `“${scene.title}”：${scene.place} ${ways.length ? `出口：${ways.join('；')}。` : '没有出口。'}`
}).join('\n')

// What a step is hashed from: the story as told, and not what has been written inside it since.
export const outlineSignature = project => chaptersOf(project).map(chapter => [chapter.id, chapter.title, chapter.summary, chapter.anchors.map(anchor => [anchor.id, anchor.title, anchor.before, anchor.happens, anchor.after, anchor.needs])])
export const mapSignature = project => project.scenes.map(scene => [scene.id, scene.title, scene.place, (scene.exits ?? []).map(exit => [exit.to, exit.name, exit.opensAfter])])
