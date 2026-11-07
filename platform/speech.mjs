// What people say out loud, and how long it takes. A shot with lines has to be long enough to say them, and the video
// model only goes so far, so what will not fit goes back to whoever wrote it.
const CHARS_PER_SECOND = 5 // Ordinary conversation in Mandarin.
const PAUSE_BETWEEN_LINES = 0.6
const ROOM_AROUND_LINES = 1
const SHORTEST_TALKING_SHOT = 5
export const LONGEST_TALKING_SHOT = 12
export const ACTION_BEFORE_FACE = 5 // The shot of the hands that comes before a shot with a face.

const clean = value => String(value ?? '').trim()

export const spokenLines = value => (Array.isArray(value) ? value : []).map(line => ({ who: clean(line?.who), says: clean(line?.says) })).filter(line => line.who && line.says)

const secondsNeeded = lines => lines.reduce((sum, line) => sum + line.says.length / CHARS_PER_SECOND + PAUSE_BETWEEN_LINES, ROOM_AROUND_LINES)

export const speechSeconds = lines => Math.min(LONGEST_TALKING_SHOT, Math.max(SHORTEST_TALKING_SHOT, Math.ceil(secondsNeeded(lines))))

// When each line is on screen, counted from the start of the clip the shot sits in.
export function speechTiming(lines, start, scale = 1) {
  const total = speechSeconds(lines) * scale
  const weight = lines.reduce((sum, line) => sum + line.says.length, 0)
  let at = start
  return lines.map(line => {
    const from = at
    at += total * line.says.length / weight
    return { from: Number(from.toFixed(2)), to: Number(at.toFixed(2)), text: `${line.who}：${line.says}` }
  })
}

// What is wrong with a shot's lines, or nothing. Only someone in the shot can speak in it.
export function linesProblem({ face, faceCast = [], lines = [] }, cast, label) {
  if (!lines.length) return null
  if (!clean(face)) return `${label}写了台词，但没有露脸镜头。台词只能写在露脸镜头里。`
  const player = cast.find(person => person.playable)?.name
  const inShot = [player, ...faceCast].filter(Boolean)
  const stranger = lines.find(line => !inShot.includes(line.who))
  if (stranger) return `${label}的台词是“${stranger.who}”说的，但这个镜头里只有：${inShot.join('、')}。说话的人要写人物表里的全名，并且在 face_cast 里。`
  if (secondsNeeded(lines) > LONGEST_TALKING_SHOT) {
    // A model cannot count, and "too long" five times over teaches it nothing. Say how long, and which.
    const room = Math.floor((LONGEST_TALKING_SHOT - ROOM_AROUND_LINES - lines.length * PAUSE_BETWEEN_LINES) * CHARS_PER_SECOND)
    const total = lines.reduce((sum, line) => sum + line.says.length, 0)
    return `${label}的台词有 ${lines.length} 句共 ${total} 个字，一个镜头最多 ${LONGEST_TALKING_SHOT} 秒，这样只说得完 ${room} 个字，要删掉 ${total - room} 个字以上，或者把一半分到另一步的露脸镜头。现在写的是：${lines.map(line => `${line.who}：${line.says}（${line.says.length} 字）`).join('；')}`
  }
  return null
}
