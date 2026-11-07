// The story, in the order it has to happen. No rendering in here, so it can be checked without a browser.
//
// A beat with a clip is performed on video. The player is walked to its mark and the view settles on
// a close framing, so the video can start from the very picture on screen. A clip that does not open
// the door also ends on that picture, so the room needs no new plate afterwards.
import SCENE from './sceneData.js'
import { arrive, completeStep, dueSteps, exitIsOpen, newProgress, objectiveIn, progressBefore, stepKey, storyFinished } from './journey.js'

const { story: STORY } = SCENE

export const TITLE = STORY.title
export const OPENING = STORY.opening
export const ENDING = STORY.ending
export const LAST_OBJECTIVE = STORY.lastObjective
export const SHOT_DISTANCE = 4.6 // Metres from the camera to whoever is performing.
export const ITEMS = STORY.items
export const BEATS = STORY.beats
export const STAGE_PROP = STORY.stageProp ?? null
export const OPENING_SHOT = STORY.openingShot
export const LAST_SHOT = { ...STORY.lastShot, during: STORY.ending }
// A place on the map of a story with chapters. Without these, a scene is a line of steps with one way out at the end.
export const JOURNEY = STORY.journey ?? null
export const EXITS = STORY.exits ?? []
export const SCENE_ID = STORY.sceneId ?? null

// Where the player has got to comes from outside: this page only ever knows one place, and the story goes on elsewhere.
function storyOnTheMap(started) {
  let progress = started ?? newProgress(JOURNEY)
  const dueHere = () => new Set(dueSteps(JOURNEY, progress).filter(step => step.scene === SCENE_ID).map(step => step.beat))
  const isDone = beat => progress.done.includes(stepKey(SCENE_ID, beat.id))
  return {
    get objective() { return objectiveIn(JOURNEY, progress, SCENE_ID) || LAST_OBJECTIVE },
    get items() { return [...progress.items] },
    get propOnStage() { return false },
    get progress() { return progress },
    get finished() { return storyFinished(JOURNEY, progress) },
    arrived() { progress = arrive(progress, SCENE_ID) },
    // Something the story wants now comes first, then a way that is open, then whatever is not ready yet.
    nearby(x, z) {
      const due = dueHere()
      const within = target => Math.hypot(x - target.x, z - target.z) <= target.radius
      const away = target => Math.hypot(x - target.x, z - target.z)
      const things = BEATS.filter(beat => !isDone(beat) && within(beat.target)).map(beat => ({ beat, ready: due.has(beat.id), rank: due.has(beat.id) ? 0 : 2, far: away(beat.target) }))
      const ways = EXITS.filter(exit => within(exit.target)).map(exit => {
        const ready = exitIsOpen(JOURNEY, progress, exit)
        return { beat: { ...exit, isExit: true }, ready, rank: ready ? 1 : 3, far: away(exit.target) }
      })
      const [best] = [...things, ...ways].sort((one, other) => one.rank - other.rank || one.far - other.far)
      return best ? { beat: best.beat, ready: best.ready } : null
    },
    complete(id) {
      const result = completeStep(JOURNEY, progress, SCENE_ID, id)
      progress = result.progress
      return result
    },
  }
}

// A place tried out in its whitebox, as if the story had just got here.
export const rehearsalProgress = () => progressBefore(JOURNEY, SCENE_ID)

export function createStory(progress = null) {
  if (JOURNEY) return storyOnTheMap(progress)
  let reached = 0
  // What the story says the protagonist walked in with, so any scene can be played on its own.
  const items = [...(STORY.carried ?? [])]
  return {
    get objective() { return BEATS[reached]?.objective ?? LAST_OBJECTIVE },
    get items() { return [...items] },
    // A stage prop lies out until the first beat picks it up.
    get propOnStage() { return reached === 0 },
    // What the player could act on from here. The beat that is due wins over one that is not.
    nearby(x, z) {
      const inReach = BEATS
        .map((beat, index) => ({ beat, index, distance: Math.hypot(x - beat.target.x, z - beat.target.z) }))
        .filter(({ beat, index, distance }) => index >= reached && distance <= beat.target.radius)
        .sort((a, b) => (a.index === reached ? -1 : b.index === reached ? 1 : a.distance - b.distance))
      if (!inReach.length) return null
      return { beat: inReach[0].beat, ready: inReach[0].index === reached }
    },
    complete(id) {
      const beat = BEATS[reached]
      if (beat?.id !== id) throw new Error(`剧情顺序不对：现在该 ${beat?.id}，却完成了 ${id}`)
      reached++
      // One beat can use up or hand over several things.
      for (const id of [beat.takes].flat().filter(Boolean)) items.splice(items.indexOf(id), 1)
      for (const id of [beat.gives].flat().filter(Boolean)) items.push(id)
    },
  }
}
