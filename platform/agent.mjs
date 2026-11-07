// Notes on a whole story, turned into changes. The model reads the note and writes a list of edits; the edits are tried
// on a copy and put through the same checks as a story being read for the first time. What fails goes back to the model
// with the reason. What passes is only a proposal: the person sees what would change and what it would cost to remake,
// worked out from the step graph, and nothing is touched until they say so.
import { closeStage } from '../runtime/shell.js'
import { exitFrom } from './authoring.mjs'
import { askChecked, beatFromAnswer, fallbackLayout, NOT_A_THING, roomRules, SCENE_FORMAT, sceneFromAnswer, STORY_RULES } from './breakdown.mjs'
import { inputHash, nodeStatuses, planFor, readState, updateRecords } from './engine.mjs'
import { buildGraph, cardsFor, generationTargets } from './graph.mjs'
import { MOST_LOOKED_AT, picturesOf } from './looking.mjs'
import { applyChanges } from './setChat.mjs'
import { PART_RULES } from './shapes.mjs'
import { linesProblem, spokenLines } from './speech.mjs'
import { buildStage, settleForFilming, shapeOf } from './stage.mjs'
import { readProject, writeProject } from './store.mjs'
import { anchorsOf, isWorld, mapText, outlineText, settleWorld, worldProblems } from './world.mjs'

const HISTORY_SENT = 10
const HISTORY_KEPT = 40
export const STORY_FIELDS = ['title', 'story', 'style', 'cast', 'scenes', 'chapters', 'start', 'truth', 'mapDesign']
const clean = value => String(value ?? '').trim()
const refuse = (message, status = 400) => Object.assign(new Error(message), { status })

// ---------------------------------------------------------------- finding what a note is about
function findIn(list, target, kind) {
  const wanted = clean(target)
  const name = item => item.title ?? item.name ?? item.objective
  const found = list.find(item => item.id === wanted)
    ?? list.find(item => name(item) === wanted || item.objectName === wanted)
    ?? (wanted ? list.find(item => name(item)?.includes(wanted) || wanted.includes(name(item) ?? '\0') || item.objectName === wanted) : null)
  if (!found) throw new Error(`没有${kind}“${target}”。现有的是：${list.map(item => `${item.id}（${name(item)}）`).join('、')}。`)
  return found
}

const nextId = (list, prefix) => `${prefix}${Math.max(0, ...list.map(item => Number(String(item.id).slice(prefix.length)) || 0)) + 1}`
const propIds = value => (Array.isArray(value) ? value : String(value ?? '').split(/[,，、\s]+/)).map(id => clean(id).toLowerCase().replace(/[^a-z0-9_]/g, '')).filter(Boolean)

// Places an item after another, or first when it names none.
function placeAfter(list, item, after, kind) {
  const without = list.filter(other => other !== item)
  const index = clean(after) ? without.indexOf(findIn(without, after, kind)) + 1 : 0
  list.splice(0, list.length, ...without.slice(0, index), item, ...without.slice(index))
}

// ---------------------------------------------------------------- the edits
const SCENE_TEXT = { title: '场景名', edges: '四周', place: '环境', mood: '光线和氛围', opening_line: '开场旁白', ending_line: '结尾旁白' }
const SCENE_KEYS = { opening_line: 'openingLine', ending_line: 'endingLine' }
const EXIT_TEXT = { name: '出口', beyond: '出口外的样子', objective: '出口的目标文字', prompt: '出口的按键提示', too_early: '出口没到时候的提示', during: '出口的旁白', last_objective: '出口打开后的目标' }
const EXIT_KEYS = { too_early: 'tooEarly', last_objective: 'lastObjective' }
const FILM_TEXT = { opening: '开场视频', door: '出口视频', ending: '结尾视频' }
const BEAT_TEXT = { objective: '目标', prompt: '按键提示', too_early: '没到时候的提示', during: '进行时的旁白', after: '完成后的旁白', action: '视频内容', face: '露脸镜头', settle: '露脸后的特写', sound: '声音' }
const BEAT_KEYS = { too_early: 'tooEarly' }
const CAST_TEXT = { age: '年龄', look: '外貌', costume: '服装', personality: '性格', voice: '声音' }

function writer(changed) {
  return (holder, key, value, where, what) => {
    if (value === undefined || value === null) return
    const [before, after] = [clean(holder[key]), clean(value)]
    if (before === after) return
    changed.push({ where, what, from: before, to: after })
    holder[key] = after
  }
}

function writeList(changed, holder, key, value, where, what) {
  if (value === undefined || value === null) return
  const before = Array.isArray(holder[key]) ? holder[key] : propIds(holder[key])
  if (JSON.stringify(before) === JSON.stringify(value)) return
  changed.push({ where, what, from: before.join('、'), to: value.join('、') })
  holder[key] = value
}

// A new name has to reach every sentence that uses the old one, and a model reliably misses some.
const NOT_WORDS = new Set(['id', 'shape', 'stage', 'object', 'gives', 'takes', 'chat', 'undo', 'paint', 'carried'])
function renameEverywhere(value, from, to) {
  if (typeof value === 'string') return value.replaceAll(from, to)
  if (Array.isArray(value)) return value.map(item => renameEverywhere(item, from, to))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, NOT_WORDS.has(key) ? item : renameEverywhere(item, from, to)]))
  return value
}

function writeLines(changed, holder, value, where) {
  if (value === undefined || value === null) return
  const before = holder.lines ?? []
  const after = spokenLines(value)
  if (JSON.stringify(before) === JSON.stringify(after)) return
  const say = lines => lines.map(line => `${line.who}：${line.says}`).join(' / ')
  changed.push({ where, what: '台词', from: say(before), to: say(after) })
  if (after.length) holder.lines = after
  else delete holder.lines
}

const beatLabel = (scene, beat) => `${scene.title} · ${beat.objective}`

const EDITS = {
  meta(edit, { next, write }) {
    write(next, 'title', edit.title, '片名', '片名')
    write(next, 'style', edit.style, '美术风格', '风格')
    write(next, 'story', edit.story, '故事', '原文')
  },

  cast(edit, { next, write, changed }) {
    const person = findIn(next.cast, edit.target, '人物')
    for (const [key, what] of Object.entries(CAST_TEXT)) write(person, key, edit[key], person.name, what)
    const name = clean(edit.name)
    if (name && name !== person.name) {
      const old = person.name
      changed.push({ where: old, what: '名字', from: old, to: name })
      next.story = next.story.replaceAll(old, name)
      next.scenes = renameEverywhere(next.scenes, old, name)
      if (next.chapters) next.chapters = renameEverywhere(next.chapters, old, name)
      if (next.truth) next.truth = next.truth.replaceAll(old, name)
      for (const other of next.cast) for (const key of ['look', 'costume', 'personality']) other[key] = clean(other[key]).replaceAll(old, name)
      person.name = name
    }
    if (edit.make_player === true && !person.playable) {
      for (const other of next.cast) Object.assign(other, { playable: other === person, role: other === person ? 'protagonist' : 'supporting' })
      changed.push({ where: person.name, what: '玩家操作的人物', from: '', to: person.name })
    }
  },

  cast_add(edit, { next, changed }) {
    const name = clean(edit.name)
    if (!name || !clean(edit.look) || !clean(edit.costume)) throw new Error('cast_add 要写 name、look 和 costume。')
    if (next.cast.some(person => person.name === name)) throw new Error(`已经有人物“${name}”了，要改他就用 cast。`)
    // The first person into an empty story is who plays, until someone says otherwise.
    const plays = edit.make_player === true || !next.cast.some(person => person.playable)
    if (plays) for (const other of next.cast) Object.assign(other, { playable: false, role: 'supporting' })
    next.cast.push({ id: nextId(next.cast, 'c'), name, role: plays ? 'protagonist' : 'supporting', age: clean(edit.age), look: clean(edit.look), costume: clean(edit.costume), personality: clean(edit.personality), ...(clean(edit.voice) ? { voice: clean(edit.voice) } : {}), playable: plays })
    changed.push({ where: name, what: '新人物', from: '', to: `${clean(edit.look)} ${clean(edit.costume)}` })
  },

  cast_remove(edit, { next, changed }) {
    const person = findIn(next.cast, edit.target, '人物')
    if (person.playable) throw new Error(`“${person.name}”是玩家操作的人物，不能移除。要换人先用 cast 的 make_player。`)
    next.cast = next.cast.filter(other => other !== person)
    changed.push({ where: person.name, what: '移除人物', from: person.name, to: '' })
  },

  scene(edit, { next, write, changed }) {
    const scene = findIn(next.scenes, edit.target, '场景')
    const oldTitle = scene.title
    for (const [key, what] of Object.entries(SCENE_TEXT)) write(scene, SCENE_KEYS[key] ?? key, edit[key], scene.title, what)
    // The prompts on the way here say its name.
    if (scene.title !== oldTitle) for (const other of next.scenes) for (const exit of other.exits ?? []) if (exit.to === scene.id && exit.prompt) exit.prompt = exit.prompt.replaceAll(oldTitle, scene.title)
    if (scene.exit) for (const [key, what] of Object.entries(EXIT_TEXT)) write(scene.exit, EXIT_KEYS[key] ?? key, edit.exit?.[key], scene.title, what)
    for (const [part, what] of Object.entries(FILM_TEXT)) {
      if (!edit.film?.[part]) continue
      scene.film[part] ??= {}
      for (const key of ['action', 'face', 'sound']) write(scene.film[part], key, edit.film[part][key], scene.title, `${what}${key === 'sound' ? '的声音' : key === 'face' ? '的露脸镜头' : ''}`)
    }
    if (Array.isArray(edit.film?.ending?.face_cast)) writeList(changed, scene.film.ending, 'faceCast', edit.film.ending.face_cast.map(clean).filter(Boolean), scene.title, '结尾露脸镜头里的人物')
    if (edit.film?.ending) writeLines(changed, scene.film.ending, edit.film.ending.lines, `${scene.title} · 结尾`)
  },

  // ---------------------------------------------------------------- chapters, anchors and the map
  chapter(edit, { next, write }) {
    const chapter = findIn(next.chapters, edit.target, '章节')
    write(chapter, 'title', edit.title, chapter.title, '章名')
    write(chapter, 'summary', edit.summary, chapter.title, '这一章讲什么')
  },

  chapter_add(edit, { next, changed }) {
    if (!clean(edit.title)) throw new Error('chapter_add 要写 title。')
    const chapter = { id: nextId(next.chapters, 'ch'), title: clean(edit.title), summary: clean(edit.summary), anchors: [] }
    next.chapters.push(chapter)
    placeAfter(next.chapters, chapter, edit.behind, '章节')
    changed.push({ where: chapter.title, what: '新章节', from: '', to: chapter.summary })
  },

  chapter_remove(edit, { next, changed, reset }) {
    const chapter = findIn(next.chapters, edit.target, '章节')
    if (next.chapters.length === 1) throw new Error('至少要留一章。')
    for (const anchor of [...chapter.anchors]) removeAnchor(next, anchor, reset)
    next.chapters = next.chapters.filter(other => other !== chapter)
    changed.push({ where: chapter.title, what: '移除章节', from: chapter.title, to: '' })
  },

  anchor(edit, { next, write, changed }) {
    const anchor = findIn(anchorsOf(next), edit.target, '锚点')
    write(anchor, 'title', edit.title, anchor.title, '锚点名')
    write(anchor, 'before', edit.before, anchor.title, '之前以为')
    write(anchor, 'happens', edit.happens, anchor.title, '这一刻发生')
    write(anchor, 'after', edit.after, anchor.title, '之后以为')
    if (Array.isArray(edit.needs)) {
      const needs = edit.needs.map(id => findIn(anchorsOf(next), id, '锚点').id)
      if (JSON.stringify(needs) !== JSON.stringify(anchor.needs ?? [])) changed.push({ where: anchor.title, what: '要等哪些锚点', from: (anchor.needs ?? []).join('、'), to: needs.join('、') })
      anchor.needs = needs
    }
  },

  anchor_add(edit, { next, changed, reset }) {
    const chapter = findIn(next.chapters, edit.chapter, '章节')
    if (!clean(edit.title) || !clean(edit.happens)) throw new Error('anchor_add 要写 title 和 happens。')
    const list = anchorsOf(next)
    const anchor = { id: nextId(list, 'a'), title: clean(edit.title), before: clean(edit.before), happens: clean(edit.happens), after: clean(edit.after), needs: [], steps: [] }
    chapter.anchors.push(anchor)
    placeAfter(chapter.anchors, anchor, edit.behind, '锚点')
    const index = chapter.anchors.indexOf(anchor)
    anchor.needs = Array.isArray(edit.needs) ? edit.needs.map(id => findIn(list, id, '锚点').id) : index ? [chapter.anchors[index - 1].id] : []
    for (const raw of Array.isArray(edit.steps) ? edit.steps : []) addStep(next, anchor, raw.scene ?? raw.place, raw.beat ?? raw, anchor.steps.at(-1)?.beat, reset)
    changed.push({ where: chapter.title, what: '新锚点', from: '', to: `${anchor.title}：${anchor.happens}` })
  },

  anchor_remove(edit, { next, changed, reset }) {
    const anchor = findIn(anchorsOf(next), edit.target, '锚点')
    removeAnchor(next, anchor, reset)
    changed.push({ where: anchor.title, what: '移除锚点', from: anchor.title, to: '' })
  },

  anchor_move(edit, { next, changed }) {
    const anchor = findIn(anchorsOf(next), edit.target, '锚点')
    const from = next.chapters.find(chapter => chapter.anchors.includes(anchor))
    const to = clean(edit.chapter) ? findIn(next.chapters, edit.chapter, '章节') : from
    from.anchors = from.anchors.filter(other => other !== anchor)
    to.anchors.push(anchor)
    placeAfter(to.anchors, anchor, edit.behind, '锚点')
    changed.push({ where: anchor.title, what: '锚点顺序', from: '', to: `${to.title}：${to.anchors.map(other => other.title).join(' → ')}` })
  },

  link_add(edit, { next, changed, reset }) {
    const a = findIn(next.scenes, edit.a, '地点')
    const b = findIn(next.scenes, edit.b, '地点')
    if (a === b) throw new Error(`“${a.title}”不能连到它自己。`)
    if (a.exits.some(exit => exit.to === b.id) || b.exits.some(exit => exit.to === a.id)) throw new Error(`“${a.title}”和“${b.title}”之间已经有路了，要改它就用 link。`)
    const link = { opensAfter: clean(edit.opens_after) ? findIn(anchorsOf(next), edit.opens_after, '锚点').id : '', locked: clean(edit.locked) }
    a.exits.push({ ...exitFrom(edit.a_exit, 0, b.id, b.title, link), id: nextId(a.exits, 'x') })
    if (edit.one_way !== true) b.exits.push({ ...exitFrom(edit.b_exit, 0, a.id, a.title, link), id: nextId(b.exits, 'x') })
    reset.add(a.id)
    reset.add(b.id)
    changed.push({ where: '地点图', what: '新的路', from: '', to: `${a.title} — ${b.title}${link.opensAfter ? `（${link.opensAfter} 之后才通）` : ''}` })
  },

  link(edit, { next, write, changed, reset }) {
    const from = findIn(next.scenes, edit.from, '地点')
    const to = findIn(next.scenes, edit.to, '地点')
    const exit = from.exits.find(candidate => candidate.to === to.id)
    if (!exit) throw new Error(`“${from.title}”没有通向“${to.title}”的路。要加路用 link_add。`)
    const where = `${from.title} → ${to.title}`
    for (const [key, what] of [['name', '叫什么'], ['beyond', '走过去看到什么'], ['prompt', '按键提示'], ['locked', '还不通时的一句话']]) write(exit, key, edit[key], where, what)
    if (edit.kind !== undefined && edit.kind !== exit.kind) {
      changed.push({ where, what: '门还是路口', from: exit.kind, to: edit.kind === 'door' ? 'door' : 'opening' })
      exit.kind = edit.kind === 'door' ? 'door' : 'opening'
      reset.add(from.id)
    }
    if (edit.at !== undefined && Number(edit.at) !== exit.at) {
      changed.push({ where, what: '在远端的位置', from: String(exit.at ?? ''), to: String(edit.at) })
      exit.at = Number(edit.at)
      reset.add(from.id)
    }
    if (edit.opens_after !== undefined) {
      const opens = clean(edit.opens_after) ? findIn(anchorsOf(next), edit.opens_after, '锚点').id : ''
      // A road is shut or open from both ends.
      for (const end of [exit, to.exits.find(candidate => candidate.to === from.id)]) {
        if (!end) continue
        if ((end.opensAfter ?? '') !== opens) changed.push({ where, what: '什么时候通', from: end.opensAfter ?? '一开始就通', to: opens || '一开始就通' })
        if (opens) end.opensAfter = opens
        else delete end.opensAfter
      }
    }
  },

  link_remove(edit, { next, changed, reset }) {
    const a = findIn(next.scenes, edit.a, '地点')
    const b = findIn(next.scenes, edit.b, '地点')
    a.exits = a.exits.filter(exit => exit.to !== b.id)
    b.exits = b.exits.filter(exit => exit.to !== a.id)
    reset.add(a.id)
    reset.add(b.id)
    changed.push({ where: '地点图', what: '去掉路', from: `${a.title} — ${b.title}`, to: '' })
  },

  start(edit, { next, changed }) {
    const scene = findIn(next.scenes, edit.scene, '地点')
    if (next.start !== scene.id) changed.push({ where: '地点图', what: '从哪里开始', from: next.scenes.find(other => other.id === next.start)?.title ?? '', to: scene.title })
    next.start = scene.id
  },

  scene_add(edit, { next, changed, added }) {
    if (isWorld(next)) {
      const raw = edit.scene ?? {}
      if (!clean(raw.title) || !clean(raw.place)) throw new Error('新地点要写 title 和 place。')
      if (!clean(raw.opening_action)) throw new Error('新地点要写 opening_action，第一次走进来的开场视频。')
      const place = {
        id: nextId(next.scenes, 's'), title: clean(raw.title), paint: 'relaxed', stage: closeStage({ kind: raw.kind, width: raw.width, depth: raw.depth, exit: 'opening' }), edges: clean(raw.edges), place: clean(raw.place), mood: clean(raw.mood), openingLine: clean(raw.opening_line),
        exits: [], props: [], carried: [], beats: [], objects: [], film: { opening: { action: clean(raw.opening_action), sound: clean(raw.opening_sound) } },
      }
      next.scenes.push(place)
      added.add(place.id)
      changed.push({ where: place.title, what: '新地点', from: '', to: place.place })
      return
    }
    const position = clean(edit.after) ? next.scenes.indexOf(findIn(next.scenes, edit.after, '场景')) + 1 : 0
    const { held, drawnIn } = inHandAfter(next.scenes.slice(0, position))
    const scene = sceneFromAnswer(edit.scene ?? {}, { where: '新场景', sceneId: nextId(next.scenes, 's'), held, drawnIn })
    next.scenes.splice(position, 0, scene)
    added.add(scene.id)
    changed.push({ where: scene.title, what: '新场景', from: '', to: `${scene.beats.length} 步：${scene.beats.map(beat => beat.objective).join('；')}` })
  },

  // A whole scene written again in place, keeping its number, so that rewriting costs one edit and not twenty.
  scene_replace(edit, { next, changed }) {
    if (isWorld(next)) throw new Error('地点和戏是分开的：改这个地方用 scene，改这里发生的事用 beat。')
    const scene = findIn(next.scenes, edit.target, '场景')
    const position = next.scenes.indexOf(scene)
    const { held, drawnIn } = inHandAfter(next.scenes.slice(0, position))
    const made = sceneFromAnswer(edit.scene ?? {}, { where: `重写的“${scene.title}”`, sceneId: scene.id, held, drawnIn })
    next.scenes[position] = made
    changed.push({ where: made.title, what: '整场重写', from: scene.title, to: `${made.beats.length} 步：${made.beats.map(beat => beat.objective).join('；')}` })
  },

  scene_remove(edit, { next, changed }) {
    const scene = findIn(next.scenes, edit.target, '场景')
    next.scenes = next.scenes.filter(other => other !== scene)
    if (isWorld(next)) {
      for (const other of next.scenes) other.exits = other.exits.filter(exit => exit.to !== scene.id)
      for (const anchor of anchorsOf(next)) anchor.steps = (anchor.steps ?? []).filter(step => step.scene !== scene.id)
      if (next.start === scene.id) next.start = next.scenes[0]?.id ?? null
    }
    changed.push({ where: scene.title, what: '移除场景', from: scene.title, to: '' })
  },

  scene_move(edit, { next, changed }) {
    if (isWorld(next)) throw new Error('地点不分先后，先后是锚点的事。改玩家怎么走用 link、link_add、link_remove，改故事顺序用 anchor_move。')
    const scene = findIn(next.scenes, edit.target, '场景')
    placeAfter(next.scenes, scene, edit.after, '场景')
    changed.push({ where: scene.title, what: '场景顺序', from: '', to: next.scenes.map(other => other.title).join(' → ') })
  },

  beat(edit, { next, write, changed, reset }) {
    const scene = findIn(next.scenes, edit.scene, '场景')
    const beat = findIn(scene.beats, edit.target, `“${scene.title}”的步骤`)
    const where = beatLabel(scene, beat)
    for (const [key, what] of Object.entries(BEAT_TEXT)) write(beat, BEAT_KEYS[key] ?? key, edit[key], where, what)
    if (clean(edit.object) && clean(edit.object) !== beat.objectName) {
      write(beat, 'objectName', edit.object, where, '互动的东西')
      delete beat.object
      reset.add(scene.id)
    }
    if (edit.gives !== undefined) writeList(changed, beat, 'gives', propIds(edit.gives), where, '得到的道具')
    if (edit.takes !== undefined) writeList(changed, beat, 'takes', propIds(edit.takes), where, '用掉的道具')
    if (Array.isArray(edit.face_cast)) writeList(changed, beat, 'faceCast', edit.face_cast.map(clean).filter(Boolean), where, '露脸镜头里的人物')
    writeLines(changed, beat, edit.lines, where)
  },

  beat_add(edit, { next, changed, reset }) {
    const scene = findIn(next.scenes, edit.scene, '场景')
    const raw = edit.beat ?? {}
    if (isWorld(next)) {
      if (!clean(edit.anchor)) throw new Error('beat_add 要写 anchor：这一步属于哪个锚点。')
      const anchor = findIn(anchorsOf(next), edit.anchor, '锚点')
      const beat = addStep(next, anchor, scene.id, raw, edit.after, reset)
      changed.push({ where: `${anchor.title} · ${scene.title}`, what: '新步骤', from: '', to: `${beat.objective}（${beat.objectName}）` })
      return
    }
    const beat = { id: nextId(scene.beats, 'b'), ...beatFromAnswer(raw), gives: propIds(raw.gives), takes: propIds(raw.takes) }
    scene.beats.push(beat)
    placeAfter(scene.beats, beat, edit.after, '步骤')
    reset.add(scene.id)
    changed.push({ where: scene.title, what: '新步骤', from: '', to: `${beat.objective}（${beat.objectName}）` })
  },

  beat_remove(edit, { next, changed, reset }) {
    const scene = findIn(next.scenes, edit.scene, '场景')
    const beat = findIn(scene.beats, edit.target, `“${scene.title}”的步骤`)
    scene.beats = scene.beats.filter(other => other !== beat)
    for (const anchor of isWorld(next) ? anchorsOf(next) : []) anchor.steps = anchor.steps.filter(step => !(step.scene === scene.id && step.beat === beat.id))
    reset.add(scene.id)
    changed.push({ where: scene.title, what: '移除步骤', from: beat.objective, to: '' })
  },

  beat_move(edit, { next, changed }) {
    const scene = findIn(next.scenes, edit.scene, '场景')
    const beat = findIn(scene.beats, edit.target, `“${scene.title}”的步骤`)
    if (isWorld(next)) {
      const from = anchorsOf(next).find(anchor => anchor.steps.some(step => step.scene === scene.id && step.beat === beat.id))
      const to = clean(edit.anchor) ? findIn(anchorsOf(next), edit.anchor, '锚点') : from
      const step = from.steps.find(other => other.scene === scene.id && other.beat === beat.id)
      from.steps = from.steps.filter(other => other !== step)
      const index = clean(edit.after) ? to.steps.findIndex(other => other.beat === clean(edit.after)) + 1 : 0
      to.steps.splice(index, 0, step)
      changed.push({ where: to.title, what: '步骤顺序', from: '', to: to.steps.map(other => next.scenes.find(place => place.id === other.scene).beats.find(item => item.id === other.beat).objective).join(' → ') })
      return
    }
    placeAfter(scene.beats, beat, edit.after, '步骤')
    changed.push({ where: scene.title, what: '步骤顺序', from: '', to: scene.beats.map(other => other.objective).join(' → ') })
  },

  prop(edit, { next, write, changed }) {
    const id = propIds(edit.id)[0]
    if (!id) throw new Error('prop 没有写 id。')
    const owner = next.scenes.find(scene => scene.props?.some(prop => prop.id === id))
    if (owner) {
      const prop = owner.props.find(other => other.id === id)
      write(prop, 'name', edit.name, `道具 ${prop.name}`, '名字')
      write(prop, 'look', edit.look, `道具 ${prop.name}`, '样子')
      return
    }
    const scene = findIn(next.scenes, edit.scene, '场景')
    ;(scene.props ??= []).push({ id, name: clean(edit.name), look: clean(edit.look) })
    changed.push({ where: scene.title, what: '新道具', from: '', to: clean(edit.name) })
  },

  // What stands in a place: the same changes the set designer can make, with the same limits.
  set(edit, { next, changed, notes, reset }) {
    const scene = findIn(next.scenes, edit.scene, '场景')
    if (!scene.objects?.length) throw new Error(`“${scene.title}”的白模会在应用后自动摆，这一步不用写 set。`)
    const room = applyChanges(scene, Array.isArray(edit.changes) ? edit.changes : [])
    const names = new Map(scene.objects.map(object => [object.id, object.name]))
    const gone = scene.objects.filter(object => !room.objects.some(other => other.id === object.id)).map(object => object.name)
    const made = room.changed.map(id => room.objects.find(object => object.id === id)?.name ?? names.get(id)).filter(Boolean)
    Object.assign(scene, { objects: room.objects, beats: room.beats, stage: room.stage, ...(scene.exits ? { exits: room.exits } : { exit: room.exit }), plainLayout: false })
    reset.add(scene.id)
    notes.push(...room.notes)
    const moved = edit.changes.some(change => change.op === 'stage')
    changed.push({ where: scene.title, what: '白模', from: gone.length ? `移除 ${gone.join('、')}` : '', to: [...new Set(made)].join('、') || (moved ? '这个地方的大小或出口' : '') })
  },

  remake(edit, { remakes }) {
    remakes.push(clean(edit.target))
  },
}

// ---------------------------------------------------------------- what has to hold afterwards
function removeAnchor(next, anchor, reset) {
  for (const step of anchor.steps ?? []) {
    const scene = next.scenes.find(place => place.id === step.scene)
    if (!scene) continue
    scene.beats = scene.beats.filter(beat => beat.id !== step.beat)
    reset.add(scene.id)
  }
  for (const chapter of next.chapters) {
    chapter.anchors = chapter.anchors.filter(other => other !== anchor)
    for (const other of chapter.anchors) other.needs = (other.needs ?? []).filter(id => id !== anchor.id)
  }
  // A road waiting for what is no longer in the story would stay shut for no reason.
  for (const scene of next.scenes) for (const exit of scene.exits ?? []) if (exit.opensAfter === anchor.id) delete exit.opensAfter
}

// A new step, kept with its place and put in its anchor's order.
function addStep(next, anchor, sceneTarget, raw, after, reset) {
  const scene = findIn(next.scenes, sceneTarget, '地点')
  const beat = { id: nextId(scene.beats, 'b'), ...beatFromAnswer(raw), gives: propIds(raw.gives), takes: propIds(raw.takes) }
  if (!beat.objective || !beat.objectName) throw new Error('新步骤要写 objective 和 object。')
  scene.beats.push(beat)
  const at = clean(after) ? anchor.steps.findIndex(step => step.beat === clean(after)) + 1 : 0
  anchor.steps.splice(at, 0, { scene: scene.id, beat: beat.id })
  reset.add(scene.id)
  return beat
}

function inHandAfter(scenes) {
  const held = new Set()
  const drawnIn = new Map()
  for (const scene of scenes) {
    for (const prop of scene.props ?? []) drawnIn.set(prop.id, { ...prop, from: scene.id })
    for (const beat of scene.beats ?? []) {
      for (const id of propIds(beat.takes)) held.delete(id)
      for (const id of propIds(beat.gives)) held.add(id)
    }
  }
  return { held, drawnIn }
}

// Who holds what is worked out again from the steps, so no order of edits can leave it saying something untrue.
function settleProps(scenes) {
  const held = new Set()
  const drawnIn = new Map()
  for (const scene of scenes) {
    scene.carried = [...held].map(id => drawnIn.get(id))
    const own = new Map((scene.props ?? []).filter(prop => !held.has(prop.id)).map(prop => [prop.id, prop]))
    const used = new Set()
    for (const beat of scene.beats) {
      const label = `“${scene.title}”的“${beat.objective}”`
      const takes = propIds(beat.takes)
      const gives = propIds(beat.gives).filter(id => !held.has(id) || takes.includes(id))
      for (const id of takes) {
        if (!held.has(id)) throw new Error(`${label}要用掉道具 ${id}，但这时主角手里没有。手里的是：${[...held].join('、') || '没有东西'}。`)
        held.delete(id)
        used.add(id)
      }
      for (const id of gives) {
        if (!own.has(id) && !drawnIn.has(id)) throw new Error(`${label}给的道具 ${id} 没有定义，先用 prop 写它的名字和样子。`)
        held.add(id)
        used.add(id)
      }
      Object.assign(beat, { takes, gives })
    }
    scene.props = [...own.values()].filter(prop => used.has(prop.id))
    for (const prop of scene.props) drawnIn.set(prop.id, { ...prop, from: scene.id })
  }
}

function bindBeats(scene) {
  const seen = new Set()
  for (const beat of scene.beats) {
    const label = `“${scene.title}”的“${beat.objective}”`
    const object = scene.objects.find(candidate => candidate.id === beat.object && candidate.name === beat.objectName) ?? scene.objects.find(candidate => candidate.name === beat.objectName)
    if (!object) throw new Error(`${label}要用的“${beat.objectName}”不在这个地方。现有的是：${scene.objects.map(other => other.name).join('、')}。要么换成其中一件，要么先用 set 的 add 摆上。`)
    if (shapeOf(object).onTop) throw new Error(`${label}要用的“${object.name}”放在别的东西上面，互动的东西必须立在地上。`)
    // A place the story comes back to can use the same thing again.
    if (seen.has(object.id) && !scene.exits) throw new Error(`“${scene.title}”有两步都用“${object.name}”，每一步要用不同的东西。合并成一步，或者换一件。`)
    seen.add(object.id)
    beat.object = object.id
  }
}

// Only who is listed gets a portrait in the shot, so someone written into it and not listed would never appear.
// A shot this note did not touch is left alone: looking towards someone off screen is fine, and it is not this note's doing.
function checkFaceShot(next, { face, faceCast = [], lines = [] }, label, before) {
  if (before && clean(before.face) === clean(face) && JSON.stringify(before.faceCast ?? []) === JSON.stringify(faceCast) && JSON.stringify(before.lines ?? []) === JSON.stringify(lines)) return
  const problem = linesProblem({ face, faceCast, lines }, next.cast, label)
  if (problem) throw new Error(problem)
  const names = next.cast.map(person => person.name)
  for (const name of faceCast) if (!names.includes(name)) throw new Error(`${label}的露脸镜头里有“${name}”，但人物表里没有他。现有的是：${names.join('、')}。`)
  for (const person of next.cast) {
    if (person.playable || faceCast.includes(person.name)) continue
    if ([person.name, ...person.name.split('·')].some(word => word && clean(face).includes(word))) throw new Error(`${label}的露脸镜头写到了${person.name}，但他不在名单里，这样他不会出现。把他写进 face_cast，或者从镜头里去掉。`)
  }
}

function checkWhole(next, before, reset, drafting) {
  // A story being written starts from nothing and passes through having no scenes. Everything it does have still has to hold.
  // A story with chapters is adjusted from its first stage, when it has neither places nor people yet, and a place on
  // its map can be somewhere nothing happens.
  const world = isWorld(next)
  if (!drafting) {
    if (!next.scenes.length && !world) throw new Error('至少要留一个场景。')
    if (!next.cast.some(person => person.playable) && !(world && !before.cast.length)) throw new Error('没有玩家操作的人物了。')
    if (!clean(next.story)) throw new Error('故事不能是空的。')
  }
  for (const scene of next.scenes) {
    const was = before.scenes.find(other => other.id === scene.id)
    if (!scene.beats.length && !world) throw new Error(`“${scene.title}”一步都没有了。每个场景至少留一步，不要的话就移除这个场景。`)
    if (!clean(scene.title) || !clean(scene.place)) throw new Error(`“${scene.title || scene.id}”缺场景名或环境。`)
    if (!clean(scene.film?.opening?.action) || (!world && !clean(scene.film?.ending?.action))) throw new Error(`“${scene.title}”的开场和结尾视频不能是空的。`)
    for (const beat of scene.beats) {
      const label = `“${scene.title}”的第 ${scene.beats.indexOf(beat) + 1} 步`
      if (!clean(beat.objective) || !clean(beat.objectName)) throw new Error(`${label}缺目标或物件。`)
      if (!clean(beat.action)) throw new Error(`${label}没写视频内容（action）。每次交互都要拍成视频。`)
      const wasBeat = was?.beats.find(other => other.id === beat.id)
      if (wasBeat?.objectName !== beat.objectName && NOT_A_THING.test(beat.objectName)) throw new Error(`${label}的“${beat.objectName}”不能是互动的东西，墙、门、窗和地面摆不出来。换成立在地上的家具或大件。`)
      checkFaceShot(next, beat, label, wasBeat)
    }
    if (!world) checkFaceShot(next, scene.film.ending, `“${scene.title}”结尾`, was?.film?.ending)
  }
  if (world) settleWorld(next)
  else settleProps(next.scenes)
  for (const scene of next.scenes) {
    if (!scene.objects?.length) continue
    bindBeats(scene)
    if (reset.has(scene.id)) scene.objects = settleForFilming(scene, scene.objects)
    // What was already wrong is not this note's doing, and must not stop it.
    const was = new Set(before.scenes.find(other => other.id === scene.id) ? buildStage(before.scenes.find(other => other.id === scene.id)).issues.map(issue => issue.message) : [])
    const problems = buildStage(scene).issues.filter(issue => issue.level === 'error' && !was.has(issue.message))
    if (problems.length) throw new Error(`这样改之后，“${scene.title}”：${problems.map(issue => issue.message).join(' ')}`)
  }
  // Once the story has been written into steps it has to stay something that can be walked from beginning to end.
  if (world && anchorsOf(next).some(anchor => anchor.steps?.length)) {
    const already = new Set(worldProblems(before))
    const fresh = worldProblems(next).filter(problem => !already.has(problem))
    if (fresh.length) throw new Error(`这样改之后走不通了：${fresh.join(' ')}`)
  }
}

// Which steps "make this again" means. Painting the first picture again brings everything built on it along.
function remakeSteps(project, targets) {
  if (!targets.length) return []
  const steps = new Set(buildGraph(project).map(node => node.id))
  return [...new Set(targets.flatMap(target => {
    const [kind, first, second] = target.split(':')
    const found = kind === 'cast' ? [`cast:${first}:face`]
      : kind === 'set' ? [`scene:${first}:a_paint`, `scene:${first}:a_closed`].filter(id => steps.has(id)).slice(0, 1)
        : kind === 'prop' ? [`scene:${first}:prop_${second}`]
          : kind === 'clip' ? [...steps].filter(id => id.startsWith(`scene:${first}:clip:${second}:`))
            : []
    if (!found.length || !found.every(id => steps.has(id))) throw new Error(`没有可以重做的“${target}”。这个故事还没生成到那一步时不用写 remake，内容改了会自动重做。`)
    return found
  }))]
}

// Pure, so what a note may do can be checked without a model. Returns the story as it would be, or throws why not.
export function applyEdits(project, edits, { drafting = false } = {}) {
  if (project.readonly) throw refuse('这个项目是只读的。', 403)
  const next = structuredClone(Object.fromEntries(Object.entries(project).filter(([key]) => !['agent', 'room'].includes(key))))
  const context = { next, changed: [], notes: [], reset: new Set(), added: new Set(), remakes: [] }
  context.write = writer(context.changed)
  for (const edit of edits) {
    const apply = EDITS[edit?.op]
    if (!apply) throw new Error(`没有 ${edit?.op} 这种修改。能用的是：${Object.keys(EDITS).join('、')}。`)
    apply(edit, context)
  }
  checkWhole(next, project, context.reset, drafting)
  const remake = remakeSteps(next, context.remakes)
  return { next, changed: context.changed, notes: context.notes, remake, remakeTargets: context.remakes, needsLayout: isWorld(next) && !next.scenes.some(scene => scene.objects?.length) ? [] : next.scenes.filter(scene => !scene.objects?.length).map(scene => scene.id) }
}

// ---------------------------------------------------------------- what it costs
// The words on screen are in a stage's data, so they are part of what a rendering step's result is hashed from, but
// none of them is ever in the picture. A sentence of narration must not look like a new picture to everything after it.
function whatRenders(node) {
  const { story: { title, opening, ending, lastObjective, items, beats, lastShot, exits = [], ...rest }, ...shape } = node.params.shape
  // Where a way out stands is in the picture. What it says is not.
  const story = exits.length ? { ...rest, exits: exits.map(({ prompt, tooEarly, name, to, opensAfter, ...way }) => way) } : rest
  const steps = beats.map(({ objective, prompt, tooEarly, during, after, speech, ...step }) => step)
  const { speech, ...shot } = lastShot ?? {}
  return JSON.stringify([node.params.op, node.inputs, node.outputs, shape, story, shot, steps])
}

// A new scene has no whitebox yet. For counting, the plain layout has the same number of everything.
export function withLayouts(next) {
  return { ...next, scenes: next.scenes.map(scene => {
    if (scene.objects?.length) return scene
    try {
      return { ...scene, ...fallbackLayout(scene) }
    } catch {
      return scene
    }
  }) }
}

// What is remembered about the steps once this change is in. Nothing here needs running: reading the story is what
// was just done by hand, and these are the results that stay true.
async function recordsAfter(before, result, state) {
  const trial = withLayouts(result.next)
  const nodes = buildGraph(trial)
  const earlier = new Map(buildGraph(before).map(node => [node.id, node]))
  const records = {}
  const stamp = async node => { records[node.id] = { ...(state.nodes[node.id] ?? { log: [], metrics: {} }), finished: true, hash: await inputHash(trial, node), error: null, errorHash: null } }
  for (const node of nodes) {
    if (node.group === 'authoring') {
      // A stage of a story with chapters that has not been reached yet is still to come, whatever was changed before it.
      if (isWorld(before) && !state.nodes[node.id]?.finished) continue
      if (node.kind !== 'layout' || !result.needsLayout.includes(node.sceneId)) await stamp(node)
      continue
    }
    const old = earlier.get(node.id)
    const record = state.nodes[node.id]
    if (node.kind !== 'browser' || !old || !record?.finished || record.hash !== await inputHash(before, old)) continue
    if (whatRenders(old) === whatRenders(node)) await stamp(node)
  }
  for (const id of result.remake) records[id] = { ...(state.nodes[id] ?? {}), hash: null, finished: false, error: null, errorHash: null, external: null, externalHash: null }
  return { records, trial, nodes }
}

export async function planAfter(before, result) {
  const state = await readState(before.id)
  const { records, trial, nodes } = await recordsAfter(before, result, state)
  Object.assign(state.nodes, records)
  const statuses = await nodeStatuses(trial, nodes, state)
  const plan = planFor(nodes, statuses, generationTargets(nodes))
  const redone = new Set(plan.nodes)
  const items = cardsFor(trial, nodes).filter(card => card.steps.some(id => redone.has(id))).map(card => ({ section: card.section.split(' · ')[0], title: card.title }))
  // A story nothing has been made from has nothing to remake. What it would cost then is the first generation, which is
  // asked for on its own page, and never starts because someone agreed to a change of wording.
  const neverMade = !nodes.some(node => ['image', 'video'].includes(node.resource) && state.nodes[node.id]?.finished)
  return { calls: plan.calls, steps: plan.nodes.length, items, nodes: plan.nodes, neverMade }
}

// What has changed is remade anyway. Asking for it as well would be saying "the content stays the same" about something
// that has just been rewritten, so only a request for what would otherwise stay as it is survives.
async function withoutNeedlessRemakes(project, edits) {
  const rest = edits.filter(edit => edit?.op !== 'remake')
  if (rest.length === edits.length || !rest.length) return edits
  const result = applyEdits(project, rest)
  const redone = new Set((await planAfter(project, result)).nodes)
  return edits.filter(edit => edit?.op !== 'remake' || remakeSteps(result.next, [clean(edit.target)]).some(id => !redone.has(id)))
}

// ---------------------------------------------------------------- what the model reads
const WORLD_EDIT_FORMATS = `{ "op": "meta", "title": "片名", "style": "美术风格", "story": "导演写的故事原文，他说要改才改" }
{ "op": "chapter", "target": "ch1", "title": "", "summary": "" }
{ "op": "chapter_add", "behind": "接在哪一章后面，放最前面就留空", "title": "", "summary": "" }
{ "op": "chapter_remove", "target": "ch2" }
{ "op": "anchor", "target": "a1", "title": "", "before": "之前以为", "happens": "这一刻发生", "after": "之后以为", "needs": ["要等哪些同一章的锚点"] }
{ "op": "anchor_add", "chapter": "ch1", "behind": "接在哪个锚点后面，放最前面就留空", "title": "", "before": "", "happens": "", "after": "", "needs": ["a1"], "steps": [{ "scene": "这一步在哪个地方的 id", "objective": "屏幕上的目标", "object": "这个地方的一件东西", "prompt": "", "too_early": "", "during": "", "after": "", "gives": [], "takes": [], "action": "必须写", "face": "", "face_cast": [], "lines": [], "settle": "", "sound": "" }] }
{ "op": "anchor_remove", "target": "a2" }
{ "op": "anchor_move", "target": "a2", "chapter": "挪到哪一章，不挪章就不写", "behind": "接在哪个锚点后面，放最前面就留空" }
{ "op": "cast", "target": "c1", "name": "新名字，所有文字里的旧名字会自动替换", "age": "", "look": "", "costume": "", "personality": "", "voice": "", "make_player": true }
{ "op": "cast_add", "name": "", "age": "", "look": "", "costume": "", "personality": "", "voice": "" }
{ "op": "cast_remove", "target": "c2" }
{ "op": "scene", "target": "s1", "title": "", "edges": "", "place": "", "mood": "", "opening_line": "第一次来时的旁白", "film": { "opening": { "action": "第一次来时的开场视频", "sound": "" } } }
{ "op": "scene_add", "scene": { "title": "", "kind": "indoor 或 outdoor", "width": 12, "depth": 5.8, "edges": "", "place": "", "mood": "", "opening_line": "", "opening_action": "", "opening_sound": "" } }
{ "op": "scene_remove", "target": "s2" }
{ "op": "start", "scene": "s1" }
{ "op": "link_add", "a": "s1", "b": "s2", "a_exit": { "name": "从 a 看这条路是什么", "kind": "door 或 opening", "at": 0.3, "beyond": "走过去看到什么" }, "b_exit": { "name": "", "kind": "", "at": 0.7, "beyond": "" }, "opens_after": "等哪个锚点之后才通，一开始就通就不写", "locked": "还不通时的一句话", "one_way": false }
{ "op": "link", "from": "s1", "to": "s2", "name": "", "kind": "door 或 opening", "at": 0.5, "beyond": "", "prompt": "", "locked": "", "opens_after": "清空就写空字符串，两头一起改" }
{ "op": "link_remove", "a": "s1", "b": "s2" }
{ "op": "beat", "scene": "s1", "target": "b1", "objective": "", "object": "换成这个地方的另一件东西时写它的名字", "prompt": "", "too_early": "", "during": "", "after": "", "gives": [], "takes": [], "action": "", "face": "清空就写空字符串", "face_cast": ["露脸镜头里的人物名"], "lines": [{ "who": "人物全名", "says": "说的话，整个镜头不超过 40 个字" }], "settle": "", "sound": "" }
{ "op": "beat_add", "scene": "s1", "anchor": "a1", "after": "接在这个锚点的哪一步后面，放最前面就留空", "beat": { 格式同 beat，不写 op、scene、target，object 必须是这个地方已有的东西，或者同一次用 set 摆上的 } }
{ "op": "beat_remove", "scene": "s1", "target": "b2" }
{ "op": "beat_move", "scene": "s1", "target": "b2", "anchor": "挪到哪个锚点，不挪就不写", "after": "接在哪一步后面，放最前面就留空" }
{ "op": "prop", "id": "英文小写短词", "scene": "第一次出现在哪里，新道具才要写", "name": "", "look": "" }
{ "op": "set", "scene": "s1", "changes": [
  { "op": "add", "name": "物件名", "x": 0, "z": 0, "on": "放在别的东西上面时写那件东西的名字，否则留空", "look": "材质、颜色、新旧，一句", "parts": [] },
  { "op": "reshape", "target": "物件名", "parts": [], "look": "" },
  { "op": "move", "target": "物件名", "x": 0, "z": 0 },
  { "op": "update", "target": "物件名", "name": "", "look": "" },
  { "op": "remove", "target": "物件名" },
  { "op": "stage", "kind": "indoor 或 outdoor", "width": 12, "depth": 6 }
] }`

const WORLD_RULES = `- 每一步是玩家走到一件东西前触发的一段视频。物件必须是立在地上的完整家具或大件东西，不能是墙、门、窗、地面或人，也不能是另一件东西的一部分。同一件东西可以在不同锚点再用。
- 人物开口说话只能写在露脸镜头里，写进 lines。不露脸的 action 里只有主角的手和背影，不能写别的人物。一个镜头里除主角外最多两个人，一个镜头最多 12 秒，台词加起来不超过 40 个字。
- 一个地方最多 3 个出口，都在远端边界上。两个地方之间只有一条路。
- 一章的最后一个锚点总是最后发生，它的最后一步会慢慢暗到全黑，这一章在那里收住。
- 没有先后关系的锚点不能依赖彼此的内容。要用掉的道具，得到它的锚点必须排在前面。
- 视频和图片里不能有文字。旁白要像人物自己在心里说话，短，具体，不解释。`

const PAGE_NAMES = { story: '故事', chapters: '章节和锚点', cast: '人物', scenes: '地点图', whitebox: '白模', generate: '生成', play: '互动', watch: '观看' }

export const EDIT_FORMATS = `{ "op": "meta", "title": "片名", "style": "美术风格", "story": "完整的新故事原文" }
{ "op": "cast", "target": "c1", "name": "新名字，所有文字里的旧名字会自动替换", "age": "", "look": "", "costume": "", "personality": "", "voice": "", "make_player": true }
{ "op": "cast_add", "name": "", "age": "", "look": "", "costume": "", "personality": "", "voice": "" }
{ "op": "cast_remove", "target": "c2" }
{ "op": "scene", "target": "s1", "title": "", "edges": "", "place": "", "mood": "", "opening_line": "", "ending_line": "", "exit": { "name": "", "beyond": "", "objective": "", "prompt": "", "too_early": "", "during": "", "last_objective": "" }, "film": { "opening": { "action": "", "sound": "" }, "door": { "action": "", "sound": "" }, "ending": { "action": "", "face": "", "face_cast": ["结尾特写里除主角外还有谁"], "lines": [{ "who": "人物全名", "says": "说的话" }], "sound": "" } } }
{ "op": "scene_add", "after": "新场景接在哪一场后面，放最前面就留空", "scene": 场景，格式见下 }
{ "op": "scene_replace", "target": "s2", "scene": 整场重写，格式同 scene_add 的场景 }
{ "op": "scene_remove", "target": "s2" }
{ "op": "scene_move", "target": "s2", "after": "s1，放最前面就留空" }
{ "op": "beat", "scene": "s1", "target": "b1", "objective": "", "object": "换成这个地方的另一件东西时写它的名字", "prompt": "", "too_early": "", "during": "", "after": "", "gives": [], "takes": [], "action": "", "face": "清空就写空字符串", "face_cast": ["露脸镜头里的人物名"], "lines": [{ "who": "人物全名", "says": "说的话，整个镜头不超过 40 个字" }], "settle": "", "sound": "" }
{ "op": "beat_add", "scene": "s1", "after": "b1，放最前面就留空", "beat": { 格式同 beat，不写 op、scene、target，object 必须是这个地方已有的东西，或者同一次用 set 摆上的 } }
{ "op": "beat_remove", "scene": "s1", "target": "b2" }
{ "op": "beat_move", "scene": "s1", "target": "b2", "after": "b1，放最前面就留空" }
{ "op": "prop", "id": "英文小写短词", "scene": "第一次出现在哪一场，新道具才要写", "name": "", "look": "" }
{ "op": "set", "scene": "s1", "changes": [
  { "op": "add", "name": "物件名", "x": 0, "z": 0, "on": "放在别的东西上面时写那件东西的名字，否则留空", "look": "材质、颜色、新旧，一句", "parts": [] },
  { "op": "reshape", "target": "物件名", "parts": [], "look": "" },
  { "op": "move", "target": "物件名", "x": 0, "z": 0 },
  { "op": "update", "target": "物件名", "name": "", "look": "" },
  { "op": "remove", "target": "物件名" },
  { "op": "stage", "kind": "indoor 或 outdoor", "width": 12, "depth": 6, "exit": "door 或 opening", "door_at": 0.5, "exit_name": "", "exit_beyond": "", "exit_objective": "" }
] }`

const SYSTEM = `你是这部互动短片的统筹。导演在任何一步都可以提意见，你把意见落实成对章节、锚点、地点图、剧本、人物、台词、场景和白模的具体修改。你能看画面：要判断某个画面或视频拍得怎么样时，先要来看，不要凭文字猜。声音你听不到。
只改意见涉及的内容和它牵连的内容，其余一个字都不动。牵连的要改全：人物改了去向，结尾和下一场的开头要接得上；情节变了，故事原文也要同步；道具的得到和用掉要对得上。
不要口头答应却不写修改。意见说不清、有几种差别很大的改法，就反问，不写修改。
导演在问问题时（有没有、怎么样、有什么问题、你看看），kind 是 talk：照实回答他问的，看到什么说什么，有问题就一条条说出来，最后可以问要不要改。他没说要改，就不写修改。
只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。`

const sayScene = scene => ({
  id: scene.id, title: scene.title, stage: scene.stage ? { kind: scene.stage.kind, exit: scene.stage.exit, width: scene.stage.width, depth: scene.stage.depth } : undefined,
  edges: scene.edges, place: scene.place, mood: scene.mood, opening_line: scene.openingLine, ending_line: scene.endingLine,
  props: scene.props, ...(scene.exits ? {} : { 手里已有的道具: (scene.carried ?? []).map(prop => prop.id) }),
  ...(scene.exits ? { exits: scene.exits.map(exit => ({ to: exit.to, name: exit.name, kind: exit.kind, at: exit.at, beyond: exit.beyond, opens_after: exit.opensAfter, locked: exit.locked })) } : {}),
  beats: scene.beats.map(beat => ({ id: beat.id, objective: beat.objective, object: beat.objectName, prompt: beat.prompt, too_early: beat.tooEarly, during: beat.during, after: beat.after, gives: propIds(beat.gives), takes: propIds(beat.takes), action: beat.action, face: beat.face, face_cast: beat.faceCast, lines: beat.lines ?? [], settle: beat.settle, sound: beat.sound })),
  ...(scene.exit ? { exit: { name: scene.exit.name, beyond: scene.exit.beyond, objective: scene.exit.objective, prompt: scene.exit.prompt, too_early: scene.exit.tooEarly, during: scene.exit.during, last_objective: scene.exit.lastObjective } } : {}),
  film: scene.film.ending ? (({ faceCast, ...ending }) => ({ ...scene.film, ending: { ...ending, face_cast: faceCast ?? [] } }))(scene.film.ending) : scene.film,
  objects: (scene.objects ?? []).map(object => ({ name: object.name, look: object.look, ...(object.on ? { on: scene.objects.find(other => other.id === object.on)?.name } : { x: object.x, z: object.z }), size: shapeOf(object)?.size })),
})

function remakeList(project) {
  const cards = cardsFor(project, buildGraph(project))
  const names = cards.flatMap(card => {
    if (card.id.startsWith('cast:')) return [`${card.id}（${card.title}的定妆照）`]
    if (card.id.startsWith('set:')) return [`${card.id}（${card.title}的布景，后面的镜头会跟着重拍）`]
    if (card.id.startsWith('prop:')) return [`${card.id}（道具 ${card.title}）`]
    if (card.id.startsWith('clip:')) return [`${card.id}（${card.section.split(' · ')[1]} · ${card.title}）`]
    return []
  })
  return names.length ? names.join('\n') : '还没有生成过任何东西。'
}

// Everything the model is told about a note. What it has been shown is added by whoever shows it.
function userPrompt(project, message, page) {
  const { chat = [], proposal } = project.agent ?? {}
  const history = chat.slice(-HISTORY_SENT)
  const withObjects = project.scenes.filter(scene => scene.objects?.length)
  const world = isWorld(project)
  return `片名：${project.title}
美术风格：${project.style}

${world ? '导演写的故事：' : '故事原文：'}
${project.story}
${world ? `
真相（观众看不到）：
${project.truth ?? ''}

章节和锚点，故事的先后都在这里。每个锚点的 steps 是它拍成的步骤，scene 和 beat 指向下面某个地点里的一步。还没有 steps 就是戏还没写：
${JSON.stringify((project.chapters ?? []).map(chapter => ({ id: chapter.id, title: chapter.title, summary: chapter.summary, anchors: chapter.anchors.map(({ id, title, before, happens, after, needs, steps, where }) => ({ id, title, before, happens, after, needs, where, steps })) })), null, 1)}
` : ''}
人物：
${JSON.stringify(project.cast.map(({ id, name, role, age, look, costume, personality, voice, playable }) => ({ id, name, role, age, look, costume, personality, voice, playable })), null, 1)}

${world ? `地点图，地方不分先后，靠出口相连（exits 的 to 是通向哪里）。从 ${project.start ?? '还没定'} 开始。${project.mapDesign ?? ''}` : '场景，按播放顺序：'}
${JSON.stringify(project.scenes.map(sayScene), null, 1)}
${world ? `
A 有出口通向 B、B 也有出口通向 A，就是一条能来回走的路，从 A 去 C 可以先退回 B 再走。一个地方只有一个出口不算死路。谁手里有什么道具看 gives 和 takes。这个故事能不能从头走到尾，代码已经走过一遍了，不要自己猜：${anchorsOf(project).some(anchor => anchor.steps?.length) ? (worldProblems(project).join(' ') || '走得通。') : '戏还没写，还没走过。'}
导演写的故事是他的原话，情节的改动落在章节、锚点和步骤上。除非他明确要改那段文字，不要写 meta 的 story。
` : ''}${PAGE_NAMES[page] ? `\n导演现在在“${PAGE_NAMES[page]}”这一页，没说别的，意见多半是关于这一块的。\n` : ''}
规矩，新写或改写的内容都要守：
${world ? WORLD_RULES : STORY_RULES}

修改的代价，导演会看到，能不花钱就不花钱：
- 旁白、目标文字、按键提示这些屏幕上的字：不花钱，马上生效。
- 一个步骤的 action、face、lines、settle、sound：重拍这一段视频。要人物开口说话，就写 lines；没有 face 的步骤要同时写 face。
- 不露脸的 action 镜头拍不到别的人物，那段视频不允许出现其他人。要谁露面或说话，只能写进 face、face_cast 和 lines。
- 场景的 place、mood、edges，物件的样子，白模的摆放：重画这一场的布景，这一场的视频全部重拍。
- 主角的 look 或 costume：重画定妆照和走路，全片的视频重拍，最贵。配角的只重画定妆照和露脸镜头。
- 美术风格 style：全片重做。只有导演明确要求换风格时才改。
- remake 只用于导演明确说某个画面或视频没做好、内容不用变的时候。内容改了的东西会自动重做，不要再写 remake。
- 改写结尾的 face 时，最后一句要保留画面慢慢暗到全黑，影片和这一场靠它收住。
- 能用已有的东西和镜头实现，就不要新摆东西、不要新增步骤：动白模要重画整场。比如让配角露面，优先改已有的 face 和 face_cast。

白模的规矩，只有用 set 或新增步骤要摆新东西时才看：
${PART_RULES}
${withObjects.map(scene => `\n“${scene.title}”（${scene.id}）的场地：\n${roomRules(scene)}`).join('\n')}

可以 remake 或要来看的东西：
${remakeList(project)}
film（整部影片，只能看，不能 remake）

${history.length ? `刚才的对话：\n${history.map(line => `${line.role === 'user' ? '导演' : '你'}：${line.text}`).join('\n')}\n\n` : ''}${proposal ? `你上一次提的修改导演还没有应用。kind 是 change 时这次的回答会取代它，如果是在上一次的基础上调整，要把上一次仍然要的修改也写进来：\n${JSON.stringify(proposal.edits)}\n代价：${JSON.stringify(proposal.plan.calls)}\n\n` : project.agent?.redoPending ? '上一次的修改已经应用，内容变了但还没有重新生成。\n\n' : ''}导演说：${message}

输出：
{
  "kind": "change（要改东西）、talk（只回答或反问）、look（要先看画面才能判断）或 go（导演同意了等待中的修改，要现在落实）",
  "reply": "一两句大白话：打算怎么改，或者回答他。修改还没有生效，不要说已经改好了。不要提 JSON、字段名（during、after、action 这些，说“旁白”“视频”）、id、坐标。",
  "edits": [修改，kind 是 talk、look、go 时为空数组],
  "look": ["kind 是 look 时写要看的编号，一次最多 ${MOST_LOOKED_AT} 个，看全片写 film"],
  "regenerate": "kind 是 go 时写：true 表示连画面视频一起重做，false 表示导演说先只改内容"
}
只有导演明确同意（“可以”“就这样”“重拍吧”）才是 go。要调整就是 change，有疑问就是 talk。

edits 里每一项是下面之一，按顺序执行。除 op 和定位用的字段外，只写要改的字段，不改的不要写。target 和 scene 用 id：
${world ? WORLD_EDIT_FORMATS : EDIT_FORMATS}
{ "op": "remake", "target": "上面列出的编号" }

${world ? '新地点的白模会在应用后自动摆，不用写 set。新地点要用 link_add 接到地点图上，否则走不到。' : `scene_add 的场景格式，它的白模会在应用后自动摆，不用写 set：
${SCENE_FORMAT}

新场景的 beats 不写 id。除最后一场外，每一场的结尾要把主角引向下一场。`}`
}

function checkAnswer(project, answer, canLook = true) {
  const reply = clean(answer.reply)
  if (!reply) throw new Error('没有写 reply。')
  if (answer.kind === 'look') {
    if (!canLook) throw new Error('这次已经给你看过画面了，kind 只能是 change、talk 或 go。')
    const look = Array.isArray(answer.look) ? answer.look.map(clean).filter(Boolean).slice(0, MOST_LOOKED_AT) : []
    if (!look.length) throw new Error('kind 是 look，却没有写要看什么。')
    return { reply, look, edits: [] }
  }
  if (answer.kind === 'go') {
    if (!project.agent?.proposal && !project.agent?.redoPending) throw new Error('现在没有等待同意的修改，不能是 go。')
    return { reply, go: { regenerate: answer.regenerate !== false && answer.regenerate !== 'false' }, edits: [] }
  }
  const edits = Array.isArray(answer.edits) ? answer.edits : []
  if (answer.kind === 'change' && !edits.length) throw new Error('kind 是 change，却没有写 edits。要改就写出具体修改；只是回答或反问，kind 写 talk。')
  if (!edits.length) return { reply, edits: [] }
  const result = applyEdits(project, edits)
  if (!result.changed.length && !result.remake.length) throw new Error('这些修改和现在的内容一模一样，什么也没变。')
  return { reply, edits, result }
}

// ---------------------------------------------------------------- checking its own work
// The checks above say whether a change can stand, not whether it does what was asked. That takes reading it again, as
// someone who did not write it. Twice here a shot lost its fade to black while the reply said all was well.
const REVIEW_ROUNDS = 2
const REVIEW_SYSTEM = `你是片场监督，专门挑修改里的错。你不提新想法，只查这份修改有没有把导演的意见落实。只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。`

function reviewUser(project, message, { reply, result }) {
  return `导演的意见：${message}

改之前的故事：
${project.story}

${result.next.story === project.story ? '故事原文没有改。' : `改之后的故事：\n${result.next.story}`}
${isWorld(project) ? `
这部戏的先后在章节和锚点里，导演写的故事原文不用跟着改。实际改动里没有列出的内容，就是和原来一样。a 开头的编号是锚点，“等 a3”是要等那个锚点之后。

改之后的章节和锚点：
${outlineText(result.next)}

改之后的地点图，路能来回走：
${mapText(result.next)}
` : ''}
负责修改的人说：${reply}

实际改动，一条一条：
${JSON.stringify(result.changed, null, 1)}

查这几件事，只报会让观众看到错误的问题，鸡蛋里挑骨头的不要报：
1. 意见要的每件事都有对应的改动吗，还是只在嘴上说了？导演转述的话是意思，台词不必和他的原话一字不差。
2. 改写后的文字有没有丢掉原来有、意见没要求改的东西？比如结尾慢慢暗到全黑、手里的东西、关键的线索和台词。被意见直接要求替换的内容不算丢。
3. 牵连的内容改全了吗：前后场接得上吗，旁白和台词和新情节一致吗？情节变了故事原文才要同步，镜头里的细节和台词措辞不用写进故事原文。
4. 拍得出来吗：不露脸的视频内容里不能出现主角以外的人，要出现就要进露脸镜头；视频里不能有字；人物要说的话要在台词里，不能只写在旁白或视频内容里。

输出 { "ok": true 或 false, "problems": ["每条一句：哪里，什么问题，应该怎样"] }`
}

async function reviewChange({ project, message, answer, provider, signal }) {
  if (!answer.result?.changed.length) return []
  try {
    return await askChecked({
      provider, system: REVIEW_SYSTEM, user: reviewUser(project, message, answer), signal, log: () => {}, progress: () => {},
      check: found => {
        const problems = Array.isArray(found.problems) ? found.problems.map(clean).filter(Boolean) : []
        if (found.ok === false && !problems.length) throw new Error('ok 是 false，却没有写 problems。')
        return found.ok === true ? [] : problems
      },
    })
  } catch (error) {
    if (signal.aborted) throw error
    return [] // A check that could not run says nothing either way, and the person still reads the change.
  }
}

// The answer to a note: looks first if it needs to, then what it writes is read again until it holds up.
async function answerNote({ project, message, provider, signal, images = [], page }) {
  const asked = userPrompt(project, message, page)
  const ask = (user, shown, canLook) => askChecked({ provider, system: SYSTEM, user, images: shown, check: found => checkAnswer(project, found, canLook), signal, log: () => {}, progress: () => {} })
  let shown = images
  let looked = []
  let told = asked
  let answer = await ask(told, shown, !images.length)
  if (answer.look) {
    const { seen, missing } = project.provider === 'mock' ? { seen: [], missing: answer.look } : await picturesOf(project, answer.look)
    shown = seen.map(item => item.url)
    looked = seen.map(item => item.label)
    told = `${asked}

${seen.length ? `附上你要看的画面，按顺序是：${looked.join('；')}。根据真正看到的回答，看不出来就说看不出来。` : ''}${missing.length ? `这些没有真实的画面可看：${missing.join('、')}。` : ''}声音你听不到，不要评论声音。reply 先照实说你看到了什么，回答导演问的。导演只是问问题就是 talk，不写修改；他说了要改才是 change。这一次 kind 不能再是 look。`
    answer = await ask(told, shown, false)
  }
  for (let round = 0; answer.edits.length; round++) {
    const problems = await reviewChange({ project, message, answer, provider, signal })
    if (!problems.length) break
    if (round === REVIEW_ROUNDS) return { ...answer, looked, doubts: problems }
    try {
      answer = await ask(`${told}\n\n你上一次写的修改：\n${JSON.stringify(answer.edits)}\n\n自查发现这些问题，改好后输出完整的回答：\n${problems.map(problem => `- ${problem}`).join('\n')}`, shown, false)
    } catch (error) {
      if (signal.aborted) throw error
      return { ...answer, looked, doubts: problems }
    }
  }
  return { ...answer, looked }
}

async function proposalFrom(project, answer, now) {
  if (!answer.edits.length) return null
  const edits = await withoutNeedlessRemakes(project, answer.edits)
  const result = applyEdits(project, edits)
  const { nodes, ...plan } = await planAfter(project, result)
  return { id: now.toString(36), edits, changed: result.changed, notes: result.notes, needsLayout: result.needsLayout, remakes: result.remakeTargets, plan, ...(answer.doubts?.length ? { doubts: answer.doubts } : {}) }
}

// ---------------------------------------------------------------- the conversation
const agentOf = project => (project.agent ??= { chat: [], proposal: null, undo: null, redoPending: false })
const addLines = (agent, ...lines) => { agent.chat = [...(agent.chat ?? []), ...lines].slice(-HISTORY_KEPT) }

export async function hearNote({ id, message, provider, signal, page }) {
  const project = await readProject(id)
  let answer
  try {
    answer = await answerNote({ project, message, provider, signal, page })
  } catch (error) {
    if (signal.aborted) throw error
    answer = { failed: true, reply: `这次没改成，什么都没动。${String(error.message).replace(/^模型连续 \d+ 轮都没给出合格的结果：/, '')}`, edits: [] }
  }
  // Read again: the page may have saved something in the time the model took.
  const latest = await readProject(id)
  const agent = agentOf(latest)
  const now = Date.now()
  const proposal = await proposalFrom(project, answer, now)
  // A new change replaces what was waiting. A question, or a note that came to nothing, leaves it where it is.
  if (proposal) agent.proposal = proposal
  // Saying yes to a correction is not a new note, so it does not start the count of corrections again.
  if (!answer.go) agent.selfFixes = 0
  // What is about to happen is what is written in the change. Seen on the real model: "yes" answered with a lantern that was not in it.
  const makesNothing = latest.agent?.proposal?.plan.neverMade
  const said = !answer.go ? answer.reply : makesNothing ? '好，改好了。这个故事还没开始生成，不花钱，生成要你在生成页确认。' : answer.go.regenerate ? '好，就按上面这条修改开始做。' : '好，先只改内容，画面和视频之后再重做。'
  addLines(agent, { role: 'user', text: message, at: now }, { role: 'agent', text: said, at: now, failed: Boolean(answer.failed), proposalId: proposal?.id, ...(answer.looked?.length ? { looked: answer.looked } : {}) })
  await writeProject(latest)
  // Not kept: "go" is what this one sentence meant, and whoever called acts on it now.
  return answer.go ? Object.assign(latest, { go: answer.go }) : latest
}

// ---------------------------------------------------------------- looking at what was made
// Words can be right and the picture wrong, and only the picture can show it. It looks once a run has finished what it set
// out to do. Words it can put right cost nothing; anything that would be paid for again waits for the person to say so.
const MOST_SELF_FIXES = 2
const WATCH_SYSTEM = `你是片场监督，刚拍好的画面摆在你面前，你照实说看到了什么，和要求不一样的地方指出来。画面是不是好看不归你管，只查有没有拍到、人对不对、东西对不对、结尾收没收住。声音你听不到，不要评论。只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。`

function expectedOf(project, nodes, id) {
  if (id === undefined) return ''
  const card = cardsFor(project, nodes).find(candidate => candidate.id === id)
  return (card?.steps ?? []).flatMap(step => {
    const prompt = nodes.find(node => node.id === step && node.kind === 'clipPart')?.params.prompt
    return prompt ? [prompt.slice(0, 400)] : []
  }).join(' / ')
}

export async function lookAtWhatWasMade({ id, startedAt, provider, signal }) {
  const project = await readProject(id)
  const check = project.agent?.pendingCheck
  if (!check || !provider.text) return null
  const state = await readState(id)
  const nodes = buildGraph(project)
  const statuses = await nodeStatuses(project, nodes, state)
  // Stopped or stuck: it waits for the run that does finish.
  if (generationTargets(nodes).some(node => statuses[node] !== 'done')) return null
  const made = new Set(nodes.filter(node => ['image', 'video'].includes(node.resource) && state.nodes[node.id]?.finishedAt >= startedAt).map(node => node.id))
  const cards = cardsFor(project, nodes).filter(card => card.id !== 'film' && card.steps.some(step => made.has(step)))
  const finish = async (line, proposal) => {
    const latest = await readProject(id)
    const agent = agentOf(latest)
    agent.pendingCheck = null
    agent.checking = false
    if (proposal) agent.proposal = proposal
    if (line) addLines(agent, { role: 'agent', at: Date.now(), ...line })
    await writeProject(latest)
    await updateRecords(id, () => {}) // Tells the page.
    return latest
  }
  // A preview's placeholders have nothing in them to look at.
  if (project.provider === 'mock' || !cards.length) return finish(null)
  project.agent.checking = true
  await writeProject(project)
  await updateRecords(id, () => {})
  try {
    const wanted = cards.length > MOST_LOOKED_AT ? ['film'] : cards.map(card => card.id)
    const { seen } = await picturesOf(project, wanted)
    if (!seen.length) return await finish(null)
    const looked = seen.map(item => item.label)
    const images = seen.map(item => item.url)
    const report = await askChecked({
      provider, system: WATCH_SYSTEM, images, signal, log: () => {}, progress: () => {},
      user: `${check.note ? `导演的意见：${check.note}\n\n改动：\n${JSON.stringify(check.changed)}` : `这是第一次做完整部片子。故事：\n${project.story}`}

附上刚做好的画面，按顺序是：
${seen.map((item, index) => `图${index + 1}：${item.label}${item.id ? `。要求：${expectedOf(project, nodes, item.id)}` : ''}`).join('\n')}

输出 { "seen": "一两句大白话：实际看到了什么", "problems": [{ "where": "哪一段", "what": "要求是什么，实际拍成了什么" }] }
只报真正和要求不一样的，没有问题 problems 就是空数组。`,
      check: found => {
        if (!clean(found.seen)) throw new Error('没有写 seen。')
        return { seen: clean(found.seen), problems: (Array.isArray(found.problems) ? found.problems : []).filter(problem => clean(problem?.what)).map(problem => `${clean(problem.where)}：${clean(problem.what)}`) }
      },
    })
    if (!report.problems.length) return await finish({ text: `我看了刚做好的画面：${report.seen}没看到和要求不一样的地方。声音我听不到，这个要你听一下。`, looked })
    const list = report.problems.join('；')
    const fixes = project.agent.selfFixes ?? 0
    if (fixes >= MOST_SELF_FIXES) return await finish({ text: `我看了刚做好的画面，还是不对：${list}。已经连着改了 ${fixes} 次都没拍对，可能不是改文字能解决的，换什么做法你来定。`, looked, failed: true })
    const answer = await answerNote({ project, message: `你检查刚做好的画面，发现这些地方和要求不一样：${list}。写出修改把它们改对，只改这些。`, provider, signal, images })
    const proposal = await proposalFrom(project, answer, Date.now())
    if (!proposal) return await finish({ text: `我看了刚做好的画面，有问题：${list}。${answer.reply}`, looked })
    const latest = await finish({ text: `我看了刚做好的画面，有问题：${list}。${answer.reply}你说可以我就照这个重做。`, looked, proposalId: proposal.id }, proposal)
    agentOf(latest).selfFixes = fixes + 1
    return await writeProject(latest)
  } catch (error) {
    if (signal.aborted) return await finish(null)
    return await finish({ text: `做完后想看一遍画面，但没看成：${error.message}`, failed: true })
  }
}

// A whole run with nothing asked of it is still looked at, against the story.
export function lookWhenFinished(project) {
  agentOf(project).pendingCheck ??= { note: '', changed: [] }
}

// In one step or not at all. What the proposal was checked against may have changed since, so it is checked again.
export async function applyProposal(id) {
  const project = await readProject(id)
  const agent = agentOf(project)
  const { proposal } = agent
  if (!proposal) throw refuse('没有等待应用的修改。')
  let result
  try {
    result = applyEdits(project, proposal.edits)
  } catch (error) {
    agent.proposal = null
    addLines(agent, { role: 'agent', text: `这条修改已经应用不上了，内容在这期间变过：${error.message}`, at: Date.now(), failed: true })
    await writeProject(project)
    throw refuse(`这条修改已经应用不上了：${error.message}`, 409)
  }
  const state = await readState(id)
  const { records } = await recordsAfter(project, result, state)
  const previous = await updateRecords(id, nodes => {
    const replaced = Object.fromEntries(Object.keys(records).map(key => [key, nodes[key] ?? null]))
    Object.assign(nodes, records)
    return replaced
  })
  const saved = Object.fromEntries(STORY_FIELDS.map(field => [field, project[field]]))
  const titleChanged = result.next.title !== project.title
  for (const field of STORY_FIELDS) project[field] = result.next[field]
  if (titleChanged) project.titleLocked = true
  agent.undo = { ...saved, records: previous }
  agent.proposal = null
  agent.redoPending = proposal.plan.steps > 0 && !proposal.plan.neverMade
  const paid = proposal.plan.calls.image > 0 || proposal.plan.calls.video > 0
  if (!proposal.plan.neverMade && (paid || proposal.needsLayout.length)) {
    const note = [...agent.chat].reverse().find(line => line.role === 'user')?.text ?? ''
    agent.pendingCheck = { note, changed: proposal.changed }
  }
  addLines(agent, { role: 'agent', text: `已应用：${[...new Set(proposal.changed.map(line => line.where))].join('、') || '重做所选内容'}。`, at: Date.now(), applied: true, changed: proposal.changed })
  await writeProject(project)
  return { project, needsLayout: result.needsLayout }
}

export async function dismissProposal(id) {
  const project = await readProject(id)
  const agent = agentOf(project)
  if (!agent.proposal) return project
  agent.proposal = null
  addLines(agent, { role: 'agent', text: '好，这条不改了。', at: Date.now() })
  return writeProject(project)
}

// Exact, up to the moment something is made from the change: after that the old pictures are in archive/, not in place.
export async function undoLast(id) {
  const project = await readProject(id)
  const agent = agentOf(project)
  if (!agent.undo) throw refuse('没有可以撤销的修改。')
  const { records, ...saved } = agent.undo
  await updateRecords(id, nodes => {
    for (const [key, record] of Object.entries(records)) {
      if (record) nodes[key] = record
      else delete nodes[key]
    }
  })
  Object.assign(project, saved)
  agent.undo = null
  agent.redoPending = false
  agent.pendingCheck = null
  addLines(agent, { role: 'agent', text: '已撤销上一次修改，内容回到了改之前。', at: Date.now() })
  return writeProject(project)
}

// Once anything is made from the change, or the story is edited by hand, undoing would take those with it.
export function forgetUndo(project) {
  if (project.agent) project.agent.undo = null
}

// What the page needs. The copy kept for undoing is most of a project, and the page never reads it.
export const publicAgent = project => {
  const { undo, pendingCheck, ...agent } = project.agent ?? { chat: [], proposal: null, redoPending: false }
  return { ...agent, canUndo: Boolean(undo) }
}
