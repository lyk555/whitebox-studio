// The shell: which page is open, the pipeline down the side, and keeping up with the server.
import { $, api, attempt, el, fill, flushSave, freshSelection, go, hooks, icon, makingNodes, project, readonly, locked, running, scenePoster, state, thumbUrl, toast } from './core.js'
import { agentAvailable, agentPanel, agentWaiting, toggleAgent, updateAgent } from './agent.js'
import { renderLibrary } from './library.js'
import { renderCast, renderScenes, renderStory } from './writing.js'
import { renderWhitebox } from './whitebox.js'
import { renderGenerate, updateMaking } from './making.js'
import { renderPlay, renderWatch, stopPlayWatch } from './screening.js'
import { isWorldProject, renderChapters, renderMap } from './world.js'

const STAGES = [
  { id: 'story', name: '故事', icon: 'feather' },
  { id: 'cast', name: '人物', icon: 'users-round' },
  { id: 'scenes', name: '场景', icon: 'route' },
  { id: 'whitebox', name: '白模', icon: 'box' },
  { id: 'generate', name: '生成', icon: 'sparkles' },
  { id: 'play', name: '互动', icon: 'gamepad-2' },
  { id: 'watch', name: '观看', icon: 'circle-play' },
]
const WORLD_STAGES = [
  STAGES[0],
  { id: 'chapters', name: '章节', icon: 'book-open' },
  STAGES[1],
  { id: 'scenes', name: '地点图', icon: 'map' },
  ...STAGES.slice(3),
]
const stagesNow = () => (isWorldProject() ? WORLD_STAGES : STAGES)
const PAGES = { story: renderStory, chapters: renderChapters, cast: renderCast, scenes: () => (isWorldProject() ? renderMap() : renderScenes()), whitebox: renderWhitebox, generate: renderGenerate, play: renderPlay, watch: renderWatch }
const SCREENING = new Set(['play', 'watch'])

let events = null
let wasRunning = false

// What each link in the pipeline has to say for itself.
function stageState(id) {
  const { view } = state
  const p = project()
  const { statuses } = view
  const made = makingNodes()
  const done = made.filter(node => statuses[node.id] === 'done').length
  const failed = made.filter(node => statuses[node.id] === 'failed').length
  const busy = kind => view.nodes.some(node => node.kind === kind && statuses[node.id] === 'running')
  const beats = p.scenes.reduce((sum, scene) => sum + (scene.beats?.length ?? 0), 0)
  switch (id) {
    case 'story': return { done: Boolean(p.story.trim()), note: p.story.trim() ? `${p.story.length} 字` : '写下故事' }
    case 'chapters': return busy('outline') ? { active: true, note: '正在定章节和锚点' } : { done: (p.chapters?.length ?? 0) > 0, note: p.chapters?.length ? `${p.chapters.length} 章 · ${p.chapters.reduce((sum, chapter) => sum + chapter.anchors.length, 0)} 个锚点` : '等故事' }
    case 'cast': return busy('cast') ? { active: true, note: '正在拆人物' } : { done: p.cast.length > 0, note: p.cast.length ? `${p.cast.slice(0, 2).map(person => person.name).join('、')}${p.cast.length > 2 ? ` 等 ${p.cast.length} 人` : ''}` : isWorldProject() ? '等章节' : '等故事' }
    case 'scenes':
      if (isWorldProject()) {
        if (busy('world')) return { active: true, note: '正在设计地点图' }
        if (busy('script')) return { active: true, note: '正在写每个锚点的戏' }
        return { done: beats > 0, problem: (view.worldProblems?.length ?? 0) > 0, note: p.scenes.length ? `${p.scenes.length} 个地方 · ${beats} 步` : '等人物' }
      }
      return busy('scenes') ? { active: true, note: '正在拆场景' } : { done: p.scenes.length > 0, note: p.scenes.length ? `${p.scenes.length} 场 · ${beats} 步` : '等人物' }
    case 'whitebox':
      if (busy('layout')) return { active: true, note: '正在布景' }
      if (p.readonly) return { done: true, note: '检查通过' }
      if (!p.scenes.length || p.scenes.some(scene => !scene.objects?.length)) return { note: p.scenes.length ? '还没搭' : '等场景' }
      return p.scenes.every(scene => view.stages[scene.id]?.ok) ? { done: true, note: '检查通过' } : { problem: true, note: '有问题要解决' }
    case 'generate': {
      if (p.readonly) return { done: true, note: '素材齐了' }
      if (!made.length) return { note: '等白模' }
      const isBusy = made.some(node => statuses[node.id] === 'running')
      const share = done / made.length
      return { done: done === made.length, active: isBusy, problem: failed > 0 && !isBusy, note: failed && !isBusy ? `${failed} 项没成功` : `${Math.round(share * 100)}%`, meter: done < made.length ? share : null }
    }
    case 'play': return { done: p.readonly || (made.length > 0 && done === made.length), note: p.readonly || (made.length && done === made.length) ? '可以玩了' : p.scenes.some(scene => scene.objects?.length) ? '可以试走白模' : '等白模' }
    case 'watch': return { done: view.filmReady, note: view.filmReady ? '成片已好' : '等成片' }
    default: return {}
  }
}

function renderSide() {
  const side = $('side')
  if (!side || !project()) return
  if (document.activeElement?.classList.contains('title-input')) return // Not swept away while being typed.
  const p = project()
  const poster = p.scenes[0] ? scenePoster(p.scenes[0]) : null
  const scroll = side.querySelector('.pipeline')?.scrollTop ?? 0
  fill(side,
    el('div', { class: 'side-top' },
      el('button', { class: 'back', onclick: () => { location.hash = '#/' } }, icon('arrow-left', 14), el('span', {}, '全部作品')),
      el('div', { class: 'side-cover' }, poster ? el('img', { src: thumbUrl(poster.file, { width: 480, stamp: poster.stamp ?? '' }), alt: '' }) : null),
      el('input', { class: 'title-input', 'aria-label': '片名', value: p.title, readOnly: locked(), onchange: attempt(async event => { state.view = await api(`/api/projects/${state.projectId}`, { method: 'PUT', body: { title: event.target.value } }) }) })),
    el('nav', { class: 'pipeline', 'aria-label': '制作流程' }, stagesNow().map(item => {
      const info = stageState(item.id)
      const classes = ['stage-link', item.id === state.stage && 'on', info.done && 'done', info.active && 'active', info.problem && 'problem'].filter(Boolean).join(' ')
      return el('button', { class: classes, title: `${item.name}：${info.note ?? ''}`, onclick: () => go(item.id), 'aria-current': item.id === state.stage ? 'step' : null },
        el('span', { class: 'stage-mark' }, info.active ? icon('loader-circle', 14) : info.done ? icon('check', 14) : info.problem ? icon('triangle-alert', 13) : icon(item.icon, 14)),
        el('span', { class: 'stage-text' }, el('b', {}, item.name), el('small', {}, info.note ?? ''),
          info.meter !== null && info.meter !== undefined ? el('span', { class: 'stage-meter' }, el('i', { style: `width:${info.meter * 100}%` })) : null))
    })),
    agentAvailable() ? el('div', { class: 'side-agent' }, el('button', { class: `agent-toggle ${state.selection.agentOpen ? 'on' : ''}`, 'aria-expanded': String(Boolean(state.selection.agentOpen)), 'aria-label': '修改意见', title: '修改意见', onclick: () => toggleAgent() },
      icon('message-square-quote', 15), el('span', {}, '修改意见'), agentWaiting() ? el('i', { class: 'agent-dot', title: '有修改等你确认' }) : null)) : null,
    el('div', { class: 'side-foot' },
      el('small', {}, readonly() ? '示例作品，只读' : p.provider === 'ark' ? '正式生成' : '预演模式'),
      el('button', { class: 'quiet icon-only', 'aria-label': '模型设置', title: '模型设置', onclick: hooks.openSettings }, icon('settings', 16))),
  )
  side.querySelector('.pipeline').scrollTop = scroll
  side.querySelector('.stage-link.active svg')?.classList.add('spin')
}

function renderPage() {
  const area = $('work-area')
  if (!area) return
  stopPlayWatch()
  document.documentElement.dataset.room = SCREENING.has(state.stage) ? 'screening' : 'workshop'
  fill(area, PAGES[state.stage]())
}

// A page with a form or a live game is not redrawn under someone using it. It catches up the moment
// the run it was waiting on ends.
function onViewChanged() {
  const { view, stage } = state
  const justFinished = wasRunning && !running()
  const started = !wasRunning && running()
  wasRunning = running()
  renderSide()
  updateAgent()
  if (stage === 'generate') {
    if (!$('make-head') && view.cards.length) renderPage()
    else updateMaking()
  } else if (['story', 'chapters', 'cast', 'scenes', 'whitebox', 'watch'].includes(stage)) {
    if (justFinished || started) renderPage()
    else {
      const line = $('work-area')?.querySelector('[data-reading]')
      const busy = view.nodes.find(node => node.group === 'authoring' && view.statuses[node.id] === 'running')
      if (line && busy) line.textContent = `${busy.title}…… ${view.records[busy.id]?.progress ?? ''}`
    }
  }
  if (justFinished) {
    const failed = view.nodes.find(node => view.statuses[node.id] === 'failed')
    if (failed) toast(`${failed.title}没有成功：${view.records[failed.id]?.error ?? ''}`, true)
    else if (isWorldProject()) {
      // Each stage ends where what it made can be looked at.
      if (stage === 'story' && project().chapters?.length) go('chapters')
      else if (stage === 'chapters' && project().scenes.length) go('cast')
    } else if (stage === 'story' && project().cast.length) go('cast')
  }
}

async function refresh() {
  if (!state.projectId) return
  state.view = await api(`/api/projects/${state.projectId}`)
  onViewChanged()
}

function listen() {
  events?.close()
  events = new EventSource(`/api/projects/${state.projectId}/events`)
  events.addEventListener('changed', () => refresh().catch(() => {}))
  // A reconnect means something may have been missed, for example the server restarting.
  events.addEventListener('hello', () => refresh().catch(() => {}))
}

function drawShell() {
  fill($('app'), el('div', { class: `shell ${state.selection.agentOpen ? 'agent-open' : ''}` }, el('aside', { class: 'side', id: 'side' }), el('div', { class: 'work-area', id: 'work-area' }), readonly() ? null : agentPanel()))
}

async function route() {
  await flushSave().catch(error => toast(error.message, true))
  const [, id, next] = location.hash.split('/')
  if (!id) {
    events?.close()
    events = null
    stopPlayWatch()
    Object.assign(state, { projectId: null, view: null, stage: null })
    document.documentElement.dataset.room = 'workshop'
    await renderLibrary()
    return
  }
  if (id !== state.projectId) {
    state.projectId = id
    state.selection = freshSelection()
    try {
      state.view = await api(`/api/projects/${id}`)
    } catch (error) {
      toast(error.message, true)
      state.projectId = null
      location.hash = '#/'
      return
    }
    wasRunning = running()
    listen()
    drawShell()
  } else if (!$('side')) {
    drawShell()
  }
  state.stage = stagesNow().some(item => item.id === next) ? next : 'story'
  renderSide()
  renderPage()
  updateAgent(true)
}

hooks.renderPage = renderPage
hooks.renderChrome = renderSide
hooks.refresh = refresh
hooks.openSettings = openSettings

addEventListener('hashchange', () => { route().catch(error => toast(error.message, true)) })
addEventListener('keydown', event => {
  if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return
  if (state.stage === 'generate' && (state.selection.card || state.selection.node)) {
    state.selection.card = null
    state.selection.node = null
    updateMaking(true)
  }
})

// ---------------------------------------------------------------- settings
const settingsFields = () => ({ apiKey: $('s-key').value, baseURL: $('s-base').value, textModel: $('s-text').value, imageModel: $('s-image').value, videoModel: $('s-video').value })

function applySettings(settings) {
  $('s-key').value = ''
  $('s-key').placeholder = settings.hasKey ? '已保存，留空则保持不变' : '在这里粘贴密钥'
  $('s-base').value = settings.baseURL
  $('s-text').value = settings.textModel
  $('s-image').value = settings.imageModel
  $('s-video').value = settings.videoModel
}

function settingsResult(message, tone = '') {
  $('s-result').textContent = message
  $('s-result').className = tone
}

async function openSettings() {
  settingsResult('')
  applySettings(await api('/api/settings'))
  $('settings').showModal()
}

$('s-close').addEventListener('click', () => $('settings').close())
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault()
  try {
    applySettings(await api('/api/settings', { method: 'POST', body: settingsFields() }))
    settingsResult('已保存，立即生效。', 'good')
    if (state.projectId) await refresh()
  } catch (error) {
    settingsResult(error.message, 'bad')
  }
})
$('s-test').addEventListener('click', async () => {
  if (!$('settings-form').reportValidity()) return
  $('s-test').disabled = true
  settingsResult('正在测试……')
  try {
    applySettings(await api('/api/settings', { method: 'POST', body: settingsFields() }))
    await api('/api/settings/test', { method: 'POST' })
    settingsResult('连接成功。这一步不产生生成费用。', 'good')
  } catch (error) {
    settingsResult(`连接失败：${error.message}`, 'bad')
  } finally {
    $('s-test').disabled = false
  }
})

state.catalog = await api('/api/catalog')
await route()
