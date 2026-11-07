// The production board: everything being made, as what it is called on set, and what is happening now.
import { $, api, ask, attempt, callsSentence, el, emptyState, fileUrl, fill, go, icon, locked, makingNodes, pageBar, project, readonly, resetNode, runScope, running, runTargets, state, svg, thumbUrl, toast } from './core.js'

const STATUS_TEXT = { done: '完成', running: '制作中', failed: '没有成功', ready: '待制作', stale: '需要更新', waiting: '排队中', partial: '进行中' }
const KIND_ICON = { 人物: 'user-round', 布景: 'image', 镜头: 'clapperboard', 成片: 'film' }
const METRIC_NAMES = { 对齐分数: '和白模的吻合度', 切入差: '切入时的画面差', 切出差: '切出时的画面差', 轮廓重合: '轮廓重合度', 循环接缝: '走路循环的接缝', 步伐循环帧数: '走路循环帧数' }

const statusOf = id => state.view.statuses[id]
const recordOf = id => state.view.records[id]

function cardStatus(card) {
  if (!card.steps.length) return 'done'
  const list = card.steps.map(statusOf)
  if (list.includes('running')) return 'running'
  if (list.includes('failed')) return 'failed'
  if (list.every(status => status === 'done')) return 'done'
  if (list.includes('stale')) return 'stale'
  if (list.includes('done')) return 'partial'
  return list.includes('ready') ? 'ready' : 'waiting'
}

function cardHero(card) {
  if (!card.heroNode && !card.steps.length) return { file: card.hero, stamp: 0 }
  const ready = id => ['done', 'stale'].includes(statusOf(id))
  if (ready(card.heroNode)) return { file: card.hero, stamp: recordOf(card.heroNode)?.finishedAt ?? 0 }
  if (card.fallback && ready(card.fallbackNode)) return { file: card.fallback, stamp: recordOf(card.fallbackNode)?.finishedAt ?? 0, draft: true }
  return null
}

const startMaking = attempt(async () => {
  const real = project().provider === 'ark'
  if (real && !await ask('开始正式生成？', [
    `这次最多生成 ${callsSentence(state.view.plan)}，会产生模型费用。`,
    '已经做好、内容没变的不会重做。人物走路会先试一个方向，万一人物被模型拒绝或绿幕抠不干净，会在花更多钱之前停下。',
  ], '开始生成')) return
  await runScope('generate')
})

const setMode = provider => attempt(async () => {
  state.view = await api(`/api/projects/${state.projectId}`, { method: 'PUT', body: { provider } })
  updateMaking(true)
})

function ring(share, active) {
  const radius = 26
  const length = 2 * Math.PI * radius
  return svg('svg', { class: `ring ${active ? 'active' : ''}`, width: 64, height: 64, viewBox: '0 0 64 64', role: 'img', 'aria-label': `完成 ${Math.round(share * 100)}%` },
    svg('circle', { class: 'track', cx: 32, cy: 32, r: radius }),
    svg('circle', { class: 'value', cx: 32, cy: 32, r: radius, 'stroke-dasharray': length, 'stroke-dashoffset': length * (1 - share), transform: 'rotate(-90 32 32)' }),
    svg('text', { x: 32, y: 32 }, `${Math.round(share * 100)}%`))
}

function makeHead() {
  const { view } = state
  const p = project()
  const nodes = makingNodes()
  const done = nodes.filter(node => statusOf(node.id) === 'done').length
  const total = nodes.length
  const real = p.provider === 'ark'
  const invalid = p.scenes.filter(scene => !view.stages[scene.id]?.ok)
  const failed = nodes.filter(node => statusOf(node.id) === 'failed')
  const count = resource => {
    const list = nodes.filter(node => node.resource === resource)
    return [list.filter(node => statusOf(node.id) === 'done').length, list.length]
  }
  const stop = attempt(async () => {
    await api(`/api/projects/${state.projectId}/cancel`, { method: 'POST' })
    toast('正在停止。已提交的视频下次会接着取，不会重复付费。')
  })
  let title
  let note = null
  let action
  if (readonly()) {
    title = view.filmReady ? '这部示例已经全部做好了' : '素材都有了，还差合成整片'
    action = view.filmReady ? el('button', { class: 'primary', onclick: () => go('watch') }, icon('circle-play', 15), '去看成片') : el('button', { class: 'primary', disabled: running(), onclick: attempt(() => runTargets(['film'])) }, icon('film', 15), '合成整片')
  } else if (running()) {
    const now = nodes.filter(node => statusOf(node.id) === 'running').map(node => node.title)
    title = view.run.cancelling ? '正在停止……' : `正在制作：${now.slice(0, 2).join('、') || '准备中'}${now.length > 2 ? ` 等 ${now.length} 项` : ''}`
    note = real ? '可以关掉这个页面，制作不会中断。' : '预演用占位素材，不花钱。'
    action = el('button', { class: 'danger', disabled: view.run.cancelling, onclick: stop }, icon('square', 13), '停止')
  } else if (invalid.length) {
    title = '白模还有问题要先解决'
    note = invalid.map(scene => scene.title).join('、')
    action = el('button', { class: 'primary', onclick: () => go('whitebox') }, '去白模', icon('arrow-right', 15))
  } else if (failed.length) {
    title = `有 ${failed.length} 项没有成功`
    note = `${failed[0].title}：${recordOf(failed[0].id)?.error ?? ''}`
    action = el('button', { class: 'primary', onclick: startMaking }, icon('rotate-ccw', 15), '重试并继续')
  } else if (done === total) {
    title = real ? '全部做好了' : '预演走通了'
    note = real ? null : '这些是占位素材，只用来确认流程。切到正式生成，就会画真正的画面。'
    action = el('button', { class: 'primary', onclick: () => go('watch') }, icon('circle-play', 15), '去看成片')
  } else {
    title = done ? `已完成 ${Math.round((done / total) * 100)}%，继续吗？` : real ? '准备好开拍了' : '先预演一遍'
    note = real ? `这次最多生成 ${callsSentence(view.plan)}，会产生模型费用。` : '不调用模型、不花钱，用占位素材把整个流程走一遍，大约一两分钟。'
    if (view.interrupted) note = `${note} 上次有没收完的视频，这次会接着取，不会重复付费。`
    action = el('button', { class: 'primary large', onclick: startMaking }, icon('sparkles', 16), done ? '继续' : real ? '开始生成' : '开始预演')
  }
  const [imagesDone, images] = count('image')
  const [videosDone, videos] = count('video')
  const spent = nodes.reduce((sum, node) => sum + (recordOf(node.id)?.seconds ?? 0), 0)
  return [
    readonly() ? el('div', { class: 'empty-icon', style: 'margin:0' }, icon('circle-check', 24)) : ring(total ? done / total : 0, running()),
    el('div', { class: 'making-text' },
      el('h2', {}, title),
      note ? el('p', {}, note) : null,
      readonly() ? null : el('div', { class: 'making-stats' },
        el('span', {}, icon('image', 13), el('b', {}, `${imagesDone} / ${images}`), '张图'),
        el('span', {}, icon('video', 13), el('b', {}, `${videosDone} / ${videos}`), '段视频'),
        spent ? el('span', {}, icon('clock', 13), el('b', {}, spent > 90 ? `${Math.round(spent / 60)} 分钟` : `${Math.round(spent)} 秒`), '累计') : null)),
    el('div', { class: 'making-actions' },
      readonly() ? null : el('div', { class: 'segmented', role: 'group', 'aria-label': '制作方式' },
        el('button', { class: real ? '' : 'on', disabled: running(), onclick: setMode('mock'), title: '不花钱，占位素材' }, '预演'),
        el('button', { class: real ? 'on' : '', disabled: running(), onclick: setMode('ark'), title: '调用模型，会产生费用' }, '正式生成')),
      action),
  ]
}

function tile(card) {
  const { selection } = state
  const status = cardStatus(card)
  const hero = cardHero(card)
  const kind = card.section.split(' · ')[0]
  const runningStep = card.steps.find(id => statusOf(id) === 'running')
  const flag = status === 'running' ? (state.view.nodes.find(node => node.id === runningStep)?.title ?? STATUS_TEXT.running) : status === 'done' && !hero?.draft ? null : hero?.draft && status !== 'running' ? '白模' : STATUS_TEXT[status]
  const isVideo = hero?.file.endsWith('.mp4')
  return el('button', { class: `tile ${status} ${selection.card === card.id ? 'on' : ''}`, onclick: () => { selection.card = card.id; selection.node = null; updateMaking(true) } },
    el('div', { class: 'tile-media' },
      hero ? el('img', { src: thumbUrl(hero.file, { stamp: hero.stamp, key: card.keyed, width: card.keyed ? 320 : 480 }), alt: '', loading: 'lazy', class: card.keyed ? 'keyed' : '' }) : el('div', { class: 'blank' }, icon(KIND_ICON[kind] ?? 'image', 24)),
      flag ? el('span', { class: 'tile-flag' }, flag) : null,
      isVideo && !hero.draft ? el('span', { class: 'tile-play' }, icon('play', 10)) : null),
    el('div', { class: 'tile-body' }, el('b', {}, card.title), el('small', {}, card.note)))
}

function board() {
  const sections = new Map()
  for (const card of state.view.cards) {
    if (!sections.has(card.section)) sections.set(card.section, [])
    sections.get(card.section).push(card)
  }
  return el('div', { class: 'shelves' }, [...sections].map(([name, cards]) => el('section', { class: 'shelf' },
    el('div', { class: 'shelf-head' }, el('h2', {}, name), el('small', {}, `${cards.filter(card => cardStatus(card) === 'done').length} / ${cards.length}`)),
    el('div', { class: 'tiles' }, cards.map(tile)))))
}

function layoutGraph(nodes) {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const depth = new Map()
  const depthOf = node => {
    if (depth.has(node.id)) return depth.get(node.id)
    const sameLane = (node.deps ?? []).map(id => byId.get(id)).filter(dep => dep && dep.lane === node.lane)
    const value = sameLane.length ? Math.max(...sameLane.map(depthOf)) + 1 : 0
    depth.set(node.id, value)
    return value
  }
  nodes.forEach(depthOf)
  const COL = 176
  const ROW = 52
  const LANE_HEAD = 34
  const positions = new Map()
  const bands = []
  let top = 0
  for (const lane of new Set(nodes.map(node => node.lane))) {
    const rows = new Map()
    for (const node of nodes.filter(candidate => candidate.lane === lane)) {
      const column = depth.get(node.id)
      const row = rows.get(column) ?? 0
      rows.set(column, row + 1)
      positions.set(node.id, { x: 14 + column * COL, y: top + LANE_HEAD + row * ROW })
    }
    const height = LANE_HEAD + Math.max(...rows.values()) * ROW + 10
    bands.push({ lane, top, height })
    top += height
  }
  return { positions, bands, width: Math.max(...[...positions.values()].map(position => position.x)) + COL, height: top }
}

let graphScroll = { left: 0, top: 0 }

function flowGraph() {
  const { selection } = state
  const nodes = makingNodes()
  const { positions, bands, width, height } = layoutGraph(nodes)
  const byId = new Map(nodes.map(node => [node.id, node]))
  const lines = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}` })
  for (const node of nodes) {
    const to = positions.get(node.id)
    for (const id of node.deps ?? []) {
      const from = positions.get(id)
      if (!from) continue
      const cross = byId.get(id).lane !== node.lane
      const hot = selection.node === node.id || selection.node === id
      if (cross && !hot) continue
      const x1 = from.x + 156
      const y1 = from.y + 22
      const x2 = to.x
      const y2 = to.y + 22
      const bend = Math.max(24, Math.abs(x2 - x1) / 2)
      lines.append(svg('path', { d: `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`, class: `${cross ? 'cross' : ''} ${hot ? 'hot' : ''}` }))
    }
  }
  const wrap = el('div', { class: 'graph-wrap', onscroll: event => { graphScroll = { left: event.target.scrollLeft, top: event.target.scrollTop } } },
    el('div', { class: 'graph', style: `width:${width}px;height:${height}px` },
      bands.map(band => el('div', { class: 'lane', style: `top:${band.top}px;height:${band.height}px` }, el('span', { class: 'lane-name' }, band.lane))),
      lines,
      nodes.map(node => {
        const { x, y } = positions.get(node.id)
        const status = statusOf(node.id)
        return el('button', { class: `node ${status} ${selection.node === node.id ? 'on' : ''}`, style: `left:${x}px;top:${y}px`, title: node.title, onclick: () => { selection.node = node.id; selection.card = null; updateMaking(true) } },
          el('b', {}, node.title), el('small', {}, status === 'running' ? (recordOf(node.id)?.progress ?? STATUS_TEXT.running) : STATUS_TEXT[status]))
      })))
  requestAnimationFrame(() => { wrap.scrollLeft = graphScroll.left; wrap.scrollTop = graphScroll.top })
  return wrap
}

function stepDetail(node) {
  const record = recordOf(node.id) ?? {}
  const references = [...new Set([...(node.references ?? []), node.first, node.last].filter(Boolean))]
  const metrics = Object.entries(record.metrics ?? {})
  return [
    record.error ? el('div', { class: 'notice bad' }, record.error) : null,
    metrics.length ? el('dl', { class: 'kv' }, metrics.flatMap(([name, value]) => [el('dt', {}, METRIC_NAMES[name] ?? name), el('dd', {}, typeof value === 'object' ? JSON.stringify(value) : value)])) : null,
    references.length && statusOf(node.id) !== 'waiting' ? el('div', { class: 'thumb-row' }, references.map(file => el('img', { src: thumbUrl(file, { width: 200 }), alt: file.split('/').pop(), title: file.split('/').pop(), loading: 'lazy' }))) : null,
    node.prompt ? el('pre', {}, node.prompt) : null,
    record.log?.length ? el('pre', {}, record.log.map(line => `${new Date(line.at).toLocaleTimeString()}  ${line.message}`).join('\n')) : null,
  ]
}

const redo = (ids, paid) => attempt(async () => {
  if (paid && project().provider === 'ark' && !await ask('重新生成这一项？', '会再调用一次模型并产生费用。旧的结果会保留在 archive 文件夹里。用到它的后续内容如果变了，也要更新。', '重新生成')) return
  for (const id of ids) await resetNode(id)
  await runTargets(ids)
})

function closeButton() {
  return el('button', { class: 'quiet icon-only', 'aria-label': '关闭', onclick: () => { state.selection.card = null; state.selection.node = null; updateMaking(true) } }, icon('x'))
}

function cardPanel(card) {
  const status = cardStatus(card)
  const hero = cardHero(card)
  const heroNode = state.view.nodes.find(node => node.id === card.heroNode)
  const steps = card.steps.map(id => state.view.nodes.find(node => node.id === id)).filter(Boolean)
  const paid = steps.some(node => ['image', 'video'].includes(node.resource))
  const file = hero?.file
  const scene = project().scenes[0]
  const source = !file ? null : card.id === 'film' ? `/film/${state.projectId}?t=${hero.stamp}` : readonly() ? `/play/${state.projectId}/${scene.id}/assets/${file}` : fileUrl(file, hero.stamp)
  return [
    el('div', { class: 'inspector-head' }, el('div', {}, el('span', { class: 'mono-label' }, card.section), el('h2', {}, card.title)), closeButton()),
    file?.endsWith('.mp4')
      ? el('video', { class: 'preview', controls: true, preload: 'metadata', src: source })
      : hero ? el('img', { class: `preview ${card.keyed ? 'keyed' : ''}`, src: thumbUrl(file, { width: 800, stamp: hero.stamp, key: card.keyed }), alt: card.title }) : null,
    el('div', { class: 'block' },
      el('div', { class: 'row' }, el('span', { class: `chip ${status === 'done' ? 'good' : status === 'failed' ? 'bad' : status === 'running' ? 'key' : ''}` }, STATUS_TEXT[status]), el('span', { class: 'small muted' }, card.note)),
      locked() && card.id !== 'film' ? null : el('div', { class: 'row' },
        status === 'done' && heroNode ? el('button', { disabled: running(), onclick: redo([heroNode.id], paid) }, icon('refresh-cw', 14), '重新生成') : null,
        status !== 'done' && steps.length ? el('button', { class: status === 'failed' ? 'primary' : '', disabled: running(), onclick: attempt(() => runTargets(card.steps)) }, status === 'failed' ? icon('rotate-ccw', 14) : icon('sparkles', 14), status === 'failed' ? '重试' : '只做这一项') : null)),
    steps.length > 1 || steps[0]?.prompt ? el('div', { class: 'block' }, el('h3', {}, `制作步骤 ${steps.length}`),
      el('div', { class: 'substeps' }, steps.map(node => {
        const stepState = statusOf(node.id)
        return el('details', { class: 'substep', open: stepState === 'failed' },
          el('summary', {}, el('span', { class: `dot ${stepState}` }), node.title, el('span', { class: 'sub-state' }, STATUS_TEXT[stepState])),
          el('div', { class: 'sub-body' }, stepDetail(node)))
      }))) : null,
  ]
}

function nodePanel(node) {
  const status = statusOf(node.id)
  const stamp = recordOf(node.id)?.finishedAt ?? ''
  const made = (node.outputs ?? []).filter(() => ['done', 'stale'].includes(status))
  const pictures = made.filter(file => file.endsWith('.png'))
  const videos = made.filter(file => file.endsWith('.mp4'))
  return [
    el('div', { class: 'inspector-head' }, el('div', {}, el('span', { class: 'mono-label' }, node.lane), el('h2', {}, node.title)), closeButton()),
    videos.map(file => el('video', { class: 'preview', controls: true, preload: 'metadata', src: fileUrl(file, stamp) })),
    pictures.length ? el('div', { class: 'thumb-row' }, pictures.map(file => el('a', { href: fileUrl(file, stamp), target: '_blank', rel: 'noopener', title: file.split('/').pop() }, el('img', { src: thumbUrl(file, { width: 240, stamp }), alt: file.split('/').pop(), loading: 'lazy' })))) : null,
    el('div', { class: 'block' },
      el('div', { class: 'row' }, el('span', { class: `chip ${status === 'done' ? 'good' : status === 'failed' ? 'bad' : status === 'running' ? 'key' : ''}` }, STATUS_TEXT[status]), recordOf(node.id)?.seconds ? el('span', { class: 'small muted' }, `用了 ${Math.round(recordOf(node.id).seconds)} 秒`) : null),
      readonly() ? null : el('div', { class: 'row' }, status === 'done'
        ? el('button', { disabled: running(), onclick: redo([node.id], ['image', 'video'].includes(node.resource)) }, icon('refresh-cw', 14), '重做这一步')
        : el('button', { disabled: running(), onclick: attempt(() => runTargets([node.id])) }, icon('sparkles', 14), '做到这一步'))),
    el('div', { class: 'block' }, stepDetail(node)),
  ]
}

// What just happened and what is happening, newest first. Clicking one opens the thing it made.
function feedPanel() {
  const { view } = state
  const clock = time => new Date(time).toTimeString().slice(0, 5)
  const entries = makingNodes().flatMap(node => {
    const record = recordOf(node.id)
    if (statusOf(node.id) === 'running') return [{ node, at: record?.startedAt ?? Date.now(), kind: 'running', text: record?.progress }]
    if (record?.error) return [{ node, at: record.finishedAt ?? 0, kind: 'failed', text: record.error }]
    if (statusOf(node.id) === 'done' && record?.finishedAt) {
      const score = record.metrics?.对齐分数
      return [{ node, at: record.finishedAt, kind: 'done', text: typeof score === 'number' ? `和白模的吻合度 ${score}` : null }]
    }
    return []
  }).sort((a, b) => (a.kind === 'running') === (b.kind === 'running') ? b.at - a.at : a.kind === 'running' ? -1 : 1).slice(0, 40)
  const open = node => () => {
    const card = view.cards.find(candidate => candidate.steps.includes(node.id))
    state.selection.card = card?.id ?? null
    state.selection.node = card ? null : node.id
    updateMaking(true)
  }
  return el('div', { class: 'block' }, el('h3', {}, '动态'),
    entries.length ? el('div', { class: 'feed' }, entries.map(({ node, at, kind, text }) => el('button', { class: kind, onclick: open(node) },
      el('time', {}, clock(at)), el('i'), el('span', {}, el('b', {}, node.title), text ? el('small', {}, text) : null))))
      : el('p', { class: 'small muted' }, readonly() ? '这部示例的素材是之前做好的。' : '开始之后，每做好一样都会记在这里。'))
}

// Redraws only what changed: a board of pictures must not blink every time a log line arrives.
function patch(host, signature, build) {
  if (!host || host.dataset.sig === signature) return
  host.dataset.sig = signature
  fill(host, build())
}

export function updateMaking(selectionChanged = false) {
  if (!$('make-head')) return
  const { view, selection } = state
  const stateSig = JSON.stringify([view.statuses, view.run, view.plan, view.lastRunError, project().provider, view.interrupted, view.filmReady])
  const liveSig = JSON.stringify(makingNodes().filter(node => statusOf(node.id) === 'running').map(node => recordOf(node.id)?.progress))
  const pick = [selection.card, selection.node, selection.makeView]
  patch($('make-head'), stateSig, makeHead)
  patch($('make-body'), JSON.stringify([stateSig, liveSig, pick]), () => selection.makeView === 'flow' ? flowGraph() : board())
  const panel = $('make-panel')
  const card = view.cards.find(candidate => candidate.id === selection.card)
  const node = view.nodes.find(candidate => candidate.id === selection.node)
  const steps = card?.steps ?? (node ? [node.id] : [])
  const detailSig = JSON.stringify([pick, steps.map(id => [statusOf(id), recordOf(id)?.finishedAt, recordOf(id)?.error, recordOf(id)?.log?.length]), running(), card || node ? null : stateSig, card || node ? null : liveSig])
  if (selectionChanged) panel.dataset.sig = ''
  // A preview being watched is left alone until the selection itself changes.
  const playing = panel.querySelector('video') && !panel.querySelector('video').paused
  if (!playing || selectionChanged) patch(panel, detailSig, () => card ? cardPanel(card) : node ? nodePanel(node) : feedPanel())
  const switcher = $('make-view')
  if (switcher) for (const button of switcher.children) button.classList.toggle('on', button.dataset.view === selection.makeView)
}

export function renderGenerate() {
  const { view, selection } = state
  const p = project()
  if (!view.cards.length) return [pageBar({ title: '生成' }), el('div', { class: 'work-main' }, emptyState('sparkles', '还不能开始', '先把白模搭好，这里才有东西可做。', el('button', { class: 'primary', onclick: () => go('whitebox') }, '去白模')))]
  const setView = name => () => { selection.makeView = name; selection.card = null; selection.node = null; updateMaking(true) }
  queueMicrotask(() => updateMaking(true))
  return [
    pageBar({ title: '生成', note: '人物、布景、镜头，做好一样亮一样。只有内容变了的部分才会重做。', actions: [
      p.readonly ? null : el('div', { class: 'segmented', id: 'make-view', role: 'group', 'aria-label': '视图' },
        el('button', { 'data-view': 'gallery', onclick: setView('gallery') }, icon('layout-grid', 13), '成果'),
        el('button', { 'data-view': 'flow', onclick: setView('flow') }, icon('workflow', 13), '流程图')),
    ] }),
    el('div', { class: 'workspace' },
      el('div', { class: 'work-main' },
        el('section', { class: 'making-head', id: 'make-head' }),
        el('div', { id: 'make-body' })),
      el('aside', { class: 'inspector', id: 'make-panel' })),
  ]
}
