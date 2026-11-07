// Runs a project's graph of steps. Nothing here knows about stories or pictures; it only knows that a
// step has inputs and outputs, and it holds three promises:
//   - A step is redone only when what went into it changed. That is decided by the content of its
//     inputs, never by dates, so an identical re-render downstream costs nothing.
//   - Everything needed to carry on is on disk, so a restart picks up where it stopped. A paid video
//     task's id is saved the moment it exists, and is collected instead of being paid for twice.
//   - A failure says why, stops only what depends on it, and is retried only if retrying could help.
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { insideProject, projectDir, writeAtomic } from './store.mjs'

const MAX_TRANSIENT_RETRIES = 3
const BACKOFF_SECONDS = [5, 20, 60]
// How many of each kind of work may run at once, across all projects.
const SLOTS = { text: 1, image: 3, video: 3, browser: 1, local: 2 }

export class FatalError extends Error {}
export class TransientError extends Error {}
export const isAbort = error => error?.name === 'AbortError' || error?.message === 'cancelled'

const hashCache = new Map() // path → { mtimeMs, size, hash }

export async function hashFile(path) {
  const { mtimeMs, size } = statSync(path)
  const known = hashCache.get(path)
  if (known && known.mtimeMs === mtimeMs && known.size === size) return known.hash
  const hash = createHash('sha256').update(await readFile(path)).digest('hex').slice(0, 24)
  hashCache.set(path, { mtimeMs, size, hash })
  return hash
}

const statePath = projectId => join(projectDir(projectId), 'state.json')

export async function readState(projectId) {
  try {
    return JSON.parse(await readFile(statePath(projectId), 'utf8'))
  } catch {
    return { nodes: {} }
  }
}

// One writer per project, in order, or a slower save could land after a newer one and undo it.
const stateWrites = new Map()

function saveState(projectId, state) {
  const write = (stateWrites.get(projectId) ?? Promise.resolve())
    .catch(() => {})
    .then(() => writeAtomic(statePath(projectId), JSON.stringify(state, null, 1)))
  stateWrites.set(projectId, write)
  return write
}

// What a step's inputs add up to right now. Null while an input does not exist yet.
export async function inputHash(project, node) {
  // Reading a story is the same work whichever way the pictures are going to be made.
  const provider = node.group === 'authoring' ? null : project.provider
  const hash = createHash('sha256').update(JSON.stringify([node.kind, provider, node.params ?? null]))
  for (const file of node.inputs ?? []) {
    const path = insideProjectOrShared(project, file)
    if (!path || !existsSync(path)) return null
    hash.update(`${file}:${await hashFile(path)}`)
  }
  return hash.digest('hex').slice(0, 24)
}

function insideProjectOrShared(project, file) {
  try {
    return insideProject(project.id, file)
  } catch {
    return null
  }
}

const outputsExist = (project, node) => (node.outputs ?? []).every(file => existsSync(insideProject(project.id, file)))

// done | stale | failed | running | waiting (for a step before it) | ready
export async function nodeStatuses(project, nodes, state, running = new Set()) {
  const statuses = {}
  const byId = new Map(nodes.map(node => [node.id, node]))
  const statusOf = async node => {
    if (statuses[node.id]) return statuses[node.id]
    const record = state.nodes[node.id]
    if (running.has(node.id)) return (statuses[node.id] = 'running')
    const hash = await inputHash(project, node)
    if (hash && record?.hash === hash && record.finished && outputsExist(project, node)) return (statuses[node.id] = 'done')
    if (record?.error && (hash === null || record.errorHash === hash)) return (statuses[node.id] = 'failed')
    for (const id of node.deps ?? []) {
      const before = byId.get(id)
      if (before && await statusOf(before) !== 'done') return (statuses[node.id] = 'waiting')
    }
    if (hash === null) return (statuses[node.id] = 'waiting')
    return (statuses[node.id] = record?.finished ? 'stale' : 'ready')
  }
  for (const node of nodes) await statusOf(node)
  return statuses
}

// Everything that may have to happen for these targets to be up to date, including what depends on
// something about to change. Identical re-renders can make the real number smaller, never larger.
export function planFor(nodes, statuses, targets = null) {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const wanted = new Set()
  const include = id => {
    if (wanted.has(id) || !byId.has(id)) return
    wanted.add(id)
    for (const dep of byId.get(id).deps ?? []) include(dep)
  }
  for (const id of targets ?? nodes.map(node => node.id)) include(id)
  const willRun = new Set(nodes.filter(node => wanted.has(node.id) && statuses[node.id] !== 'done').map(node => node.id))
  for (let changed = true; changed;) {
    changed = false
    for (const node of nodes) {
      if (wanted.has(node.id) && !willRun.has(node.id) && (node.deps ?? []).some(id => willRun.has(id))) {
        willRun.add(node.id)
        changed = true
      }
    }
  }
  const list = nodes.filter(node => willRun.has(node.id))
  return {
    wanted,
    nodes: list.map(node => node.id),
    calls: {
      text: list.filter(node => node.resource === 'text').length,
      image: list.reduce((sum, node) => sum + (node.resource === 'image' ? node.attempts ?? 1 : 0), 0),
      imageMin: list.filter(node => node.resource === 'image').length,
      video: list.filter(node => node.resource === 'video').length,
      videoSeconds: list.reduce((sum, node) => sum + (node.resource === 'video' ? node.seconds ?? 0 : 0), 0),
    },
  }
}

const inUse = Object.fromEntries(Object.keys(SLOTS).map(key => [key, 0]))
const runs = new Map() // project id → the run in progress
const listeners = new Map() // project id → Set of change callbacks

export const isRunning = projectId => runs.has(projectId)
export const runningNodes = projectId => new Set(runs.get(projectId)?.running.keys() ?? [])
export const runInfo = projectId => {
  const run = runs.get(projectId)
  return run ? { startedAt: run.startedAt, cancelling: run.controller.signal.aborted, provider: run.provider } : null
}

export function onChange(projectId, callback) {
  if (!listeners.has(projectId)) listeners.set(projectId, new Set())
  listeners.get(projectId).add(callback)
  return () => listeners.get(projectId).delete(callback)
}

const announce = projectId => { for (const callback of listeners.get(projectId) ?? []) callback() }

export function cancelRun(projectId) {
  const run = runs.get(projectId)
  if (!run) return false
  run.controller.abort(new Error('cancelled'))
  announce(projectId)
  return true
}

// A step that is redone keeps what it replaces: these pictures were paid for.
async function archiveOutputs(project, node) {
  if (!['image', 'video'].includes(node.resource)) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const file of node.outputs ?? []) {
    const from = insideProject(project.id, file)
    if (!existsSync(from)) continue
    const to = insideProject(project.id, join('archive', stamp, file))
    await mkdir(dirname(to), { recursive: true })
    await copyFile(from, to)
  }
}

const sleep = (seconds, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, seconds * 1000)
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')) }, { once: true })
})

async function runNode({ run, project, node, state, execute, hash }) {
  const record = state.nodes[node.id] ??= {}
  const previousExternal = record.external && record.externalHash === hash ? record.external : null
  await archiveOutputs(project, node)
  Object.assign(record, { startedAt: Date.now(), finished: false, error: null, errorHash: null, log: [], progress: null, metrics: {}, external: previousExternal, externalHash: previousExternal ? hash : null })
  const persist = () => { saveState(project.id, state).catch(() => {}); announce(project.id) }
  const context = {
    project,
    node,
    signal: run.controller.signal,
    external: previousExternal,
    log(message) {
      record.log.push({ at: Date.now(), message })
      if (record.log.length > 200) record.log.shift()
      persist()
    },
    progress(text) { record.progress = text; announce(project.id) },
    metric(name, value) { record.metrics[name] = value; persist() },
    // Written straight to disk, so a task the model is already working on survives a crash here.
    async setExternal(external) {
      record.external = external
      record.externalHash = hash
      await saveState(project.id, state)
    },
    path: file => insideProject(project.id, file),
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await execute(context)
      const missing = (node.outputs ?? []).filter(file => !existsSync(insideProject(project.id, file)))
      if (missing.length) throw new FatalError(`这一步结束了，却没有产出 ${missing.join('、')}。`)
      // A step can have changed its own inputs' meaning only through files, so this is read again.
      Object.assign(record, { finished: true, hash: await inputHash(project, node), finishedAt: Date.now(), seconds: (Date.now() - record.startedAt) / 1000, progress: null, external: null, externalHash: null, error: null, attempts: attempt + 1 })
      return
    } catch (error) {
      if (isAbort(error) || run.controller.signal.aborted) {
        record.progress = null
        record.log.push({ at: Date.now(), message: '已停止，下次运行会接着做。' })
        return
      }
      const retryable = error instanceof TransientError && attempt < MAX_TRANSIENT_RETRIES
      if (!retryable) {
        Object.assign(record, { error: error.message, errorHash: hash, progress: null, finishedAt: Date.now() })
        return
      }
      const wait = run.backoff[Math.min(attempt, run.backoff.length - 1)]
      context.log(`暂时性问题，${wait} 秒后重试（第 ${attempt + 1} 次）：${error.message}`)
      try {
        await sleep(wait, run.controller.signal)
      } catch {
        return
      }
    }
  }
}

// Runs until nothing more can happen: done, stopped, or blocked by a failure.
export function startRun({ project: initial, targets = null, retryFailed = true, graph, execute, reload, backoff = BACKOFF_SECONDS, onFinish = () => {} }) {
  if (runs.has(initial.id)) throw new Error('这个项目已经在运行了。')
  const run = { controller: new AbortController(), running: new Map(), startedAt: Date.now(), provider: initial.provider, backoff }
  runs.set(initial.id, run)
  announce(initial.id)
  const done = (async () => {
    const state = await readState(initial.id)
    if (retryFailed) {
      // Only what this run is going to try again. Any other failure still has something to say.
      const project = await reload()
      const nodes = graph(project)
      const { wanted } = planFor(nodes, {}, typeof targets === 'function' ? targets(project) : targets)
      for (const id of wanted) {
        if (state.nodes[id]) Object.assign(state.nodes[id], { error: null, errorHash: null })
      }
    }
    for (;;) {
      if (run.controller.signal.aborted) break
      // Read again each round: a step can change what the graph looks like.
      const project = await reload()
      const nodes = graph(project)
      const statuses = await nodeStatuses(project, nodes, state, new Set(run.running.keys()))
      const { wanted } = planFor(nodes, statuses, typeof targets === 'function' ? targets(project) : targets)
      let started = false
      let queued = false
      for (const node of nodes) {
        if (!wanted.has(node.id) || !['ready', 'stale'].includes(statuses[node.id])) continue
        if (inUse[node.resource] >= SLOTS[node.resource]) {
          queued = true
          continue
        }
        inUse[node.resource]++
        started = true
        const hash = await inputHash(project, node)
        const promise = runNode({ run, project, node, state, execute, hash }).finally(() => {
          inUse[node.resource]--
          run.running.delete(node.id)
          saveState(project.id, state).catch(() => {})
          announce(project.id)
        })
        run.running.set(node.id, promise)
      }
      if (started) await saveState(project.id, state)
      announce(project.id)
      if (run.running.size) {
        await Promise.race(run.running.values())
        continue
      }
      // Another project holds the slots this one needs, which is a wait and not an ending.
      if (queued) {
        await sleep(1, run.controller.signal).catch(() => {})
        continue
      }
      if (!started) break
    }
    await Promise.allSettled(run.running.values())
    state.lastRunError = null
    await saveState(initial.id, state)
  })()
    .catch(async error => {
      // Something other than a step went wrong. Steps still under way are left to finish, since
      // what they are doing has been paid for, and the reason is kept for the page to show.
      await Promise.allSettled(run.running.values())
      run.error = error.message
      const state = await readState(initial.id)
      state.lastRunError = error.message
      await saveState(initial.id, state).catch(() => {})
    })
    .finally(() => {
      runs.delete(initial.id)
      announce(initial.id)
      onFinish(run)
    })
  return { run, done }
}

// Forget a step's result, so the next run makes it again. What it made stays until then.
export async function resetNode(projectId, nodeId) {
  const state = await readState(projectId)
  const record = state.nodes[nodeId]
  if (record) Object.assign(record, { hash: null, finished: false, error: null, errorHash: null, external: null, externalHash: null })
  await saveState(projectId, state)
  announce(projectId)
}

// Changes what is remembered about steps, all in one write. Whatever `change` returns comes back.
export async function updateRecords(projectId, change) {
  const state = await readState(projectId)
  const result = change(state.nodes)
  await saveState(projectId, state)
  announce(projectId)
  return result
}

// Accept what is on disk as a step's result without running it.
export async function adoptNode(project, node) {
  const state = await readState(project.id)
  state.nodes[node.id] = { finished: true, hash: await inputHash(project, node), finishedAt: Date.now(), adopted: true, log: [], metrics: {} }
  await saveState(project.id, state)
}
