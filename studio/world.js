// The two pages a story with chapters is written on: its chapters and anchors, and the map of where they happen.
import { ask, attempt, el, emptyState, field, go, hooks, icon, locked, nextButton, pageBar, project, readingBanner, readonly, runScope, saveSoon, scenePoster, state, svg, thumbUrl } from './core.js'

const statusOf = id => state.view.statuses[id]
const isReading = () => state.view.nodes.some(node => node.group === 'authoring' && statusOf(node.id) === 'running')
export const isWorldProject = () => project()?.flow === 'chapters'
const chapters = () => project().chapters ?? []
const allAnchors = () => chapters().flatMap(chapter => chapter.anchors)
const beatAt = ({ scene, beat }) => project().scenes.find(candidate => candidate.id === scene)?.beats.find(candidate => candidate.id === beat)
const sceneTitle = id => project().scenes.find(scene => scene.id === id)?.title ?? id
const anchorTitle = id => allAnchors().find(anchor => anchor.id === id)?.title ?? id

const again = (scope, title, body, yes, only) => attempt(async () => {
  if (!await ask(title, body, yes)) return
  await runScope(scope, { again: true, ...(only ? { only } : {}) })
})

function problemsBanner() {
  const problems = state.view.worldProblems ?? []
  return problems.length ? el('div', { class: 'notice bad' }, icon('circle-alert'), el('div', {}, el('b', {}, '这个故事现在还走不通，可以告诉 Agent 怎么改：'), problems.slice(0, 5).map(problem => el('div', {}, problem)))) : null
}

// ---------------------------------------------------------------- chapters and anchors
// Anchors in columns by what they wait for, so what can be taken in any order stands side by side.
function columnsOf(chapter) {
  const depth = new Map()
  const depthOf = anchor => {
    if (depth.has(anchor.id)) return depth.get(anchor.id)
    const before = (anchor.needs ?? []).map(id => chapter.anchors.find(other => other.id === id)).filter(Boolean)
    const value = before.length ? Math.max(...before.map(depthOf)) + 1 : 0
    depth.set(anchor.id, value)
    return value
  }
  const columns = []
  for (const anchor of chapter.anchors) (columns[depthOf(anchor)] ??= []).push(anchor)
  return columns.filter(Boolean)
}

function anchorCard(anchor) {
  const { selection } = state
  const places = [...new Set((anchor.steps ?? []).map(step => step.scene).concat(anchor.steps?.length ? [] : anchor.where ?? []))].map(sceneTitle)
  return el('button', { class: `anchor-card ${selection.anchor === anchor.id ? 'on' : ''}`, onclick: () => { selection.anchor = anchor.id; hooks.renderPage() } },
    el('b', {}, anchor.title),
    el('p', {}, anchor.happens),
    el('small', {},
      places.length ? [icon('map-pin', 12), places.join('、')] : null,
      anchor.steps?.length ? [icon('footprints', 12), `${anchor.steps.length} 步`] : null,
      anchor.script && anchor.landed === false ? el('span', { class: 'chip bad', title: anchor.whyNot }, '观众没被带到') : null))
}

function anchorInspector(anchor, close) {
  const change = () => saveSoon({ chapters: project().chapters })
  const bind = key => value => { anchor[key] = value; change() }
  return el('div', { class: 'block' },
    el('div', { class: 'inspector-head' }, el('div', {}, el('span', { class: 'mono-label' }, '锚点'), el('h2', {}, anchor.title)), el('button', { class: 'quiet icon-only', 'aria-label': '关闭', onclick: close }, icon('x'))),
    el('div', { class: 'form' },
      field('名字', anchor.title, bind('title')),
      field('之前以为', anchor.before, bind('before'), { multiline: true, rows: 2 }),
      field('这一刻发生', anchor.happens, bind('happens'), { multiline: true, rows: 3 }),
      field('之后以为', anchor.after, bind('after'), { multiline: true, rows: 2 })),
    anchor.steps?.length ? el('div', { class: 'block' }, el('h3', {}, '拍成这几步'), el('ol', { class: 'step-list' }, anchor.steps.map(step => {
      const beat = beatAt(step)
      return beat ? el('li', {}, el('b', {}, beat.objective), el('small', {}, `${sceneTitle(step.scene)} · ${beat.objectName}`)) : null
    }))) : null,
    anchor.script ? el('details', { class: 'block' }, el('summary', {}, '这一段的剧本'), el('pre', { class: 'script-text' }, anchor.script)) : null,
    anchor.viewer ? el('details', { class: 'block' }, el('summary', {}, '第一次看的观众怎么说'), el('p', { class: 'small' }, anchor.viewer)) : null)
}

export function renderChapters() {
  const p = project()
  if (!chapters().length) {
    return [pageBar({ title: '章节' }), el('div', { class: 'work-main' }, readingBanner(),
      isReading() ? null : emptyState('book-open', '还没有章节', '写好故事或梗概，模型会先把它分成章节，定下每章的剧情锚点。', el('button', { class: 'primary', onclick: () => go('story') }, '去写故事')))]
  }
  const { selection } = state
  const selected = allAnchors().find(anchor => anchor.id === selection.anchor)
  const peopleDone = statusOf('story:world') === 'done' && p.scenes.length > 0
  const change = () => saveSoon({ chapters: p.chapters })
  return [
    pageBar({
      title: '章节', note: '每章有几个剧情锚点，是观众亲身经历的转折。排在同一列的不分先后，玩家可以自己选。',
      actions: [
        locked() ? null : el('button', { onclick: again('outline', '重新定章节和锚点？', '章节、锚点，以及之后的地点图和剧本都会换成新的结果。已经生成的画面不会被删除。', '重新生成') }, '重新生成'),
        peopleDone ? nextButton('下一步：人物', 'cast') : locked() ? null : el('button', { class: 'primary', onclick: attempt(() => runScope('people')) }, '下一步：定人物和地点', icon('arrow-right', 15)),
      ],
    }),
    el('div', { class: 'workspace' },
      el('div', { class: 'work-main' },
        readingBanner(),
        p.truth ? el('details', { class: 'truth' }, el('summary', {}, '真相（观众看不到）'), el('p', { class: 'quote' }, p.truth)) : null,
        el('div', { class: 'chapter-list' }, chapters().map((chapter, index) => el('section', { class: 'chapter-block' },
          el('header', {}, el('span', { class: 'mono-label' }, `第 ${index + 1} 章`), el('h2', {}, chapter.title), chapter.summary ? el('p', {}, chapter.summary) : null),
          el('div', { class: 'anchor-flow' }, columnsOf(chapter).map((column, order) => [
            order ? el('i', { class: 'anchor-arrow' }, icon('arrow-right', 15)) : null,
            el('div', { class: 'anchor-column' }, column.map(anchorCard)),
          ])))))),
      el('aside', { class: 'inspector' },
        selected ? anchorInspector(selected, () => { selection.anchor = null; hooks.renderPage() }) : el('div', { class: 'block' },
          el('h3', {}, '这个故事'),
          el('dl', { class: 'kv' }, el('dt', {}, '章节'), el('dd', {}, chapters().length), el('dt', {}, '锚点'), el('dd', {}, allAnchors().length)),
          el('p', { class: 'small muted' }, '点一个锚点就能改。想改得多，打开左下角的修改意见，直接说。'),
          chapters().map(chapter => el('label', { class: 'field' }, el('span', {}, chapter.title), el('textarea', { rows: 2, value: chapter.summary ?? '', disabled: locked(), oninput: event => { chapter.summary = event.target.value; change() } })))))),
  ]
}

// ---------------------------------------------------------------- the map
const NODE = { width: 168, height: 54, across: 300, down: 92, margin: 24, titleLength: 11 }
// Beside the game there is room for the map only one way, so there it runs down the page, and small enough to read at its real size.
const SMALL_NODE = { width: 122, height: 36, across: 58, down: 132, margin: 4, titleLength: 7 }

// Each place in a column by how many steps it is from the start, so the drawing reads the way the player goes.
function layoutOf(places, start, compact) {
  const size = compact ? SMALL_NODE : NODE
  const ids = Object.keys(places)
  const depth = new Map(places[start] ? [[start, 0]] : [])
  const queue = places[start] ? [start] : []
  while (queue.length) {
    const here = queue.shift()
    for (const exit of places[here].exits) {
      if (depth.has(exit.to) || !places[exit.to]) continue
      depth.set(exit.to, depth.get(here) + 1)
      queue.push(exit.to)
    }
  }
  const deepest = Math.max(0, ...depth.values())
  const rows = new Map()
  const spots = {}
  for (const id of ids) {
    const column = depth.get(id) ?? deepest + 1
    const row = rows.get(column) ?? 0
    rows.set(column, row + 1)
    spots[id] = compact ? { x: size.margin + row * size.down, y: size.margin + column * size.across } : { x: size.margin + column * size.across, y: size.margin + row * size.down }
  }
  const all = Object.values(spots)
  return { spots, size, width: size.margin + size.width + Math.max(0, ...all.map(spot => spot.x)), height: size.margin + size.height + Math.max(0, ...all.map(spot => spot.y)) }
}

const fitTitle = (title, length) => (title.length > length ? `${title.slice(0, length - 1)}…` : title)
const anchorTitleIn = (plan, id) => plan.chapters.flatMap(chapter => chapter.anchors).find(anchor => anchor.id === id)?.title ?? id

// The same drawing wherever the map is shown. What is open comes from whoever is asking.
export function mapDiagram(plan, { current = null, selected = null, onPick = null, isOpen = () => true, compact = false } = {}) {
  const { spots, size, width, height } = layoutOf(plan.places, plan.start, compact)
  const root = svg('svg', { class: `map-diagram ${compact ? 'compact' : ''}`, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `地点图，${Object.keys(plan.places).length} 个地方`, style: `max-width:${width}px` })
  const defs = svg('defs', {}, svg('marker', { id: 'map-arrow', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto' }, svg('path', { d: 'M0 0 L8 4 L0 8 z', class: 'map-arrow' })))
  root.append(defs)
  const middle = id => [spots[id].x + size.width / 2, spots[id].y + size.height / 2]
  const drawn = new Set()
  for (const [id, place] of Object.entries(plan.places)) {
    for (const exit of place.exits) {
      if (!spots[exit.to]) continue
      const pair = [id, exit.to].sort().join()
      if (drawn.has(pair)) continue
      drawn.add(pair)
      const back = plan.places[exit.to].exits.find(other => other.to === id)
      const [x1, y1] = middle(id)
      const [x2, y2] = middle(exit.to)
      const shut = !isOpen(exit)
      root.append(svg('line', { class: `map-edge ${exit.opensAfter ? 'later' : ''} ${shut ? 'shut' : ''}`, x1, y1, x2, y2, ...(back ? {} : { 'marker-end': 'url(#map-arrow)' }) }))
      if (exit.opensAfter && !compact) root.append(svg('text', { class: 'map-edge-label', x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 7 }, `等“${fitTitle(anchorTitleIn(plan, exit.opensAfter), 8)}”`))
    }
  }
  for (const [id, place] of Object.entries(plan.places)) {
    const { x, y } = spots[id]
    const node = svg('g', { class: `map-node ${id === current ? 'here' : ''} ${id === selected ? 'on' : ''} ${id === plan.start ? 'start' : ''} ${onPick ? 'can-pick' : ''}`, transform: `translate(${x} ${y})`, ...(onPick ? { role: 'button', tabindex: 0, 'aria-label': place.title, onclick: () => onPick(id), onkeydown: event => { if (event.key === 'Enter' || event.key === ' ') onPick(id) } } : {}) },
      svg('title', {}, place.title),
      svg('rect', { width: size.width, height: size.height, rx: compact ? 7 : 9 }),
      svg('text', { x: size.width / 2, y: id === plan.start && !compact ? 23 : size.height / 2 + 5 }, fitTitle(place.title, size.titleLength)),
      id === plan.start && !compact ? svg('text', { class: 'map-node-note', x: size.width / 2, y: 41 }, '起点') : null)
    root.append(node)
  }
  return root
}

function placeInspector(scene, close) {
  const change = () => saveSoon({ scenes: project().scenes })
  const bind = (object, key) => value => { object[key] = value; change() }
  return el('div', { class: 'block' },
    el('div', { class: 'inspector-head' }, el('div', {}, el('span', { class: 'mono-label' }, '地点'), el('h2', {}, scene.title)), el('button', { class: 'quiet icon-only', 'aria-label': '关闭', onclick: close }, icon('x'))),
    el('div', { class: 'form' },
      field('名字', scene.title, bind(scene, 'title')),
      field('这个地方', scene.place, bind(scene, 'place'), { multiline: true, hint: '写清墙面和地面的颜色与材质。' }),
      field('四周', scene.edges, bind(scene, 'edges'), { multiline: true, rows: 2 }),
      field('光线和色调', scene.mood, bind(scene, 'mood'), { multiline: true, rows: 2 }),
      field('第一次来时的旁白', scene.openingLine, bind(scene, 'openingLine'), { multiline: true, rows: 2 }),
      field('第一次来时的开场视频', scene.film.opening.action, bind(scene.film.opening, 'action'), { multiline: true, rows: 3 })))
}

function beatInspector(scene, beat, close) {
  const change = () => saveSoon({ scenes: project().scenes })
  const bind = key => value => { beat[key] = value; change() }
  return el('div', { class: 'block' },
    el('div', { class: 'inspector-head' }, el('div', {}, el('span', { class: 'mono-label' }, beat.endsChapter ? '这一章在这里结束' : '这一步是电影镜头'), el('h2', {}, beat.objective)), el('button', { class: 'quiet icon-only', 'aria-label': '关闭', onclick: close }, icon('x'))),
    el('div', { class: 'form' },
      field('屏幕上的目标', beat.objective, bind('objective')),
      field('按键提示', beat.prompt, bind('prompt')),
      field('进行时的旁白', beat.during, bind('during'), { multiline: true, rows: 2 }),
      field('完成后的旁白', beat.after, bind('after'), { multiline: true, rows: 2 }),
      field('还没轮到时的一句话', beat.tooEarly, bind('tooEarly')),
      field('镜头内容', beat.action, bind('action'), { multiline: true, rows: 4, hint: '全程不露脸，只有背影、肩膀和手。这样才能和游戏画面无缝衔接。' }),
      field('露脸镜头', beat.face, bind('face'), { multiline: true, rows: 2, placeholder: '可以不写' }),
      field('台词', (beat.lines ?? []).map(line => `${line.who}：${line.says}`).join('\n'), value => {
        const lines = value.split('\n').map(text => text.match(/^\s*([^：:]+)[：:]\s*(.+?)\s*$/)).filter(Boolean).map(([, who, says]) => ({ who: who.trim(), says }))
        if (lines.length) beat.lines = lines
        else delete beat.lines
        change()
      }, { multiline: true, rows: 3, placeholder: '谁：说什么，一行一句。写在露脸镜头里才会说出来', hint: '一个镜头最多 12 秒，大约 45 个字。' }),
      field('声音', beat.sound, bind('sound'), { multiline: true, rows: 2 })))
}

function exitInspector(scene, exit, close) {
  const change = () => saveSoon({ scenes: project().scenes })
  const bind = key => value => { exit[key] = value; change() }
  return el('div', { class: 'block' },
    el('div', { class: 'inspector-head' }, el('div', {}, el('span', { class: 'mono-label' }, `通向${sceneTitle(exit.to)}`), el('h2', {}, exit.name)), el('button', { class: 'quiet icon-only', 'aria-label': '关闭', onclick: close }, icon('x'))),
    el('div', { class: 'form' },
      field('叫什么', exit.name, bind('name')),
      field('走过去之后看到什么', exit.beyond, bind('beyond'), { multiline: true, rows: 2 }),
      field('按键提示', exit.prompt, bind('prompt')),
      exit.opensAfter ? field('还不通时的一句话', exit.locked, bind('locked')) : null),
    el('p', { class: 'small muted' }, exit.opensAfter ? `要等“${anchorTitle(exit.opensAfter)}”之后才通。` : '一开始就通。', '要加路、去路或者改它什么时候通，告诉 Agent。'))
}

function placeDetails(scene) {
  const { selection } = state
  const pick = key => { selection.mapNode = key; hooks.renderPage() }
  const poster = scenePoster(scene)
  const here = allAnchors().flatMap(anchor => {
    const steps = (anchor.steps ?? []).filter(step => step.scene === scene.id)
    return steps.length ? [{ anchor, steps }] : []
  })
  return el('section', { class: 'place-details' },
    el('button', { class: `act-head ${selection.mapNode === `${scene.id}:place` ? 'on' : ''}`, onclick: () => pick(`${scene.id}:place`) },
      el('div', { class: 'act-poster' }, poster ? el('img', { src: thumbUrl(poster.file, { width: 400, stamp: poster.stamp ?? '' }), alt: '' }) : '还没有白模'),
      el('div', { class: 'act-text' }, el('span', { class: 'mono-label' }, scene.stage?.kind === 'outdoor' ? '室外' : '室内'), el('b', {}, scene.title), el('p', {}, scene.place))),
    el('div', { class: 'block' }, el('h3', {}, '从这里能去'),
      el('div', { class: 'way-list' }, (scene.exits ?? []).map(exit => el('button', { class: `way ${selection.mapNode === `${scene.id}:exit:${exit.id}` ? 'on' : ''}`, onclick: () => pick(`${scene.id}:exit:${exit.id}`) },
        icon('door-open', 14), el('b', {}, exit.name), el('small', {}, `去${sceneTitle(exit.to)}${exit.opensAfter ? ` · 等“${anchorTitle(exit.opensAfter)}”之后才通` : ''}`))))),
    el('div', { class: 'block' }, el('h3', {}, '在这里发生的事'),
      here.length ? here.map(({ anchor, steps }) => el('div', { class: 'here-anchor' },
        el('small', {}, `锚点：${anchor.title}`),
        el('div', { class: 'board' }, steps.map(step => {
          const beat = beatAt(step)
          return beat ? el('button', { class: `frame ${selection.mapNode === `${scene.id}:${beat.id}` ? 'on' : ''}`, onclick: () => pick(`${scene.id}:${beat.id}`) },
            el('span', { class: 'frame-top' }, beat.endsChapter ? '章末' : '一步', el('span', { class: 'frame-type shot' }, icon('clapperboard', 12), '镜头')),
            el('b', {}, beat.objective),
            beat.during || beat.after ? el('q', {}, beat.during || beat.after) : null,
            el('small', {}, icon('map-pin', 12), beat.objectName)) : null
        })))) : el('p', { class: 'small muted' }, statusOf('story:script') === 'done' ? '这里是路过的地方，没有戏。' : '等写完每个锚点的戏，这里会列出玩家在这里做的事。')))
}

export function renderMap() {
  const p = project()
  if (!p.scenes.length) {
    return [pageBar({ title: '地点图' }), el('div', { class: 'work-main' }, readingBanner(),
      isReading() ? null : emptyState('map', '还没有地点图', '定好章节和人物后，模型会设计有哪些地方、它们怎么连起来。', el('button', { class: 'primary', onclick: () => go('chapters') }, '去看章节')))]
  }
  const { selection } = state
  if (!p.scenes.some(scene => scene.id === selection.mapScene)) selection.mapScene = p.start ?? p.scenes[0].id
  const scene = p.scenes.find(candidate => candidate.id === selection.mapScene)
  const close = () => { selection.mapNode = null; hooks.renderPage() }
  const [nodeScene, kind, third] = String(selection.mapNode ?? '').split(':')
  const picked = p.scenes.find(candidate => candidate.id === nodeScene)
  const inspector = !picked ? null
    : kind === 'place' ? placeInspector(picked, close)
      : kind === 'exit' ? exitInspector(picked, picked.exits.find(exit => exit.id === third), close)
        : picked.beats.some(beat => beat.id === kind) ? beatInspector(picked, picked.beats.find(beat => beat.id === kind), close) : null
  const scripted = statusOf('story:script') === 'done'
  return [
    pageBar({
      title: '地点图', note: '哪些地方相连、哪条路什么时候通。每个出口通向固定的地方，玩家可以来回走。',
      actions: [
        locked() || readonly() ? null : el('button', { onclick: again('people', '重新设计地点图？', '地点和它们的连接都会换成新的，已经写好的戏也要重写。人物不变，已经生成的画面不会被删除。', '重新设计', 'story:world') }, '重新设计'),
        scripted ? (locked() ? null : el('button', { onclick: again('script', '重写每个锚点的戏？', '所有步骤、旁白和台词都会换成新的，手动改过的也会被替换。已经生成的画面不会被删除。', '重写') }, '重写戏')) : null,
        scripted ? nextButton('下一步：白模', 'whitebox') : locked() ? null : el('button', { class: 'primary', onclick: attempt(() => runScope('script')) }, '下一步：写每个锚点的戏', icon('arrow-right', 15)),
      ],
    }),
    el('div', { class: 'workspace' },
      el('div', { class: 'work-main' },
        readingBanner(),
        problemsBanner(),
        p.mapDesign ? el('p', { class: 'quote map-design' }, p.mapDesign) : null,
        el('div', { class: 'map-well' }, mapDiagram(state.view.journey, { selected: scene.id, onPick: id => { selection.mapScene = id; hooks.renderPage() } })),
        placeDetails(scene)),
      el('aside', { class: 'inspector' },
        inspector ?? el('div', { class: 'block' }, el('h3', {}, '这张图'),
          el('dl', { class: 'kv' },
            el('dt', {}, '地方'), el('dd', {}, p.scenes.length),
            el('dt', {}, '路'), el('dd', {}, new Set(p.scenes.flatMap(place => place.exits.map(exit => [place.id, exit.to].sort().join()))).size),
            el('dt', {}, '玩家要做的事'), el('dd', {}, p.scenes.reduce((sum, place) => sum + place.beats.length, 0))),
          el('p', { class: 'small muted' }, '点图上的地方看它的详情，点一格就能改。想加地方、改路、改锚点，打开修改意见直接说。')))),
  ]
}
