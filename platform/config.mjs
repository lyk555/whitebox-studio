// Settings live in this folder's .env. The whitebox-loop experiment's .env is read as a fallback, so a
// key saved there works here without being copied anywhere.
import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ENV_PATH = join(ROOT, '.env')
const FALLBACK_ENV_PATH = join(ROOT, '..', 'whitebox-loop', '.env')

const FIELDS = { apiKey: 'ARK_API_KEY', baseURL: 'ARK_BASE_URL', textModel: 'TEXT_MODEL', writerModel: 'WRITER_MODEL', imageModel: 'IMAGE_MODEL', videoModel: 'VIDEO_MODEL' }

function readEnvFile(path) {
  const values = {}
  if (!existsSync(path)) return values
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)
    if (match) values[match[1]] = match[2]
  }
  return values
}

export const DEFAULT_IMAGE_MODEL = 'doubao-seedream-5-0-pro-260628'
// Ark closes these on 2026-11-24 14:00 (UTC+8) and moves nobody off them, so a saved one would fail outright.
const RETIRED_IMAGE_MODEL = /^doubao-seedream-(?:5-0-(?:lite-)?260128|4-5-251128|4-0-250828)$/
export const upgradeImageModel = model => (RETIRED_IMAGE_MODEL.test(model) ? DEFAULT_IMAGE_MODEL : model)

// Read on every call, so a changed setting takes effect without a restart.
export function config() {
  const own = readEnvFile(ENV_PATH)
  const fallback = readEnvFile(FALLBACK_ENV_PATH)
  const read = (name, otherwise = '') => own[name] || process.env[name] || fallback[name] || otherwise
  return {
    // For a run that must not reach any model, whatever is saved here: a preview that cannot be paid for.
    key: process.env.STUDIO_NO_KEY ? '' : read('ARK_API_KEY'),
    baseURL: read('ARK_BASE_URL', 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, ''),
    textModel: read('TEXT_MODEL', 'doubao-seed-2-0-lite-260428'),
    // Writing the drama. A whole script costs under a yuan either way, and lite could not carry a designed plot through.
    writerModel: read('WRITER_MODEL', 'doubao-seed-2-0-pro-260215'),
    imageModel: upgradeImageModel(read('IMAGE_MODEL', DEFAULT_IMAGE_MODEL)),
    videoModel: read('VIDEO_MODEL', 'doubao-seedance-2-0-260128'),
  }
}

// The key never leaves this process: the page only learns whether one is saved.
export function publicSettings() {
  const { key, baseURL, textModel, writerModel, imageModel, videoModel } = config()
  return { hasKey: Boolean(key), baseURL, textModel, writerModel, imageModel, videoModel }
}

// A blank field keeps what is saved. Other lines in .env are left as they are.
export async function saveSettings(input) {
  const updates = {}
  for (const [field, name] of Object.entries(FIELDS)) {
    const value = String(input[field] ?? '').trim()
    if (!value) continue
    if (/\s/.test(value)) throw new Error(`${name} 不能包含空格或换行。`)
    updates[name] = value
  }
  if (updates.ARK_BASE_URL && !URL.canParse(updates.ARK_BASE_URL)) throw new Error('接口地址不是有效的网址。')
  if (updates.ARK_BASE_URL && !/^https?:$/.test(new URL(updates.ARK_BASE_URL).protocol)) throw new Error('接口地址必须以 http 或 https 开头。')
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8').split(/\r?\n/) : []
  const kept = lines.map(line => {
    const name = line.match(/^\s*([A-Z_]+)\s*=/)?.[1]
    if (!name || !(name in updates)) return line
    const replaced = `${name}=${updates[name]}`
    delete updates[name]
    return replaced
  })
  while (kept.length && !kept.at(-1).trim()) kept.pop()
  for (const [name, value] of Object.entries(updates)) kept.push(`${name}=${value}`)
  await writeFile(ENV_PATH, `${kept.join('\n')}\n`)
}
