// Pictures only the game's own renderer can draw: the whitebox guides, the second camera's view of the
// first camera's plates, and the frames videos start from. Each one is a fresh headless browser opened
// on the scene's game page, so these steps need no tab left open and leak nothing into each other.
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FatalError } from './engine.mjs'

const BROWSERS = [
  process.env.STUDIO_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

const SILENT_SECONDS = 180 // The page reports in every 10 seconds, but loading the plates in software takes a while.

const jobs = new Map()
let origin = ''

export const setOrigin = value => { origin = value }
export const browserPath = () => BROWSERS.find(path => existsSync(path)) ?? null

export function jobRequest(id) {
  const job = jobs.get(id)
  return job ? { op: job.op } : null
}

export function jobReport(id, { alive, result, error }) {
  const job = jobs.get(id)
  if (!job) return
  job.heardFrom()
  if (alive) return
  if (error) job.reject(new FatalError(`舞台页面报错：${error}`))
  else job.resolve(result)
}

export async function runBrowserJob({ projectId, sceneId, op, signal, onStatus = () => {} }) {
  const browser = browserPath()
  if (!browser) throw new FatalError('没有找到 Chrome 或 Edge，画不了引导图。可以用环境变量 STUDIO_BROWSER 指定浏览器路径。')
  const id = randomBytes(8).toString('hex')
  const profile = await mkdtemp(join(tmpdir(), 'studio-browser-'))
  const url = `${origin}/play/${projectId}/${sceneId}/?job=${id}`
  let child
  let watchdog
  try {
    return await new Promise((resolve, reject) => {
      const heardFrom = () => {
        clearTimeout(watchdog)
        watchdog = setTimeout(() => reject(new FatalError(`舞台页面 ${SILENT_SECONDS} 秒没有回应（任务 ${op}）。`)), SILENT_SECONDS * 1000)
      }
      jobs.set(id, { op, resolve, reject, heardFrom })
      heardFrom()
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      onStatus('正在渲染')
      child = spawn(browser, [
        '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
        '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl',
        '--window-size=1400,900', `--user-data-dir=${profile}`, url,
      ], { stdio: 'ignore' })
      child.on('error', error => reject(new FatalError(`打不开浏览器：${error.message}`)))
    })
  } finally {
    clearTimeout(watchdog)
    jobs.delete(id)
    await stopBrowser(child)
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {})
  }
}

function stopBrowser(child) {
  if (!child?.pid) return Promise.resolve()
  return new Promise(resolve => {
    if (process.platform === 'win32') {
      // Chrome is a family of processes, and the parent alone leaves the rest holding the profile.
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => resolve())
    } else {
      child.kill('SIGKILL')
      resolve()
    }
  })
}
