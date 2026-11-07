// The words in a film: the narration the game shows, and what people say. Worked out when asked for from the story as it
// stands, so a corrected line is right at once and costs nothing.
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { durationOf } from './ffmpeg.mjs'
import { buildGraph, stageOf } from './graph.mjs'
import { filmClips } from './prompts.mjs'
import { speechTiming } from './speech.mjs'
import { insideProject } from './store.mjs'

const clock = seconds => {
  const whole = Math.max(0, seconds)
  const part = (value, size = 2) => String(Math.floor(value)).padStart(size, '0')
  return `${part(whole / 3600)}:${part((whole % 3600) / 60)}:${part(whole % 60)}.${part((whole % 1) * 1000, 3)}`
}

// Each clip's words, in seconds from its own start, for a clip that really lasts `length`.
function linesOfClip(scene, clip, length) {
  const planned = clip.parts.reduce((sum, part) => sum + part.duration, 0)
  const scale = length / planned
  const talkingAt = clip.parts.findIndex(part => part.lines?.length)
  const talkStart = clip.parts.slice(0, Math.max(0, talkingAt)).reduce((sum, part) => sum + part.duration, 0) * scale
  const talk = talkingAt < 0 ? [] : speechTiming(clip.parts[talkingAt].lines, talkStart, scale)
  const talkEnd = talk.at(-1)?.to
  const beat = scene.beats.find(candidate => candidate.id === clip.id)
  const beforeTalk = talk.length ? talk[0].from : length * 0.55
  const narration = clip.id === 'opening' ? [{ from: 0, to: length, text: scene.openingLine }]
    : clip.id === 'door' ? [{ from: 0, to: length, text: scene.exit?.during }]
      : clip.id === 'ending' ? [{ from: 0, to: beforeTalk, text: scene.endingLine }]
        : [{ from: 0, to: beforeTalk, text: beat?.during }, { from: talk.length ? talkEnd : beforeTalk, to: length, text: beat?.after }]
  return [...narration, ...talk].filter(line => line.text && line.to > line.from).sort((one, other) => one.from - other.from)
}

export function captionsFrom(project, chapters, filmLength) {
  const clipOf = new Map()
  for (const scene of project.scenes) {
    for (const clip of filmClips(project, scene, stageOf(scene))) clipOf.set(`scenes/${scene.id}/${clip.id}.mp4`, { scene, clip })
  }
  const order = buildGraph(project).find(node => node.id === 'film')?.params.clips ?? []
  if (order.length !== chapters.length) return []
  return order.flatMap(({ file }, index) => {
    const found = clipOf.get(file)
    if (!found) return []
    const start = chapters[index].start
    const length = (chapters[index + 1]?.start ?? filmLength) - start
    return linesOfClip(found.scene, found.clip, length).map(line => ({ ...line, from: line.from + start, to: line.to + start }))
  })
}

export function asWebVtt(lines) {
  return `WEBVTT\n\n${lines.map(line => `${clock(line.from)} --> ${clock(line.to)}\n${line.text}`).join('\n\n')}\n`
}

export async function filmCaptions(project) {
  const chaptersFile = insideProject(project.id, 'chapters.json')
  const film = insideProject(project.id, 'film.mp4')
  if (project.readonly || !existsSync(chaptersFile) || !existsSync(film)) return asWebVtt([])
  return asWebVtt(captionsFrom(project, JSON.parse(await readFile(chaptersFile, 'utf8')), await durationOf(film)))
}
