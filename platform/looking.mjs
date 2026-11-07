// Pictures for the text model to look at: a sheet of frames from a video, or a picture made small enough to send. It sees
// them, it does not hear them, so nothing that comes back from here says anything about sound.
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { durationOf, ffmpeg } from './ffmpeg.mjs'
import { buildGraph, cardsFor } from './graph.mjs'
import { insideProject } from './store.mjs'

const FRAMES_ACROSS = 4
const FRAMES_DOWN = 2
const FRAME_WIDTH = 480
const PICTURE_WIDTH = 1280
const WHOLE_FILM_EVERY = 4 // Seconds between frames when the whole film is looked over.
const WHOLE_FILM_ACROSS = 6
const WHOLE_FILM_DOWN = 4
const WHOLE_FILM_SHEETS = 8
export const MOST_LOOKED_AT = 8

async function asImage(args, name) {
  const dir = await mkdtemp(join(tmpdir(), 'whitebox-look-'))
  try {
    const out = join(dir, name)
    await ffmpeg(['-loglevel', 'error', ...args, '-frames:v', '1', '-q:v', '4', out])
    return `data:image/jpeg;base64,${(await readFile(out)).toString('base64')}`
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const sheetOf = async path => {
  const count = FRAMES_ACROSS * FRAMES_DOWN
  const length = await durationOf(path)
  return asImage(['-i', path, '-vf', `fps=${((count - 1) / Math.max(length, 0.5)).toFixed(4)},scale=${FRAME_WIDTH}:-2,tile=${FRAMES_ACROSS}x${FRAMES_DOWN}`], 'sheet.jpg')
}

const pictureOf = path => asImage(['-i', path, '-vf', `scale=${PICTURE_WIDTH}:-2`], 'picture.jpg')

// The film seen from far off, for "看一遍全片". Each sheet says which seconds it covers.
async function filmSheets(path) {
  const length = await durationOf(path)
  const perSheet = WHOLE_FILM_ACROSS * WHOLE_FILM_DOWN * WHOLE_FILM_EVERY
  const every = Math.max(WHOLE_FILM_EVERY, length / (WHOLE_FILM_ACROSS * WHOLE_FILM_DOWN * WHOLE_FILM_SHEETS))
  const span = every / WHOLE_FILM_EVERY * perSheet
  const sheets = []
  for (let start = 0; start < length; start += span) {
    sheets.push({
      label: `成片第 ${Math.round(start)} 到 ${Math.round(Math.min(length, start + span))} 秒，每 ${Math.round(every)} 秒一帧`,
      url: await asImage(['-ss', String(start), '-t', String(span), '-i', path, '-vf', `fps=1/${every.toFixed(3)},scale=320:-2,tile=${WHOLE_FILM_ACROSS}x${WHOLE_FILM_DOWN}`], 'film.jpg'),
    })
  }
  return sheets
}

// What each thing is called in a note: the same names a remake uses.
export async function picturesOf(project, targets) {
  const cards = cardsFor(project, buildGraph(project))
  const seen = []
  const missing = []
  for (const target of [...new Set(targets)]) {
    if (target === 'film') {
      const film = insideProject(project.id, 'film.mp4')
      if (existsSync(film)) seen.push(...await filmSheets(film))
      else missing.push(target)
      continue
    }
    const card = cards.find(candidate => candidate.id === target)
    const path = card?.hero ? insideProject(project.id, card.hero) : null
    if (!path || !existsSync(path)) {
      missing.push(target)
      continue
    }
    const isVideo = path.endsWith('.mp4')
    seen.push({
      id: target,
      label: `${card.section.replace(/^(布景|镜头) · /, '')} · ${card.title}${isVideo ? `（视频，${FRAMES_ACROSS * FRAMES_DOWN} 帧，从左到右、从上到下）` : ''}`,
      url: await (isVideo ? sheetOf(path) : pictureOf(path)),
    })
  }
  return { seen: seen.slice(0, Math.max(MOST_LOOKED_AT, WHOLE_FILM_SHEETS)), missing }
}
