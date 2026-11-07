// Small pictures for the page. Plates are several megabytes each and a gallery shows dozens, so what the
// page shows is a cached thumbnail, named after what it was made from so it can be kept forever.
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { ffmpeg } from './ffmpeg.mjs'
import { projectDir } from './store.mjs'

const LIMIT = 3
let active = 0
const waiting = []

async function inTurn(work) {
  if (active >= LIMIT) await new Promise(resolve => waiting.push(resolve))
  active++
  try {
    return await work()
  } finally {
    active--
    waiting.shift()?.()
  }
}

const making = new Map()

// key turns screen green transparent, for props; at picks a moment from a video.
export async function thumbnail(projectId, source, { width = 640, at = null, key = false } = {}) {
  const { mtimeMs, size } = statSync(source)
  const name = createHash('sha256').update(JSON.stringify([source, mtimeMs, size, width, at, key])).digest('hex').slice(0, 24)
  const dir = join(projectDir(projectId), '.thumbs')
  const out = join(dir, `${name}.${key ? 'png' : 'jpg'}`)
  if (existsSync(out)) return out
  if (making.has(out)) return making.get(out)
  const job = inTurn(async () => {
    await mkdir(dir, { recursive: true })
    const moment = at ?? (/\.mp4$/i.test(source) ? 0.5 : null)
    const fresh = `${out}.${randomSuffix()}.${key ? 'png' : 'jpg'}`
    await ffmpeg(['-loglevel', 'error', ...(moment !== null ? ['-ss', String(moment)] : []), '-i', source, '-frames:v', '1',
      '-vf', `${key ? 'chromakey=0x00ff00:0.2:0.06,' : ''}scale=${width}:-2`, ...(key ? [] : ['-q:v', '4']), fresh])
    await rename(fresh, out)
    return out
  }).finally(() => making.delete(out))
  making.set(out, job)
  return job
}

const randomSuffix = () => Math.random().toString(36).slice(2, 8)
