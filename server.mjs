// The studio's web server: the workflow's page, its API, and each scene's game page.
// It listens only on this machine, and the key stays here.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { applyProposal, dismissProposal, forgetUndo, hearNote, lookAtWhatWasMade, lookWhenFinished, publicAgent, undoLast } from './platform/agent.mjs'
import { browserPath, jobReport, jobRequest, setOrigin } from './platform/browserJobs.mjs'
import { filmCaptions } from './platform/captions.mjs'
import { publicSettings, ROOT, saveSettings } from './platform/config.mjs'
import { ensureDemo } from './platform/demo.mjs'
import { cancelRun, isRunning, nodeStatuses, onChange, planFor, readState, resetNode, runInfo, runningNodes, startRun } from './platform/engine.mjs'
import { buildGraph, cardsFor, generationTargets, isAuthoring, loadDemoData, publicNode, stageOf } from './platform/graph.mjs'
import { readerProvider, testConnection } from './platform/providers.mjs'
import { chatWithSet, HISTORY_KEPT } from './platform/setChat.mjs'
import { ARCHETYPES, SLOTS } from './platform/stage.mjs'
import { executeNode } from './platform/steps.mjs'
import { castDir, createProject, insideProject, listProjects, readProject, removeFromLibrary, sceneDir, writeAtomic, writeProject } from './platform/store.mjs'
import { thumbnail } from './platform/thumbs.mjs'
import { anchorsOf, isWorld, planOf, worldProblems } from './platform/world.mjs'
import { CAMERAS } from './runtime/world.js'

await loadDemoData()
await ensureDemo().catch(error => console.error(`示例项目没有导入：${error.message}`))

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
}

const sendJson = (res, status, body) => res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(body))

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

// Video players ask for pieces of a file, and seeking does not work if they are refused.
async function sendFile(req, res, path) {
  let data
  try {
    data = await readFile(path)
  } catch {
    res.writeHead(404).end('not found')
    return
  }
  const type = MIME[extname(path)] || 'application/octet-stream'
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/)
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, data.length - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1
    if (start >= data.length || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${data.length}` }).end()
      return
    }
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store' }).end(data.subarray(start, end + 1))
    return
  }
  res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }).end(data)
}

// A font never changes, and a page of Chinese asks for dozens of pieces of one.
async function sendFontFile(req, res, path) {
  try {
    const data = await readFile(path)
    res.writeHead(200, { 'Content-Type': extname(path) === '.css' ? MIME['.css'] : 'font/woff2', 'Cache-Control': 'public, max-age=31536000, immutable' }).end(data)
  } catch {
    res.writeHead(404).end('not found')
  }
}

function underBase(base, relative) {
  const path = normalize(join(base, relative))
  return path === base || path.startsWith(base + sep) ? path : null
}

// These routes can change the key and where it is sent, so another website open in the same browser
// must not be able to reach them.
function isFromThisPage(req) {
  const host = String(req.headers.host || '').split(':')[0]
  if (host !== '127.0.0.1' && host !== 'localhost') return false
  const { origin } = req.headers
  return !origin || origin === 'null' || origin === `http://${req.headers.host}`
}

const playerOf = project => project.cast.find(person => person.playable) ?? project.cast[0]

// A scene's game page looks in three places, so the same address finds a plate, a shared walk or a
// picture from the experiment this was built on.
function assetFolders(project, sceneId) {
  const player = playerOf(project)
  return [
    project.readonly ? null : sceneDir(project.id, sceneId),
    project.readonly || !player ? null : castDir(project.id, player.id),
    project.assetsFrom ?? null,
  ].filter(Boolean)
}

async function assetNames(folders) {
  const names = new Set()
  for (const folder of folders) {
    if (!existsSync(folder)) continue
    for (const name of await readdir(folder)) names.add(name)
  }
  return [...names]
}

async function servePlay(req, res, projectId, sceneId, rest) {
  const project = await readProject(projectId)
  const scene = project.scenes.find(candidate => candidate.id === sceneId)
  if (!scene) return sendJson(res, 404, { error: `没有这个场景：${sceneId}` })
  const folders = assetFolders(project, sceneId)

  if (req.method === 'GET' && rest === 'sceneData.js') {
    if (scene.demoStage) return sendFile(req, res, join(ROOT, 'runtime', 'sceneData.js'))
    const data = stageOf(scene).data
    // A place on the map carries the plan of the whole story, since what is due here depends on what was done elsewhere.
    const body = `export default ${JSON.stringify(isWorld(project) ? { ...data, story: { ...data.story, journey: planOf(project) } } : data)}\n`
    return res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' }).end(body)
  }
  if (req.method === 'GET' && rest === 'api/status') return sendJson(res, 200, { assets: await assetNames(folders) })
  if (rest === 'api/job') {
    if (req.method === 'GET') {
      const job = jobRequest(new URL(req.url, 'http://localhost').searchParams.get('id'))
      return job ? sendJson(res, 200, job) : sendJson(res, 404, { error: '没有这个任务。' })
    }
    const body = await readJson(req)
    jobReport(body.id, body)
    return sendJson(res, 200, { ok: true })
  }
  if (req.method === 'POST' && rest === 'api/save') {
    if (project.readonly) return sendJson(res, 403, { error: '这个项目是只读的。' })
    const { name, dataUrl, text } = await readJson(req)
    if (!/^[a-z0-9_]+\.(png|json)$/.test(name)) throw new Error(`文件名不合法：${name}`)
    const bytes = text === undefined ? Buffer.from(dataUrl.split(',')[1], 'base64') : Buffer.from(text)
    const dir = sceneDir(projectId, sceneId)
    await mkdir(dir, { recursive: true })
    const path = join(dir, name)
    // Left alone when identical, so nothing downstream looks changed.
    const changed = !existsSync(path) || !readFileSync(path).equals(bytes)
    if (changed) await writeAtomic(path, bytes)
    return sendJson(res, 200, { ok: true, changed })
  }
  if (req.method === 'GET' && rest.startsWith('assets/')) {
    const name = decodeURIComponent(rest.slice('assets/'.length))
    for (const folder of folders) {
      const path = underBase(folder, name)
      if (path && existsSync(path)) return sendFile(req, res, path)
    }
    return res.writeHead(404).end('not found')
  }
  if (req.method === 'GET') {
    const path = underBase(join(ROOT, 'runtime'), rest || 'index.html')
    return path ? sendFile(req, res, path) : res.writeHead(403).end()
  }
  res.writeHead(405).end()
}

// A project's own file, or for a read-only project, a picture it only borrows.
function resolveFile(project, relative) {
  const own = insideProject(project.id, relative)
  if (existsSync(own) || !project.assetsFrom) return own
  return underBase(project.assetsFrom, relative) ?? own
}

// What a card in the library says.
async function librarySummary(project) {
  const nodes = buildGraph(project)
  const state = await readState(project.id)
  const statuses = await nodeStatuses(project, nodes, state, runningNodes(project.id))
  const making = nodes.filter(node => !isAuthoring(node))
  const done = making.filter(node => statuses[node.id] === 'done').length
  const filmDone = existsSync(insideProject(project.id, 'film.mp4')) && statuses.film === 'done'
  const firstScene = project.scenes[0]
  const candidates = project.readonly ? ['plate_a_closed.png'] : firstScene ? [`scenes/${firstScene.id}/plate_a_closed.png`, `scenes/${firstScene.id}/clay_a_closed.png`] : []
  const cover = candidates.find(file => existsSync(resolveFile(project, file))) ?? null
  let phase = '写故事中'
  if (project.readonly || filmDone) phase = '已完成'
  else if (isRunning(project.id)) phase = making.length ? `制作中 ${Math.round((done / making.length) * 100)}%` : '正在读故事'
  else if (done > 0) phase = `已完成 ${Math.round((done / making.length) * 100)}%`
  else if (project.scenes.some(scene => scene.objects?.length)) phase = '白模已搭好'
  else if (project.scenes.some(scene => scene.beats?.length)) phase = '剧本已写好'
  else if (project.scenes.length) phase = isWorld(project) ? '地点图已设计' : '场景已拆好'
  else if (project.cast.length) phase = '人物已拆好'
  else if (project.chapters?.length) phase = '章节已定好'
  return {
    id: project.id, title: project.title, readonly: Boolean(project.readonly), updatedAt: project.updatedAt, excerpt: project.story.slice(0, 80), cover, phase,
    progress: project.readonly ? 1 : making.length ? done / making.length : 0, hasFilm: project.readonly || filmDone, scenes: project.scenes.length, cast: project.cast.length, chapters: project.chapters?.length ?? 0,
  }
}

// Everything the page shows about a project.
async function projectView(project) {
  const nodes = buildGraph(project)
  const state = await readState(project.id)
  const running = runningNodes(project.id)
  const statuses = await nodeStatuses(project, nodes, state, running)
  const stages = Object.fromEntries(project.scenes.map(scene => {
    const stage = stageOf(scene)
    const { room, DOOR, CAMERAS: cameras, kind, exit, CORRIDOR } = stage.shell
    return [scene.id, { ok: stage.ok, issues: stage.issues, blocks: stage.blocks.map(({ parts, ...block }) => block), story: stage.data.story, spawn: stage.data.spawn, shell: { room, door: DOOR, cameras, kind, exit, corridor: CORRIDOR, exits: stage.shell.EXITS } }]
  }))
  const records = Object.fromEntries(nodes.map(node => {
    const record = state.nodes[node.id]
    return [node.id, record ? { error: record.error, log: record.log, metrics: record.metrics, seconds: record.seconds, progress: record.progress, startedAt: record.startedAt, finishedAt: record.finishedAt, adopted: record.adopted, attempts: record.attempts, hasExternal: Boolean(record.external) } : null]
  }))
  const generation = generationTargets(nodes)
  return {
    project: { ...project, agent: publicAgent(project) },
    stages,
    ...(isWorld(project) ? { journey: planOf(project), worldProblems: project.scenes.length && anchorsOf(project).some(anchor => anchor.steps?.length) ? worldProblems(project) : [] } : {}),
    nodes: nodes.map(publicNode),
    cards: cardsFor(project, nodes),
    hasKey: publicSettings().hasKey,
    statuses,
    records,
    run: runInfo(project.id),
    plan: planFor(nodes, statuses, generation).calls,
    filmReady: existsSync(insideProject(project.id, 'film.mp4')),
    lastRunError: state.lastRunError ?? null,
    interrupted: !running.size && nodes.some(node => state.nodes[node.id]?.external && statuses[node.id] !== 'done'),
  }
}

function launch(project, targets, { retryFailed = true } = {}) {
  return startRun({
    project,
    targets,
    retryFailed,
    graph: buildGraph,
    reload: () => readProject(project.id),
    execute: executeNode,
    // Whatever was made gets looked at. Stopping a run is not asking for that.
    onFinish: run => {
      if (run.controller.signal.aborted) return
      lookAtWhatWasMade({ id: project.id, startedAt: run.startedAt, provider: readerProvider(), signal: new AbortController().signal }).catch(error => console.error('看画面失败：', error.message))
    },
  })
}

// What was agreed to, carried out: the same whether it was a button or a sentence that said so.
async function carryOut(id, regenerate) {
  const project = await readProject(id)
  if (!project.agent?.proposal) {
    refuseUnlessInvalid(project)
    project.agent.undo = null
    project.agent.redoPending = false
    await writeProject(project)
    launch(project, current => generationTargets(buildGraph(current)))
    return project
  }
  const neverMade = project.agent.proposal.plan.neverMade
  const { project: changed, needsLayout } = await applyProposal(id)
  // A new scene is drawn before anything is painted, and what painting it costs is only known once it stands.
  if (needsLayout.length) launch(changed, needsLayout.map(sceneId => `story:layout:${sceneId}`))
  else if (regenerate && !neverMade) {
    refuseUnlessInvalid(changed)
    changed.agent.undo = null
    changed.agent.redoPending = false
    await writeProject(changed)
    launch(changed, current => generationTargets(buildGraph(current)))
  }
  return changed
}

// What a step's stored result depends on stays valid only while the things it read stay the same, so
// nothing about the story can be edited out from under a step that is reading it.
function refuseWhileRunning(projectId) {
  if (isRunning(projectId)) throw Object.assign(new Error('正在运行，先停下来再改。'), { status: 409 })
}

// What each stage of a story with chapters makes.
const WORLD_STAGES = { outline: ['story:outline'], people: ['story:cast', 'story:world'], script: ['story:script'] }

const EDITABLE = ['title', 'story', 'style', 'cast', 'scenes', 'chapters', 'provider']
const STORY_EDITS = EDITABLE.filter(field => field !== 'provider')

function refuseUnlessInvalid(project) {
  const invalid = project.scenes.flatMap(scene => stageOf(scene).ok ? [] : [scene.title])
  if (invalid.length) throw Object.assign(new Error(`这些场景的白模还没通过检查：${invalid.join('、')}`), { status: 400 })
  // Pictures of a story that cannot be finished are money spent on what cannot be played.
  const unplayable = isWorld(project) ? worldProblems(project) : []
  if (unplayable.length) throw Object.assign(new Error(`这个故事还走不通：${unplayable.join(' ')}`), { status: 400 })
}

async function routeProject(req, res, id, rest) {
  const project = await readProject(id)
  if (req.method === 'GET' && !rest) return sendJson(res, 200, await projectView(project))

  if (req.method === 'PUT' && !rest) {
    refuseWhileRunning(id)
    if (project.readonly) throw Object.assign(new Error('这个项目是只读的。'), { status: 403 })
    const patch = await readJson(req)
    for (const field of EDITABLE) if (field in patch) project[field] = patch[field]
    if ('title' in patch) project.titleLocked = true
    if (STORY_EDITS.some(field => field in patch)) forgetUndo(project)
    await writeProject(project)
    return sendJson(res, 200, await projectView(project))
  }

  if (req.method === 'GET' && rest === 'captions.vtt') {
    res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' })
    return res.end(await filmCaptions(project))
  }

  if (req.method === 'GET' && rest === 'events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
    res.write('event: hello\ndata: {}\n\n')
    let pending = null
    const stop = onChange(id, () => {
      pending ??= setTimeout(() => {
        pending = null
        res.write('event: changed\ndata: {}\n\n')
      }, 250)
    })
    const keepAlive = setInterval(() => res.write(': alive\n\n'), 20000)
    req.on('close', () => {
      stop()
      clearInterval(keepAlive)
      clearTimeout(pending)
    })
    return undefined
  }

  // { scope: 'breakdown' | 'layout' | 'generate' } or { targets: [...] } for one step and what it needs.
  if (req.method === 'POST' && rest === 'run') {
    const { scope, targets, provider, again, only } = await readJson(req)
    refuseWhileRunning(id)
    if (provider) {
      project.provider = provider
      await writeProject(project)
    }
    let chosen
    if (targets) {
      chosen = targets
    } else if (WORLD_STAGES[scope]) {
      // A story from before chapters existed is read afresh into them.
      if (!isWorld(project)) {
        Object.assign(project, { flow: 'chapters', chapters: [], scenes: [], cast: [] })
        await writeProject(project)
      }
      chosen = only ? [only] : WORLD_STAGES[scope]
      // Asking for something that is already written means writing it again.
      if (again) {
        if (chosen.includes('story:script')) {
          for (const scene of project.scenes) Object.assign(scene, { beats: [], props: [], carried: [], objects: [] })
          for (const anchor of anchorsOf(project)) {
            delete anchor.script
            anchor.steps = []
          }
          project.scriptsReviewed = false
          await writeProject(project)
        }
        for (const node of chosen) await resetNode(id, node)
      }
    } else if (scope === 'breakdown') {
      // What stands in the box now is what gets developed, including a project read before this step existed.
      project.premise = null
      await writeProject(project)
      chosen = ['story:plot', 'story:cast', 'story:scenes']
    } else if (scope === 'layout') {
      chosen = current => buildGraph(current).filter(node => node.kind === 'layout').map(node => node.id)
    } else {
      refuseUnlessInvalid(project)
      lookWhenFinished(project)
      await writeProject(project)
      chosen = current => generationTargets(buildGraph(current))
    }
    // Something is about to be made from the story as it stands, so there is no longer a way back to before.
    if (project.agent && (scope === 'generate' || targets?.some(target => !target.startsWith('story:')))) {
      project.agent.undo = null
      project.agent.redoPending = false
      await writeProject(project)
    }
    launch(project, chosen)
    return sendJson(res, 202, { ok: true })
  }

  // A note on the whole story. Comes back as a proposal: nothing changes until it is applied.
  if (req.method === 'POST' && rest === 'agent') {
    refuseWhileRunning(id)
    if (project.readonly) throw Object.assign(new Error('这个项目是只读的。'), { status: 403 })
    const { message, page } = await readJson(req)
    const said = String(message ?? '').trim()
    if (!said) throw Object.assign(new Error('还没有说要改什么。'), { status: 400 })
    if (!project.scenes.length && !anchorsOf(project).length) throw Object.assign(new Error('故事还没拆解，先写故事。'), { status: 400 })
    if (!publicSettings().hasKey) throw Object.assign(new Error('修改要用文本模型，先在设置里填密钥。'), { status: 400 })
    const controller = new AbortController()
    res.on('close', () => { if (!res.writableEnded) controller.abort() })
    try {
      const heard = await hearNote({ id, message: said, page, provider: readerProvider(), signal: controller.signal })
      return sendJson(res, 200, await projectView(heard.go ? await carryOut(id, heard.go.regenerate) : heard))
    } catch (error) {
      if (controller.signal.aborted) return undefined
      throw error
    }
  }

  // { regenerate: true } also starts remaking what the change left out of date, which the page has already asked about.
  if (req.method === 'POST' && rest === 'agent/apply') {
    refuseWhileRunning(id)
    const { regenerate } = await readJson(req)
    if (!project.agent?.proposal) throw Object.assign(new Error('没有等待应用的修改。'), { status: 400 })
    return sendJson(res, 200, await projectView(await carryOut(id, regenerate)))
  }

  if (req.method === 'POST' && rest === 'agent/dismiss') {
    refuseWhileRunning(id)
    return sendJson(res, 200, await projectView(await dismissProposal(id)))
  }

  if (req.method === 'POST' && rest === 'agent/undo') {
    refuseWhileRunning(id)
    return sendJson(res, 200, await projectView(await undoLast(id)))
  }

  // One sentence to the set designer. The room only changes if the whole of the change passes its checks.
  if (req.method === 'POST' && rest === 'set-chat') {
    refuseWhileRunning(id)
    if (project.readonly) throw Object.assign(new Error('这个项目是只读的。'), { status: 403 })
    const { sceneId, message, selected } = await readJson(req)
    const said = String(message ?? '').trim()
    if (!said) throw Object.assign(new Error('还没有说要改什么。'), { status: 400 })
    const scene = project.scenes.find(candidate => candidate.id === sceneId)
    if (!scene?.objects?.length) throw Object.assign(new Error('这个场景还没有白模。'), { status: 400 })
    if (!publicSettings().hasKey) throw Object.assign(new Error('和布景师聊天要用文本模型，先在设置里填密钥。'), { status: 400 })
    const controller = new AbortController()
    res.on('close', () => { if (!res.writableEnded) controller.abort() })
    let answer
    try {
      answer = await chatWithSet({ project, scene, message: said, selected, provider: readerProvider(), signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) return undefined
      answer = { failed: true, reply: `这次没改成，房间还是原样。${String(error.message).replace(/^模型连续 \d+ 轮都没给出合格的结果：/, '')}`, changed: [] }
    }
    // Read again: the page may have saved something in the time the model took.
    const latest = await readProject(id)
    const target = latest.scenes.find(candidate => candidate.id === sceneId)
    if (answer.changes) {
      target.undo = { objects: target.objects, beats: target.beats, stage: target.stage ?? null, exit: target.exit, exits: target.exits }
      Object.assign(target, { objects: answer.objects, beats: answer.beats, plainLayout: false })
      if (answer.stage) target.stage = answer.stage
      if (answer.exit && !target.exits) target.exit = answer.exit
      if (answer.exits) target.exits = answer.exits
      forgetUndo(latest)
    }
    const now = Date.now()
    target.chat = [...(target.chat ?? []), { role: 'user', text: said, at: now }, { role: 'designer', text: [answer.reply, ...(answer.notes ?? [])].join(' '), at: now, changed: answer.changed, failed: Boolean(answer.failed) }].slice(-HISTORY_KEPT)
    await writeProject(latest)
    return sendJson(res, 200, await projectView(latest))
  }

  if (req.method === 'POST' && rest === 'set-chat/undo') {
    refuseWhileRunning(id)
    const { sceneId } = await readJson(req)
    const target = project.scenes.find(candidate => candidate.id === sceneId)
    if (!target?.undo) throw Object.assign(new Error('没有可以撤销的修改。'), { status: 400 })
    Object.assign(target, { objects: target.undo.objects, beats: target.undo.beats, stage: target.undo.stage ?? undefined, exit: target.undo.exit ?? target.exit, exits: target.undo.exits ?? target.exits, undo: null })
    target.chat = [...(target.chat ?? []), { role: 'designer', text: '已撤销上一次修改。', at: Date.now(), changed: [] }].slice(-HISTORY_KEPT)
    await writeProject(project)
    return sendJson(res, 200, await projectView(project))
  }

  if (req.method === 'POST' && rest === 'cancel') return sendJson(res, 200, { ok: cancelRun(id) })

  if (req.method === 'POST' && rest === 'remove') {
    refuseWhileRunning(id)
    if (project.readonly) throw Object.assign(new Error('示例不能移除。'), { status: 403 })
    await removeFromLibrary(id)
    return sendJson(res, 200, { ok: true })
  }

  // The stamp in the address changes whenever the source does, so the browser can keep these forever.
  if (req.method === 'GET' && rest === 'thumb') {
    const query = new URL(req.url, 'http://localhost').searchParams
    const source = resolveFile(project, query.get('file') ?? '')
    if (!existsSync(source)) return res.writeHead(404).end('not found')
    const path = await thumbnail(id, source, { width: Math.min(1280, Number(query.get('w')) || 640), at: query.has('at') ? Number(query.get('at')) : null, key: query.get('key') === '1' })
    return res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' }).end(await readFile(path))
  }

  // Marks a step to be made again. For a reading step this also means what was edited by hand will be
  // replaced when it runs, which is why the page asks first.
  if (req.method === 'POST' && rest.startsWith('nodes/') && rest.endsWith('/reset')) {
    refuseWhileRunning(id)
    await resetNode(id, decodeURIComponent(rest.slice('nodes/'.length, -'/reset'.length)))
    return sendJson(res, 200, await projectView(project))
  }

  if (req.method === 'GET' && rest.startsWith('files/')) {
    const relative = decodeURIComponent(rest.slice('files/'.length))
    return sendFile(req, res, insideProject(id, relative))
  }
  res.writeHead(404).end('not found')
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost')
  if (!isFromThisPage(req)) return sendJson(res, 403, { error: '只接受来自本页面的请求。' })
  try {
    if (pathname === '/api/settings' && req.method === 'GET') return sendJson(res, 200, { ...publicSettings(), browser: browserPath() })
    if (pathname === '/api/settings' && req.method === 'POST') {
      await saveSettings(await readJson(req))
      return sendJson(res, 200, { ...publicSettings(), browser: browserPath() })
    }
    if (pathname === '/api/settings/test' && req.method === 'POST') {
      await testConnection()
      return sendJson(res, 200, { ok: true })
    }
    if (pathname === '/api/catalog' && req.method === 'GET') {
      return sendJson(res, 200, {
        archetypes: Object.fromEntries(Object.entries(ARCHETYPES).map(([id, { label, size, onTop, parts }]) => [id, { label, size, parts, onTop: Boolean(onTop) }])),
        slots: SLOTS,
        cameras: CAMERAS,
      })
    }
    if (pathname === '/api/projects' && req.method === 'GET') return sendJson(res, 200, await Promise.all((await listProjects()).map(librarySummary)))
    if (pathname === '/api/projects' && req.method === 'POST') {
      const { title, story } = await readJson(req)
      // Real generation by default when a key is there; every paid run still asks first.
      return sendJson(res, 201, await createProject({ title, story, flow: 'chapters', chapters: [], provider: publicSettings().hasKey ? 'ark' : 'mock' }))
    }
    const projectRoute = pathname.match(/^\/api\/projects\/([a-z0-9_-]+)(?:\/(.*))?$/)
    if (projectRoute) return await routeProject(req, res, projectRoute[1], projectRoute[2] ?? '')

    const playRoute = pathname.match(/^\/play\/([a-z0-9_-]+)\/([a-z0-9_-]+)\/(.*)$/)
    if (playRoute) return await servePlay(req, res, playRoute[1], playRoute[2], playRoute[3])

    if (req.method === 'GET' && pathname.startsWith('/vendor/three/')) return await sendFile(req, res, underBase(join(ROOT, 'node_modules', 'three', 'build'), pathname.slice('/vendor/three/'.length)) ?? '')
    if (req.method === 'GET' && pathname.startsWith('/vendor/fonts/')) return await sendFontFile(req, res, underBase(join(ROOT, 'node_modules', '@fontsource'), pathname.slice('/vendor/fonts/'.length)) ?? '')
    if (req.method === 'GET' && pathname.startsWith('/film/')) {
      // A read-only project's film sits with its project all the same.
      const match = pathname.match(/^\/film\/([a-z0-9_-]+)$/)
      return await sendFile(req, res, insideProject(match[1], 'film.mp4'))
    }
    if (req.method === 'GET' && pathname === '/journey.js') return await sendFile(req, res, join(ROOT, 'runtime', 'journey.js'))
    if (req.method === 'GET') return await sendFile(req, res, underBase(join(ROOT, 'studio'), pathname === '/' ? 'index.html' : pathname.slice(1)) ?? '')
    res.writeHead(405).end()
  } catch (error) {
    if (!res.headersSent) sendJson(res, error.status ?? (error.code === 'ENOENT' ? 404 : 500), { error: error.message })
    else res.end()
  }
})

const port = Number(process.env.STUDIO_PORT) || 8810
const url = `http://127.0.0.1:${port}`
setOrigin(url)
const openPage = () => { if (process.argv.includes('--open')) execFile('cmd', ['/c', 'start', '', url]) }

server.on('error', async error => {
  if (error.code !== 'EADDRINUSE') throw error
  // A port can be held by something that never answers, so this has to give up by itself.
  const ours = await fetch(`${url}/api/settings`, { signal: AbortSignal.timeout(2000) }).then(response => response.ok, () => false)
  if (!ours) {
    console.error(`端口 ${port} 被其他程序占用，请先关闭它，或用环境变量 STUDIO_PORT 换一个端口。`)
    process.exit(1)
  }
  console.log(`服务已在运行：${url}`)
  openPage()
  server.close()
})

server.listen(port, '127.0.0.1', () => {
  console.log(`whitebox-studio: ${url}`)
  if (process.argv.includes('--open')) console.log('关闭这个窗口即可停止服务。')
  openPage()
})
