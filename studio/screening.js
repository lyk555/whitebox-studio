// The two rooms with the lights down: walking through it, and sitting back to watch.
import { arrive, dueSteps, exitIsOpen, newProgress, stepKey } from '/journey.js'
import { ask, attempt, el, emptyState, go, hooks, icon, pageBar, project, readonly, running, runTargets, scenePoster, state, thumbUrl } from './core.js'
import { isWorldProject, mapDiagram } from './world.js'

const CARD_MS = 1800
const ARRIVAL_PATIENCE_MS = 20000

let watcher = null
let leaving = null
let arriving = null
let playFrame = null
let afterScene = null
export function stopPlayWatch() {
  clearInterval(watcher)
  clearTimeout(leaving)
  clearInterval(arriving)
  watcher = leaving = arriving = playFrame = afterScene = null
}

// A scene ends on black, and the next one follows by itself: the player has already said go.
addEventListener('message', event => {
  if (event.source !== playFrame?.contentWindow) return
  if (event.data?.type === 'scene-finished') afterScene?.()
  else if (isWorldProject()) hearFromPlace(event.data)
})

const sceneCard = (p, scene) => el('div', { class: 'scene-card', role: 'status' }, el('small', {}, `第 ${p.scenes.indexOf(scene) + 1} 场`), el('b', {}, scene.title))

// The card stays up until the scene behind it is ready, so nobody watches it load.
function arriveAt(frame, card) {
  const since = Date.now()
  arriving = setInterval(() => {
    const loop = frame.contentWindow?.__loop
    if (!loop && Date.now() - since < ARRIVAL_PATIENCE_MS) return
    clearInterval(arriving)
    loop?.start()
    frame.contentWindow?.focus()
    card.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400 }).onfinish = () => card.remove()
  }, 100)
}

const clockOf = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

// ---------------------------------------------------------------- 6 play
function briefFor(scene, frame) {
  const beats = state.view.stages[scene.id].story.beats
  const list = el('ol', { class: 'brief' }, beats.map(beat => el('li', { 'data-objective': beat.objective }, el('i'), beat.objective)))
  const paint = () => {
    const loop = frame.contentWindow?.__loop
    if (!loop) return
    const { objective, phase } = loop.snapshot()
    const at = phase === 'finished' ? beats.length : beats.findIndex(beat => beat.objective === objective)
    const reached = at < 0 ? beats.length : at
    Array.from(list.children).forEach((item, index) => {
      item.className = index < reached ? 'past' : index === reached ? 'now' : ''
      const mark = item.firstChild
      mark.replaceChildren(...(index < reached ? [icon('check', 11)] : []))
    })
  }
  watcher = setInterval(paint, 500)
  return list
}

// ---------------------------------------------------------------- walking a story on the map
// Each place is a page of its own, so what the player has done is kept out here and handed to whichever place is next.
let journeyList = null
let journeyHead = null

function hearFromPlace(message) {
  const { selection } = state
  const p = project()
  if (!message?.type) return
  if (message.progress) selection.journey = message.progress
  if (message.type === 'progress') paintJourney()
  else if (message.type === 'travel') {
    selection.journey = { ...selection.journey, at: message.to }
    selection.cameFrom = message.from
    moveOn(placeCard(message.to))
  } else if (message.type === 'chapter-finished') {
    if (message.storyEnded) {
      if (journeyHead) journeyHead.replaceChildren(el('span', { class: 'mono-label' }, '看完了'), el('h2', {}, p.title))
      paintJourney()
      return
    }
    selection.cameFrom = null
    const number = selection.journey.chapter + 1
    moveOn(el('div', { class: 'scene-card', role: 'status' }, el('small', {}, `第 ${number} 章`), el('b', {}, state.view.journey.chapters[number - 1]?.title ?? p.title)))
  } else if (message.type === 'restart') {
    attempt(async () => {
      if (!await ask('从头开始？', '这一遍走到的进度会清空，从第一章重新开始。', '从头开始')) return
      selection.journey = null
      selection.cameFrom = null
      hooks.renderPage()
    })()
  }
}

function moveOn(card) {
  const { selection } = state
  document.querySelector('.theatre-stage')?.append(card)
  leaving = setTimeout(() => {
    selection.arriving = true
    hooks.renderPage()
  }, CARD_MS)
}

const placeCard = id => el('div', { class: 'scene-card', role: 'status' }, el('small', {}, '来到'), el('b', {}, state.view.journey.places[id]?.title ?? ''))

// What the plan has stopped containing cannot be held against a player: the story may have changed since they last played.
function journeyNow(plan) {
  const { selection } = state
  const known = new Set(plan.chapters.flatMap(chapter => chapter.anchors.flatMap(anchor => anchor.steps.map(step => stepKey(step.scene, step.beat)))))
  const saved = selection.journey ?? newProgress(plan)
  const fixed = { ...saved, done: saved.done.filter(key => known.has(key)), at: plan.places[saved.at] ? saved.at : plan.start }
  selection.journey = fixed
  return fixed
}

function paintJourney() {
  if (!journeyList) return
  const plan = state.view.journey
  const progress = state.selection.journey
  const done = new Set(progress.done)
  const due = new Set(dueSteps(plan, progress).map(step => step.anchor))
  journeyList.replaceChildren(...(plan.chapters[progress.chapter]?.anchors ?? []).map(anchor => {
    const finished = anchor.steps.every(step => done.has(stepKey(step.scene, step.beat)))
    return el('li', { class: finished ? 'past' : due.has(anchor.id) ? 'now' : '' }, el('i', {}, finished ? icon('check', 11) : null), anchor.title)
  }))
}

function renderJourney() {
  const p = project()
  const { selection } = state
  const plan = state.view.journey
  const progress = journeyNow(plan)
  const scene = p.scenes.find(candidate => candidate.id === progress.at)
  if (!p.scenes.every(place => place.objects?.length)) return [pageBar({ title: '互动' }), el('div', { class: 'work-main' }, emptyState('gamepad-2', '还没有可以走的地方', '搭好每个地方的白模，就能走进去了。', el('button', { class: 'primary', onclick: () => go('whitebox') }, '去搭白模')))]
  const made = state.view.statuses[`scene:${scene.id}:frames`] === 'done'
  const address = new URLSearchParams({ journey: JSON.stringify(progress), from: selection.cameFrom ?? '', finish: `《${p.title}》完。按 R 重来。` })
  const frame = el('iframe', { class: 'theatre-frame', title: `${scene.title}：互动`, allow: 'autoplay; fullscreen', src: `/play/${state.projectId}/${scene.id}/?${address}` })
  const inFrame = id => () => frame.contentDocument?.getElementById(id)?.click()
  const stage = el('div', { class: 'theatre-stage' }, frame)
  playFrame = frame
  frame.addEventListener('load', () => frame.contentWindow?.focus())
  if (selection.arriving) {
    selection.arriving = false
    const card = placeCard(scene.id)
    stage.append(card)
    arriveAt(frame, card)
  }
  const chapter = plan.chapters[progress.chapter]
  journeyList = el('ol', { class: 'brief' })
  paintJourney()
  journeyHead = el('div', { class: 'block' },
    el('span', { class: 'mono-label' }, chapter ? `第 ${progress.chapter + 1} 章 / 共 ${plan.chapters.length} 章` : '看完了'),
    el('h2', {}, chapter?.title ?? p.title),
    made ? null : el('div', {}, el('span', { class: 'chip' }, '还没生成，先看白模')))
  return el('div', { class: 'theatre' },
    stage,
    el('aside', { class: 'inspector' },
      journeyHead,
      chapter ? el('div', { class: 'block' }, el('h3', {}, '这一章的锚点'), journeyList) : null,
      el('div', { class: 'block' }, el('h3', {}, '现在在哪'),
        mapDiagram(plan, {
          compact: true, current: scene.id, isOpen: exit => exitIsOpen(plan, progress, exit),
          // For whoever is making it: go and look at any place, without changing what has been done.
          onPick: id => {
            selection.journey = arrive({ ...progress, at: id }, progress.at)
            selection.cameFrom = null
            hooks.renderPage()
          },
        })),
      el('div', { class: 'block' }, el('h3', {}, '操作'),
        el('div', { class: 'keys' },
          el('span', {}, el('kbd', {}, 'W'), el('kbd', {}, 'A'), el('kbd', {}, 'S'), el('kbd', {}, 'D')), '走动',
          el('span', {}, el('kbd', {}, 'E')), '互动，走到出口去别的地方',
          el('span', {}, el('kbd', {}, '空格')), '跳过视频')),
      el('div', { class: 'row' },
        el('button', { onclick: inFrame('reset') }, icon('rotate-ccw', 14), '从头开始'),
        made ? el('button', { onclick: inFrame('toggle') }, icon('box', 14), '白模 / 画面') : null),
      !chapter && state.view.filmReady ? el('button', { class: 'primary', onclick: () => go('watch') }, icon('circle-play', 15), '看整部影片') : null,
    ),
  )
}

export function renderPlay() {
  const p = project()
  const { selection } = state
  if (isWorldProject() && p.scenes.length) return renderJourney()
  const scenes = p.scenes.filter(scene => scene.demoStage || scene.objects?.length)
  if (!scenes.length) return [pageBar({ title: '互动' }), el('div', { class: 'work-main' }, emptyState('gamepad-2', '还没有可以走的地方', '搭好白模就能走进去了。', el('button', { class: 'primary', onclick: () => go('whitebox') }, '去搭白模')))]
  if (!scenes.some(scene => scene.id === selection.playScene)) selection.playScene = scenes[0].id
  const scene = scenes.find(candidate => candidate.id === selection.playScene)
  const index = scenes.indexOf(scene)
  const made = p.readonly || state.view.statuses[`scene:${scene.id}:frames`] === 'done'
  const next = scenes[index + 1]
  const finishLine = next ? '这一场结束。' : `《${p.title}》完。按 R 重来。`
  const frame = el('iframe', { class: 'theatre-frame', title: `${scene.title}：互动`, allow: 'autoplay; fullscreen', src: `/play/${state.projectId}/${scene.id}/?finish=${encodeURIComponent(finishLine)}` })
  const inFrame = id => () => frame.contentDocument?.getElementById(id)?.click()
  const stage = el('div', { class: 'theatre-stage' }, frame)
  playFrame = frame
  // Keys go straight to the game; nobody should have to click into it first.
  frame.addEventListener('load', () => frame.contentWindow?.focus())
  afterScene = next ? () => {
    afterScene = null
    stage.append(sceneCard(p, next))
    leaving = setTimeout(() => {
      selection.playScene = next.id
      selection.arrivingAt = next.id
      hooks.renderPage()
    }, CARD_MS)
  } : null
  if (selection.arrivingAt === scene.id) {
    selection.arrivingAt = null
    const card = sceneCard(p, scene)
    stage.append(card)
    arriveAt(frame, card)
  }
  return el('div', { class: 'theatre' },
    stage,
    el('aside', { class: 'inspector' },
      el('div', { class: 'block' },
        el('span', { class: 'mono-label' }, `第 ${p.scenes.indexOf(scene) + 1} 场 / 共 ${p.scenes.length} 场`),
        el('h2', {}, scene.title),
        made ? null : el('div', {}, el('span', { class: 'chip' }, '还没生成，先看白模'))),
      el('div', { class: 'block' }, el('h3', {}, '这一场要做的事'), briefFor(scene, frame)),
      el('div', { class: 'block' }, el('h3', {}, '操作'),
        el('div', { class: 'keys' },
          el('span', {}, el('kbd', {}, 'W'), el('kbd', {}, 'A'), el('kbd', {}, 'S'), el('kbd', {}, 'D')), '走动',
          el('span', {}, el('kbd', {}, 'E')), '互动',
          el('span', {}, el('kbd', {}, '空格')), '跳过视频',
          el('span', {}, el('kbd', {}, 'Esc')), '松开鼠标')),
      el('div', { class: 'row' },
        el('button', { onclick: inFrame('reset') }, icon('rotate-ccw', 14), '重来'),
        made ? el('button', { onclick: inFrame('toggle') }, icon('box', 14), '白模 / 画面') : null),
      scenes.length > 1 ? el('div', { class: 'block' }, el('h3', {}, '场景'), scenes.map(item => {
        const poster = scenePoster(item)
        return el('button', { class: `scene-pick ${item.id === scene.id ? 'on' : ''}`, onclick: () => { selection.playScene = item.id; hooks.renderPage() } },
          poster ? el('img', { src: thumbUrl(poster.file, { width: 200, stamp: poster.stamp ?? '' }), alt: '' }) : el('div'), item.title)
      })) : null,
      index + 1 >= scenes.length && state.view.filmReady ? el('button', { class: 'primary', onclick: () => go('watch') }, icon('circle-play', 15), '看整部影片') : null,
    ),
  )
}

// ---------------------------------------------------------------- 7 watch
export function renderWatch() {
  const { view } = state
  const p = project()
  const film = view.nodes.find(node => node.id === 'film')
  if (!view.filmReady) {
    const status = film ? view.statuses.film : null
    const canRun = film && !running() && (readonly() || status === 'ready' || status === 'stale')
    return el('div', { class: 'work-main' },
      emptyState('film', status === 'running' ? '正在合成整部影片' : canRun ? '镜头都好了' : '影片还没有好', view.records.film?.error ?? (canRun ? '把所有镜头按故事顺序接起来。' : '所有镜头做好之后，这里就能从头看到尾。'),
        canRun ? el('button', { class: 'primary large', onclick: attempt(() => runTargets(['film'])) }, icon('film', 16), '合成整部影片') : status === 'running' ? null : el('button', { onclick: () => go('generate') }, '去生成')))
  }
  const stamp = view.records.film?.finishedAt ?? ''
  const video = el('video', { class: 'film', controls: true, preload: 'metadata', poster: thumbUrl('film.mp4', { width: 1280, at: 4, stamp }), src: `/film/${state.projectId}?t=${stamp}` },
    el('track', { kind: 'subtitles', srclang: 'zh', label: '字幕', default: true, src: `/api/projects/${state.projectId}/captions.vtt?t=${stamp}-${p.updatedAt}` }))
  const list = el('div', { class: 'chapters' })
  const length = el('span', {}, icon('clock', 13), '—')
  fetch(`/api/projects/${state.projectId}/files/chapters.json?t=${stamp}`).then(response => response.ok ? response.json() : []).then(found => {
    list.replaceChildren(...found.map(chapter => {
      // Every scene has its own 开场 and 结尾, so with several the shot alone does not say where it is.
      const cut = chapter.title.lastIndexOf(' · ')
      return el('button', { class: 'chapter', onclick: () => { video.currentTime = chapter.start; video.play() } },
        el('img', { src: thumbUrl('film.mp4', { width: 320, at: chapter.start + 0.8, stamp }), alt: '', loading: 'lazy' }),
        el('span', {}, el('small', {}, clockOf(chapter.start)), el('b', {}, chapter.title.slice(cut < 0 ? 0 : cut + 3))),
        p.scenes.length > 1 && cut >= 0 ? el('em', { class: 'chapter-scene' }, chapter.title.slice(0, cut)) : null)
    }))
  }).catch(() => {})
  video.addEventListener('loadedmetadata', () => length.replaceChildren(icon('clock', 13), clockOf(video.duration)))
  return el('div', { class: 'cinema' },
    el('img', { class: 'cinema-glow', src: thumbUrl('film.mp4', { width: 320, at: 4, stamp }), alt: '' }),
    el('div', { class: 'cinema-inner' },
      video,
      el('div', { class: 'credits' },
        el('div', { style: 'display:grid;gap:8px;min-width:0' },
          el('h1', {}, p.title),
          el('div', { class: 'credit-meta' },
            length,
            el('span', {}, icon('route', 13), isWorldProject() ? `${p.scenes.length} 个地方` : `${p.scenes.length} 场`),
            el('span', {}, icon('users-round', 13), p.cast.map(person => person.name).join('、'))),
          el('p', {}, p.story.length > 140 ? `${p.story.slice(0, 140)}……` : p.story)),
        el('div', { class: 'row' },
          el('button', { onclick: () => go('play') }, icon('gamepad-2', 15), '走进去玩'),
          el('a', { class: 'download', href: `/film/${state.projectId}`, download: `${p.title}.mp4` }, icon('download', 15), '下载'))),
      list))
}
