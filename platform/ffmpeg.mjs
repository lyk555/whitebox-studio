// Every picture and video operation the steps need that is not a model call.
import { execFile, spawn } from 'node:child_process'
import { rename } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)
export const ffmpeg = (args, options = {}) => run('ffmpeg', ['-hide_banner', '-y', ...args], { maxBuffer: 2 ** 28, ...options })

const SPRITE_FRAME_SIZE = 768
const SPRITE_FPS = 24
// High enough quality that the first frame still matches the picture on screen.
export const VIDEO_ENCODE = ['-c:v', 'libx264', '-crf', '16', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-r', '24', '-c:a', 'aac', '-b:a', '160k']

export async function readRaw(path, width, height, flags = 'bilinear') {
  const { stdout } = await run('ffmpeg', ['-loglevel', 'error', '-i', path, '-vf', `scale=${width}:${height}:flags=${flags}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { encoding: 'buffer', maxBuffer: 2 ** 28 })
  return new Uint8ClampedArray(stdout.buffer, stdout.byteOffset, stdout.length)
}

export const readPicture = path => readRaw(path, SPRITE_FRAME_SIZE, SPRITE_FRAME_SIZE)

export async function readVideoFrames(path) {
  const { stdout } = await run('ffmpeg', ['-loglevel', 'error', '-i', path, '-vf', `fps=${SPRITE_FPS},scale=${SPRITE_FRAME_SIZE}:${SPRITE_FRAME_SIZE}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { encoding: 'buffer', maxBuffer: 2 ** 31 - 1 })
  const frameBytes = SPRITE_FRAME_SIZE * SPRITE_FRAME_SIZE * 4
  const frames = []
  for (let at = 0; at + frameBytes <= stdout.length; at += frameBytes) {
    frames.push(new Uint8ClampedArray(stdout.buffer, stdout.byteOffset + at, frameBytes))
  }
  return frames
}

export const SPRITE_SIZE = { frame: SPRITE_FRAME_SIZE }

export function writePng(path, pixels, width, height) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-i', 'pipe:0', '-frames:v', '1', path], { stdio: ['pipe', 'ignore', 'pipe'] })
    let errors = ''
    child.stderr.on('data', chunk => { errors += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`写入 ${path} 失败：${errors}`)))
    child.stdin.end(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.length))
  })
}

const PEAK_DB = -3

// The model mixes its sound very quietly. Only the sound is touched: re-encoding the picture would
// soften the first frame, which has to match the picture on screen.
export async function raiseSound(path) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', path, '-af', 'volumedetect', '-vn', '-f', 'null', '-'])
  const peak = stderr.match(/max_volume: (-?[\d.]+) dB/)
  if (!peak) throw new Error('视频里没有声音：模型没有返回音轨。')
  const gain = PEAK_DB - Number(peak[1])
  if (gain <= 0.5) return
  const louder = `${path}.louder.mp4`
  await ffmpeg(['-loglevel', 'error', '-i', path, '-c:v', 'copy', '-af', `volume=${gain.toFixed(1)}dB`, '-c:a', 'aac', '-b:a', '160k', louder])
  await rename(louder, path)
}

const MAX_LEAD_IN_SECONDS = 2

// Pinned to the game's picture, a part has to start on it, even when it follows another shot. It
// shows no face, so it can be cut freely: this drops everything before its first cut.
export async function dropLeadIn(path) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', path, '-vf', "select='gt(scene,0.3)',showinfo", '-f', 'null', '-'], { maxBuffer: 2 ** 28 })
  const cut = stderr.match(/pts_time:([\d.]+)/)
  if (!cut || Number(cut[1]) > MAX_LEAD_IN_SECONDS) return
  const trimmed = `${path}.trimmed.mp4`
  await ffmpeg(['-loglevel', 'error', '-ss', cut[1], '-i', path, ...VIDEO_ENCODE, trimmed])
  await rename(trimmed, path)
}

export async function durationOf(path) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', path]).catch(error => ({ stderr: error.stderr ?? '' }))
  const match = stderr.match(/Duration: (\d+):(\d+):([\d.]+)/)
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0
}

// What the model actually drew at each end, to measure against what the game shows.
export async function extractEnds(path, firstPath, lastPath) {
  await ffmpeg(['-loglevel', 'error', '-i', path, '-frames:v', '1', firstPath])
  await ffmpeg(['-loglevel', 'error', '-sseof', '-0.2', '-i', path, '-update', '1', lastPath])
}

export async function concatFiles(listPath, outPath) {
  await ffmpeg(['-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath, ...VIDEO_ENCODE, outPath])
}

// Clips from different moments can differ in shape or sound format, so each is conformed on the way in.
export async function joinFilm(paths, outPath) {
  const size = '1280:720'
  const filters = paths.map((_, i) =>
    `[${i}:v]scale=${size}:force_original_aspect_ratio=decrease,pad=${size}:(ow-iw)/2:(oh-ih)/2,fps=24,format=yuv420p,setsar=1[v${i}];[${i}:a]aresample=44100,aformat=channel_layouts=stereo[a${i}]`)
  const inputs = paths.map((_, i) => `[v${i}][a${i}]`).join('')
  await ffmpeg(['-loglevel', 'error', ...paths.flatMap(path => ['-i', path]), '-filter_complex', `${filters.join(';')};${inputs}concat=n=${paths.length}:v=1:a=1[v][a]`, '-map', '[v]', '-map', '[a]', ...VIDEO_ENCODE, outPath])
}
