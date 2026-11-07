// The three pages that are about words: the story, who is in it, and what happens where.
import { ask, attempt, el, emptyState, field, go, hooks, icon, locked, nextButton, pageBar, project, readingBanner, readonly, runScope, runTargets, saveSoon, scenePoster, state, svg, thumbUrl } from './core.js'

const statusOf = id => state.view.statuses[id]
const isReading = () => state.view.nodes.some(node => node.group === 'authoring' && statusOf(node.id) === 'running')

// ---------------------------------------------------------------- 1 story
function readStep(id, title, note) {
  const status = statusOf(id)
  const done = status === 'done'
  const busy = status === 'running'
  return el('div', { class: `read-step ${done ? 'done' : busy ? 'running' : ''}` },
    el('i', {}, done ? icon('check', 13) : busy ? icon('loader-circle', 13) : null),
    el('div', {}, title, el('small', {}, busy ? state.view.records[id]?.progress ?? note : note)))
}

export function renderStory() {
  const p = project()
  const hasBreakdown = p.cast.length > 0 || p.scenes.length > 0 || (p.chapters?.length ?? 0) > 0
  const count = el('span', { class: 'mono-label' }, `${p.story.length} 字`)
  const action = el('button', {
    class: hasBreakdown ? '' : 'primary', disabled: locked() || !p.story.trim(),
    onclick: attempt(async () => {
      // A story from before chapters existed is read into them from here too.
      if (hasBreakdown && !await ask('重新分章节和锚点？', '章节、锚点、人物、地点图和剧本都会换成新的结果，手动改过的内容也会被替换。已经生成的画面不会被删除，内容变了的部分要重新生成。', '重新生成')) return
      await runScope('outline', { again: true })
    }),
  }, hasBreakdown ? '重新分章节和锚点' : '分章节和锚点', hasBreakdown ? null : icon('arrow-right', 15))
  const text = el('textarea', { id: 'story-text', value: p.story, placeholder: '写下一段完整的故事，或者一个梗概，多长都可以……', 'aria-label': '故事', disabled: locked(), oninput: event => {
    action.disabled = !event.target.value.trim()
    count.textContent = `${event.target.value.length} 字`
    saveSoon({ story: event.target.value })
  } })
  const reading = isReading()
  return [
    pageBar({ title: '故事', note: '写一段完整的故事，或者只写一个梗概。章节、人物、地点和镜头都由它来。', actions: [readonly() ? null : action, hasBreakdown && !reading ? (p.flow === 'chapters' ? nextButton('下一步：章节', 'chapters') : nextButton('下一步：人物', 'cast')) : null] }),
    el('div', { class: 'workspace' },
      el('div', { class: 'work-main' },
        el('div', { class: 'manuscript' },
          el('div', { class: 'manuscript-head' }, count),
          text)),
      el('aside', { class: 'inspector' },
        state.view.hasKey ? null : el('div', { class: 'notice' }, '还没有填模型密钥，现在拆出来的会是占位内容。', el('button', { onclick: hooks.openSettings }, '填写密钥')),
        readingBanner()?.classList.contains('bad') ? readingBanner() : null,
        hasBreakdown && !reading ? [
          p.style ? el('div', { class: 'block' }, el('h3', {}, '美术风格'), el('p', { class: 'quote' }, p.style)) : null,
          p.cast.length ? el('div', { class: 'block' }, el('h3', {}, `人物 ${p.cast.length}`),
            el('div', { class: 'faces' }, p.cast.map(person => faceThumb(person))),
            el('p', { class: 'small' }, p.cast.map(person => person.name).join('、'))) : null,
          p.chapters?.length ? el('div', { class: 'block' }, el('h3', {}, `章节 ${p.chapters.length}`),
            el('div', {}, p.chapters.map((chapter, index) => el('div', { class: 'scene-line' }, el('span', { class: 'muted small' }, `第 ${index + 1} 章`), el('span', {}, chapter.title), el('small', {}, `${chapter.anchors.length} 个锚点`))))) : null,
          p.scenes.length ? el('div', { class: 'block' }, el('h3', {}, `${p.flow === 'chapters' ? '地点' : '场景'} ${p.scenes.length}`),
            el('div', {}, p.scenes.map((scene, index) => el('div', { class: 'scene-line' }, el('span', { class: 'muted small' }, sceneCode(index)), el('span', {}, scene.title), el('small', {}, `${scene.beats.length} 步`))))) : null,
        ] : el('div', { class: 'block' }, el('h3', {}, '接下来'),
          el('div', { class: 'read-steps' },
            readStep('story:outline', '分章节和锚点', '分成几章，每章定下观众亲身经历的转折'),
            readStep('story:cast', '定人物', '谁在故事里，长什么样，穿什么，什么声音'),
            readStep('story:world', '设计地点图', '有哪些地方，怎么连起来，哪条路什么时候通'),
            readStep('story:script', '写每个锚点的戏', '玩家要做的事、旁白和人物的台词')),
          el('p', { class: 'small muted' }, '都是文字，每一步都能看、能改，也能告诉 Agent 怎么改。这几步还不画任何东西。')),
        p.premise && p.premise !== p.story ? el('div', { class: 'block' }, el('h3', {}, '你最初写的'), el('p', { class: 'quote' }, p.premise)) : null),
    ),
  ]
}

const sceneCode = index => (project().flow === 'chapters' ? `${index + 1}` : `第 ${index + 1} 场`)

function faceThumb(person) {
  const id = `cast:${person.id}:face`
  if (readonly()) return el('img', { src: thumbUrl('plate_face.png', { width: 160 }), alt: person.name, style: 'object-position:22% 30%' })
  if (['done', 'stale'].includes(statusOf(id))) return el('img', { src: thumbUrl(`cast/${person.id}/plate_face.png`, { width: 160, stamp: state.view.records[id]?.finishedAt }), alt: person.name, style: 'object-position:22% 30%' })
  return el('div', { 'aria-label': person.name }, person.name.slice(0, 1))
}

// ---------------------------------------------------------------- 2 cast
// Before a portrait exists, a person is a plaster bust: in this workshop everything starts as a white model.
function bust() {
  const id = `bust${Math.random().toString(36).slice(2, 7)}`
  return svg('svg', { class: 'bust', viewBox: '0 0 160 240', preserveAspectRatio: 'xMidYMax slice', 'aria-hidden': 'true' },
    svg('defs', {},
      svg('radialGradient', { id: `${id}h`, cx: '38%', cy: '30%', r: '75%' }, svg('stop', { offset: '0', 'stop-color': '#f7f7f4' }), svg('stop', { offset: '1', 'stop-color': '#a9a9a4' })),
      svg('linearGradient', { id: `${id}s`, x1: '0', y1: '0', x2: '1', y2: '1' }, svg('stop', { offset: '0', 'stop-color': '#efefeb' }), svg('stop', { offset: '1', 'stop-color': '#9c9c97' }))),
    svg('path', { d: 'M14 240c2-44 22-66 52-74l28 0c30 8 50 30 52 74z', fill: `url(#${id}s)` }),
    svg('path', { d: 'M66 132h28v44c-9 8-19 8-28 0z', fill: '#b5b5b0' }),
    svg('ellipse', { cx: 80, cy: 102, rx: 33, ry: 41, fill: `url(#${id}h)` }))
}

function portrait(person) {
  const id = `cast:${person.id}:face`
  if (readonly()) return el('img', { src: thumbUrl('plate_face.png', { width: 640 }), alt: `${person.name}的定妆照` })
  if (['done', 'stale'].includes(statusOf(id))) return el('img', { src: thumbUrl(`cast/${person.id}/plate_face.png`, { width: 640, stamp: state.view.records[id]?.finishedAt }), alt: `${person.name}的定妆照` })
  return bust()
}

// Five ways the player can face. The other three are these, mirrored.
const FACINGS = [['e', '侧面'], ['n', '背面'], ['s', '正面'], ['ne', '侧背'], ['se', '侧前']]

function miniFigure() {
  return svg('svg', { class: 'mini-figure', viewBox: '0 0 40 88', 'aria-hidden': 'true' },
    svg('ellipse', { cx: 20, cy: 12, rx: 7.5, ry: 9, fill: '#c9c9c4' }),
    svg('path', { d: 'M9 26c2-4 6-5 11-5s9 1 11 5l2 26h-6v30h-5V56h-4v26h-5V52H7z', fill: '#bdbdb7' }))
}

function turnaround(person) {
  return el('div', { class: 'turnaround' }, el('small', {}, '走路和站姿'), el('div', { class: 'turn-row' }, FACINGS.map(([id, label]) => {
    const nodeId = `cast:${person.id}:stand:${id}`
    const ready = readonly() || ['done', 'stale'].includes(statusOf(nodeId))
    const file = readonly() ? `stand_${id}.png` : `cast/${person.id}/stand_${id}.png`
    return el('figure', {},
      el('div', {}, ready ? el('img', { src: thumbUrl(file, { width: 200, key: true, stamp: state.view.records[nodeId]?.finishedAt ?? '' }), alt: label, loading: 'lazy' }) : miniFigure()),
      el('figcaption', {}, label))
  })))
}

export function renderCast() {
  const p = project()
  if (!p.cast.length) {
    return [pageBar({ title: '人物' }), el('div', { class: 'work-main' }, readingBanner(),
      isReading() ? null : emptyState('users-round', '还没有人物', '写好故事后，模型会把人物拆出来。', el('button', { class: 'primary', onclick: () => go('story') }, '去写故事')))]
  }
  const { selection } = state
  const change = () => saveSoon({ cast: p.cast })
  const selected = p.cast.find(person => person.id === selection.person)
  const select = id => { selection.person = id; hooks.renderPage() }
  const canShoot = !locked() && state.view.nodes.some(node => node.id.endsWith(':face'))
  return [
    pageBar({ title: '人物', note: '主角由玩家操作，其他人物出现在电影镜头里。', actions: [nextButton(p.flow === 'chapters' ? '下一步：地点图' : '下一步：场景', 'scenes')] }),
    el('div', { class: 'workspace' },
      el('div', { class: 'work-main' },
        readingBanner(),
        el('div', { class: 'sheets' }, p.cast.map(person => {
          const faceId = `cast:${person.id}:face`
          const hasFace = readonly() || ['done', 'stale'].includes(statusOf(faceId))
          const faceBusy = statusOf(faceId) === 'running'
          return el('article', { class: `sheet ${selection.person === person.id ? 'on' : ''}`, tabIndex: 0, role: 'button', onclick: () => select(person.id), onkeydown: event => { if (event.key === 'Enter' && event.target === event.currentTarget) select(person.id) } },
            el('div', { class: 'sheet-face' }, portrait(person)),
            el('div', { class: 'sheet-body' },
              el('div', { class: 'sheet-name' }, el('b', {}, person.name), person.playable ? el('span', { class: 'chip solid' }, '玩家') : null, person.age ? el('span', { class: 'chip' }, person.age) : null),
              el('div', { class: 'sheet-row' }, el('small', {}, '外貌'), el('span', {}, person.look)),
              el('div', { class: 'sheet-row' }, el('small', {}, '服装'), el('span', {}, person.costume)),
              person.playable ? turnaround(person) : null,
              hasFace || !canShoot ? null : el('div', {}, el('button', { disabled: faceBusy, onclick: attempt(async event => {
                event.stopPropagation()
                await runTargets([faceId])
              }) }, faceBusy ? icon('loader-circle', 14) : icon('image', 14), faceBusy ? '正在定妆' : '生成定妆照'))))
        }))),
      el('aside', { class: 'inspector' },
        selected ? el('div', { class: 'block' },
          el('div', { class: 'inspector-head' }, el('div', {}, el('h2', {}, selected.name)), el('button', { class: 'quiet icon-only', 'aria-label': '关闭', onclick: () => select(null) }, icon('x'))),
          el('div', { class: 'form' },
            field('名字', selected.name, value => { selected.name = value; change() }),
            field('外貌', selected.look, value => { selected.look = value; change() }, { multiline: true, rows: 4 }),
            field('服装', selected.costume, value => { selected.costume = value; change() }, { multiline: true, rows: 4, hint: '从上到下写清颜色和材质，走路视频靠它保持同一个人。' }),
            field('声音', selected.voice ?? '', value => { selected.voice = value; change() }, { multiline: true, rows: 2, hint: '只影响有台词的镜头。', placeholder: '如：中年男声，低沉，语速快' }),
            selected.playable ? null : el('button', { disabled: locked(), onclick: () => { p.cast.forEach(other => { other.playable = other === selected }); change(); hooks.renderPage() } }, '改由玩家操作这个人物'))) : null,
        el('div', { class: 'block' }, el('h3', {}, '美术风格'),
          locked() ? el('p', { class: 'quote' }, p.style) : el('textarea', { rows: 5, 'aria-label': '美术风格', value: p.style, style: 'font:400 14px/1.85 var(--story)', oninput: event => { p.style = event.target.value; saveSoon({ style: event.target.value }) } }),
          el('p', { class: 'small muted' }, '所有画面都按这段话来画。改了它，画过的内容会标记为需要更新。')),
      ),
    ),
  ]
}

// ---------------------------------------------------------------- 3 scenes
const clipSeconds = beat => (beat.face ? 13 : 10)
const reelOf = scene => [
  { label: '开场', seconds: 10 },
  ...scene.beats.filter(beat => beat.performed).map(beat => ({ label: beat.objective, seconds: clipSeconds(beat), face: Boolean(beat.face), key: beat.id })),
  ...(scene.stage?.exit === 'opening' ? [] : [{ label: scene.exit.objective || '推门', seconds: 10 }]),
  { label: '结尾', seconds: 9, face: true },
]
const filmSeconds = scene => reelOf(scene).reduce((sum, clip) => sum + clip.seconds, 0)

// The film this scene will cut together, drawn to scale. Where the time and the money go.
function reel(scene) {
  return el('div', { class: 'reel' },
    el('div', { class: 'reel-strip', role: 'img', 'aria-label': `这一场的影片结构，共约 ${filmSeconds(scene)} 秒` }, reelOf(scene).map(clip => el('div', { class: `reel-clip ${clip.key ? 'story' : ''}`, style: `flex:${clip.seconds} 1 0`, title: `${clip.label} · ${clip.seconds} 秒` },
      el('b', {}, clip.label), el('small', {}, `${clip.seconds} 秒${clip.face ? ' · 含露脸' : ''}`)))),
  )
}

export function renderScenes() {
  const p = project()
  if (!p.scenes.length) {
    return [pageBar({ title: '场景' }), el('div', { class: 'work-main' }, readingBanner(),
      isReading() ? null : emptyState('route', '还没有场景', '故事拆解之后，每个地方和玩家要做的事会排在这里。', el('button', { class: 'primary', onclick: () => go('story') }, '去写故事')))]
  }
  const { selection } = state
  const pick = key => { selection.sceneNode = key; hooks.renderPage() }
  const all = p.scenes.flatMap(scene => [
    { key: `${scene.id}:scene`, scene },
    ...scene.beats.map(beat => ({ key: `${scene.id}:${beat.id}`, scene, beat })),
    { key: `${scene.id}:exit`, scene, exit: true },
  ])
  const selected = all.find(node => node.key === selection.sceneNode)
  const shots = p.scenes.reduce((sum, scene) => sum + reelOf(scene).length, 0)
  const seconds = p.scenes.reduce((sum, scene) => sum + filmSeconds(scene), 0)
  return [
    pageBar({ title: '场景', note: '每一场是一个地方，从左到右是玩家要做的事。', actions: [nextButton('下一步：白模', 'whitebox')] }),
    el('div', { class: 'workspace' },
      el('div', { class: 'work-main' },
        readingBanner(),
        el('div', { class: 'acts' }, p.scenes.map((scene, index) => act(scene, index, pick)))),
      el('aside', { class: 'inspector' },
        selected ? sceneInspector(selected, () => pick(null)) : el('div', { class: 'block' },
          el('h3', {}, '这部片子'),
          el('dl', { class: 'kv' },
            el('dt', {}, '场景'), el('dd', {}, p.scenes.length),
            el('dt', {}, '玩家要做的事'), el('dd', {}, p.scenes.reduce((sum, scene) => sum + scene.beats.length + 1, 0)),
            el('dt', {}, '电影镜头'), el('dd', {}, shots),
            el('dt', {}, '视频时长'), el('dd', {}, `约 ${seconds} 秒`)),
          el('p', { class: 'small muted' }, '点一格就能改。开场、每一次和物品的交互、推门和结尾，都各有一段电影镜头。'))),
    ),
  ]
}

function act(scene, index, pick) {
  const { selection } = state
  const poster = scenePoster(scene)
  const performed = scene.beats.filter(beat => beat.performed).length
  const frame = (beat, step) => el('button', { class: `frame ${selection.sceneNode === `${scene.id}:${beat.id}` ? 'on' : ''}`, onclick: () => pick(`${scene.id}:${beat.id}`) },
    el('span', { class: 'frame-top' }, `第 ${step + 1} 步`, beat.performed ? el('span', { class: 'frame-type shot' }, icon('clapperboard', 12), '镜头') : el('span', { class: 'frame-type' }, icon('message-square-quote', 12), '旁白')),
    el('b', {}, beat.objective),
    beat.during || beat.after ? el('q', {}, beat.during || beat.after) : null,
    el('small', {}, icon('map-pin', 12), beat.objectName))
  // Where each prop is picked up and where it gets used: the thread the player follows through the room.
  const takenAt = prop => scene.beats.findIndex(beat => [beat.takes].flat().includes(prop.id))
  const props = [
    // Already in hand when the scene opens, so the thread starts at the first frame.
    ...(scene.carried ?? []).map(prop => ({ prop: { ...prop, name: `带来的${prop.name}` }, given: 0, taken: takenAt(prop) })),
    ...(scene.props ?? []).flatMap(prop => {
      const given = scene.beats.findIndex(beat => [beat.gives].flat().includes(prop.id))
      return given < 0 ? [] : [{ prop, given, taken: takenAt(prop) }]
    }),
  ]
  return el('section', { class: 'act' },
    el('button', { class: `act-head ${selection.sceneNode === `${scene.id}:scene` ? 'on' : ''}`, onclick: () => pick(`${scene.id}:scene`) },
      el('div', { class: 'act-poster' }, poster ? el('img', { src: thumbUrl(poster.file, { width: 400, stamp: poster.stamp ?? '' }), alt: '' }) : '还没有白模'),
      el('div', { class: 'act-text' },
        el('span', { class: 'mono-label' }, sceneCode(index)),
        el('b', {}, scene.title),
        el('p', {}, scene.place),
        el('div', { class: 'act-stats' },
          el('span', {}, icon('footprints', 13), `${scene.beats.length + 1} 步`),
          el('span', {}, icon('clapperboard', 13), `${reelOf(scene).length} 个镜头`),
          el('span', {}, icon('clock', 13), `约 ${filmSeconds(scene)} 秒`)))),
    el('div', { class: 'board-scroll' }, el('div', { class: 'board' },
      scene.beats.map(frame),
      el('button', { class: `frame exit ${selection.sceneNode === `${scene.id}:exit` ? 'on' : ''}`, onclick: () => pick(`${scene.id}:exit`) },
        el('span', { class: 'frame-top' }, '离开', el('span', { class: 'frame-type shot' }, icon('clapperboard', 12), '镜头')),
        el('b', {}, scene.exit.objective || `推开${scene.exit.name}`),
        scene.exit.during ? el('q', {}, scene.exit.during) : null,
        el('small', {}, icon('door-open', 12), scene.exit.name)),
      props.map(({ prop, given, taken }, row) => el('div', { class: `prop-run ${taken >= 0 ? 'used' : ''}`, style: `grid-row:${row + 2};grid-column:${given + 1} / ${taken >= 0 ? taken + 2 : scene.beats.length + 2}` }, el('span', {}, prop.name), el('i'))),
    )),
    el('div', { class: 'block' }, el('h3', {}, '这一场会剪成'), reel(scene)),
  )
}

function sceneInspector({ scene, beat, exit }, close) {
  const change = () => saveSoon({ scenes: project().scenes })
  const bind = (object, key) => value => { object[key] = value; change() }
  const head = (label, title) => el('div', { class: 'inspector-head' }, el('div', {}, el('span', { class: 'mono-label' }, label), el('h2', {}, title)), el('button', { class: 'quiet icon-only', 'aria-label': '关闭', onclick: close }, icon('x')))
  if (beat) {
    return el('div', { class: 'block' }, head(beat.performed ? '这一步是电影镜头' : '这一步是旁白', beat.objective), el('div', { class: 'form' },
      field('屏幕上的目标', beat.objective, bind(beat, 'objective')),
      field('按键提示', beat.prompt, bind(beat, 'prompt')),
      field('进行时的旁白', beat.during, bind(beat, 'during'), { multiline: true, rows: 2 }),
      field('完成后的旁白', beat.after, bind(beat, 'after'), { multiline: true, rows: 2 }),
      field('还没轮到时的一句话', beat.tooEarly, bind(beat, 'tooEarly')),
      beat.performed ? [
        field('镜头内容', beat.action, bind(beat, 'action'), { multiline: true, rows: 4, hint: '全程不露脸，只有背影、肩膀和手。这样才能和游戏画面无缝衔接。' }),
        field('露脸镜头', beat.face, bind(beat, 'face'), { multiline: true, rows: 2, placeholder: '可以不写' }),
        field('台词', (beat.lines ?? []).map(line => `${line.who}：${line.says}`).join('\n'), value => {
          const lines = value.split('\n').map(text => text.match(/^\s*([^：:]+)[：:]\s*(.+?)\s*$/)).filter(Boolean).map(([, who, says]) => ({ who: who.trim(), says }))
          if (lines.length) beat.lines = lines
          else delete beat.lines
          change()
        }, { multiline: true, rows: 3, placeholder: '谁：说什么，一行一句。写在露脸镜头里才会说出来', hint: '一个镜头最多 12 秒，大约 45 个字。' }),
        field('收尾特写', beat.settle, bind(beat, 'settle'), { multiline: true, rows: 2, placeholder: '可以不写' }),
        field('声音', beat.sound, bind(beat, 'sound'), { multiline: true, rows: 2 }),
      ] : null))
  }
  if (exit) {
    return el('div', { class: 'block' }, head('离开这里', scene.exit.objective || `推开${scene.exit.name}`), el('div', { class: 'form' },
      field('门', scene.exit.name, bind(scene.exit, 'name')),
      field('门后是什么', scene.exit.beyond, bind(scene.exit, 'beyond'), { multiline: true, rows: 2 }),
      field('目标文字', scene.exit.objective, bind(scene.exit, 'objective')),
      field('推门时的旁白', scene.exit.during, bind(scene.exit, 'during')),
      scene.film ? [
        field('推门镜头', scene.film.door.action, bind(scene.film.door, 'action'), { multiline: true, rows: 3 }),
        field('结尾镜头', scene.film.ending.action, bind(scene.film.ending, 'action'), { multiline: true, rows: 3 }),
        field('结尾露脸镜头', scene.film.ending.face, bind(scene.film.ending, 'face'), { multiline: true, rows: 2 }),
      ] : null))
  }
  return el('div', { class: 'block' }, head('场景', scene.title), el('div', { class: 'form' },
    field('名字', scene.title, bind(scene, 'title')),
    field('这个地方', scene.place, bind(scene, 'place'), { multiline: true, hint: '写清墙面和地面的颜色与材质。' }),
    field('光线和色调', scene.mood, bind(scene, 'mood'), { multiline: true, rows: 2 }),
    field('开场旁白', scene.openingLine, bind(scene, 'openingLine'), { multiline: true, rows: 2 }),
    field('结束旁白', scene.endingLine, bind(scene, 'endingLine'), { multiline: true, rows: 2 }),
    scene.film ? field('开场镜头', scene.film.opening.action, bind(scene.film.opening, 'action'), { multiline: true, rows: 3 }) : null))
}
