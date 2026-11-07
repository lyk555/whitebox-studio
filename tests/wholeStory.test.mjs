import assert from 'node:assert/strict'
import test from 'node:test'
import { breakdownCast, breakdownPlot, breakdownScenes, castOnScreen, fallbackLayout } from '../platform/breakdown.mjs'
import { asWebVtt, captionsFrom } from '../platform/captions.mjs'
import { buildGraph, stageOf } from '../platform/graph.mjs'
import { filmClips } from '../platform/prompts.mjs'
import { linesProblem, speechSeconds, speechTiming } from '../platform/speech.mjs'
import { closeStage } from '../runtime/shell.js'

const quiet = { signal: new AbortController().signal, log: () => {}, progress: () => {} }
const answering = (...answers) => ({ asked: [], async text({ system, user }) {
  if (system.includes('剧本监督')) return JSON.stringify({ ok: true, problems: [] })
  this.asked.push(user)
  return JSON.stringify(answers.length > 1 ? answers.shift() : answers[0])
} })

const places = (count, people = name => [name]) => Array.from({ length: count }, (_, index) => ({ title: `地点${index + 1}`, happens: '发生了事。', people: people(index % 3 === 0 ? '老板' : index % 3 === 1 ? '水手' : '账房'), learned: '知道了下一步。' }))
const wholeCase = {
  type: 'case', story: '一个完整的案子。'.repeat(120),
  case: {
    crime: '账房偷了账本。', culprit: '账房', motive: '欠债',
    suspects: [{ name: '老板', suspected_because: '有钥匙', truth: '只是喝醉了' }, { name: '水手', suspected_because: '在场', truth: '在走私' }, { name: '账房', suspected_because: '管账', truth: '是他' }],
    clues: [1, 2, 3, 4, 5].map(place => ({ clue: `线索${place}`, place, seems: '像老板', means: '是账房', misleading: place === 1 })),
    false_turn: '先认定老板。', deduction: '煤灰加账目。',
  },
  places: [...places(4), { title: '对质', happens: '当面揭晓。', people: ['账房', '老板'], learned: '结案。' }],
}

test('a story comes back whole: a fragment goes back to the model with the reason', async () => {
  const fragment = { ...wholeCase, places: wholeCase.places.slice(0, 2) }
  const model = answering(fragment, wholeCase)
  const { story, plot } = await breakdownPlot({ ...quiet, project: { story: '福尔摩斯探案' }, provider: model })
  assert.match(model.asked[1], /只有 2 个地方，这样只是一个片段/)
  assert.equal(story, wholeCase.story)
  assert.equal(plot.case.culprit, '账房')
  assert.equal(plot.places.length, 5)
})

test('a case has to be a fair case', async () => {
  const fails = async (changed, reason) => {
    const model = answering({ ...wholeCase, case: { ...wholeCase.case, ...changed.case }, ...(changed.places ? { places: changed.places } : {}) }, wholeCase)
    await breakdownPlot({ ...quiet, project: { story: '探案' }, provider: model })
    assert.match(model.asked[1], reason)
  }
  await fails({ case: { suspects: wholeCase.case.suspects.slice(0, 2).concat({ name: '账房' }).slice(1) } }, /只有 2 个嫌疑人/)
  await fails({ case: { clues: wholeCase.case.clues.slice(0, 3) } }, /只有 3 条线索/)
  await fails({ case: { clues: wholeCase.case.clues.map(clue => ({ ...clue, misleading: false })) } }, /错误方向/)
  await fails({ case: { false_turn: '' } }, /判断失误/)
  await fails({ places: wholeCase.places.map(place => ({ ...place, people: place.people.filter(name => name !== '账房') })) }, /不在|没有在任何地方露面/)
  // Met only at the reveal is not fair on anyone watching.
  await fails({ places: [...wholeCase.places.slice(0, 4).map(place => ({ ...place, people: ['老板', '水手'] })), wholeCase.places[4]] }, /只在揭晓时才露面/)
})

test('what the person wrote cannot get shorter, and a long story is not padded out with places', async () => {
  const long = '她推开门。'.repeat(200)
  const model = answering({ type: 'other', story: '她推开门。', places: places(1) }, { type: 'other', story: long, places: places(1) })
  const { plot } = await breakdownPlot({ ...quiet, project: { story: long }, provider: model })
  assert.match(model.asked[1], /比原文.*还短/)
  assert.equal(plot.places.length, 1)
})

test('every fault goes back at once, and a name with an alias in brackets is the same person', async () => {
  const model = answering({ ...wholeCase, case: { ...wholeCase.case, clues: wholeCase.case.clues.slice(0, 3).map(clue => ({ ...clue, misleading: false })), false_turn: '' } }, wholeCase)
  await breakdownPlot({ ...quiet, project: { story: '探案' }, provider: model })
  assert.match(model.asked[1], /判断失误/)
  assert.match(model.asked[1], /只有 3 条线索/)
  assert.match(model.asked[1], /错误方向/)
  const aliased = answering({ ...wholeCase, case: { ...wholeCase.case, suspects: wholeCase.case.suspects.map(suspect => ({ ...suspect, name: suspect.name === '水手' ? '水手（老麦）' : suspect.name })) } })
  const { plot } = await breakdownPlot({ ...quiet, project: { story: '探案' }, provider: aliased })
  assert.equal(aliased.asked.length, 1)
  assert.ok(plot.case.suspects.some(suspect => suspect.name === '水手'))
})

test('an outline is not a story', async () => {
  const model = answering({ ...wholeCase, story: '一个完整的案子。'.repeat(20) }, wholeCase)
  await breakdownPlot({ ...quiet, project: { story: '探案' }, provider: model })
  assert.match(model.asked[1], /这是提纲不是故事/)
})

test('without a key the story is kept as it is', async () => {
  assert.deepEqual(await breakdownPlot({ ...quiet, project: { story: '一个故事' }, provider: {} }), { story: '一个故事', plot: null })
})

test('everyone the story puts on screen has to be in the cast', async () => {
  const person = { name: '福尔摩斯', role: 'protagonist', look: '瘦', costume: '风衣' }
  const model = answering({ cast: [person] }, { cast: [person, { ...person, name: '账房先生', role: 'supporting' }] })
  const { cast } = await breakdownCast({ ...quiet, project: { story: '故事', plot: { places: [{ people: ['账房'] }] } }, provider: model })
  assert.match(model.asked[1], /账房不在 cast 里/)
  assert.equal(cast.length, 2)
})

// ---------------------------------------------------------------- written one place at a time
const people = [{ id: 'c1', name: '福尔摩斯', playable: true }, { id: 'c2', name: '老板', playable: false }]
const written = (title, beat = {}) => ({
  title, place: `${title}，灰墙。`, stage: { kind: 'indoor', exit: 'door', width: 10, depth: 4.9 },
  beats: [
    { objective: '问话', object: '吧台', action: '手按在吧台上。', face: '老板抬头。', face_cast: ['老板'], lines: [{ who: '福尔摩斯', says: '那晚你在哪？' }, { who: '老板', says: '早关门了。' }], ...beat },
    { objective: '看账', object: '账本架', action: '手翻账本。' },
  ],
  film: { opening: { action: '走进来。' }, door: { action: '推门。' }, ending: { action: '走出去。' } },
})
const plotted = { story: '故事', cast: people, plot: { type: 'other', places: [{ title: '酒馆', happens: '问话。', people: ['老板'], learned: '去码头。' }, { title: '码头', happens: '找线索。', people: [], learned: '结束。' }] } }

test('each place is written by itself, in order, and told what comes next', async () => {
  const model = answering({ scene: written('酒馆') }, { scene: { ...written('码头', { face: '', face_cast: [], lines: [] }) } })
  const scenes = await breakdownScenes({ ...quiet, project: plotted, provider: model })
  assert.deepEqual(scenes.map(scene => scene.id), ['s1', 's2'])
  assert.match(model.asked[0], /引向下一个地方“码头”/)
  assert.match(model.asked[1], /这是最后一场/)
  assert.deepEqual(scenes[0].beats[0].lines[1], { who: '老板', says: '早关门了。' })
})

test('someone face to face has to say something, and only someone in the shot can', async () => {
  const silent = answering({ scene: written('酒馆', { lines: [] }) }, { scene: written('酒馆') }, { scene: written('码头', { face: '', face_cast: [], lines: [] }) })
  await breakdownScenes({ ...quiet, project: plotted, provider: silent })
  assert.match(silent.asked[1], /却没有 lines/)
  const oneSided = answering({ scene: written('酒馆', { lines: [{ who: '老板', says: '我早关门了。' }, { who: '老板', says: '别问了。' }] }) }, { scene: written('酒馆') }, { scene: written('码头', { face: '', face_cast: [], lines: [] }) })
  await breakdownScenes({ ...quiet, project: plotted, provider: oneSided })
  assert.match(oneSided.asked[1], /只有老板一个人在说/)
  const wrongSpeaker = answering({ scene: written('酒馆', { lines: [{ who: '华生', says: '喂。' }, { who: '老板', says: '嗯。' }] }) }, { scene: written('酒馆') }, { scene: written('码头', { face: '', face_cast: [], lines: [] }) })
  await breakdownScenes({ ...quiet, project: plotted, provider: wrongSpeaker })
  assert.match(wrongSpeaker.asked[1], /是“华生”说的/)
  const absent = answering({ scene: written('酒馆', { face: '', face_cast: [], lines: [] }) }, { scene: written('酒馆') }, { scene: written('码头', { face: '', face_cast: [], lines: [] }) })
  await breakdownScenes({ ...quiet, project: plotted, provider: absent })
  assert.match(absent.asked[1], /老板要在这里露面/)
})

test('a place that fails does not leave its props behind for the next try', async () => {
  const gives = { gives: ['key'] }
  const withProp = over => ({ scene: { ...written('酒馆', over), props: [{ id: 'key', name: '钥匙', look: '铜' }] } })
  const model = answering(withProp({ ...gives, lines: [] }), withProp(gives), { scene: written('码头', { face: '', face_cast: [], lines: [], takes: ['key'] }) })
  const scenes = await breakdownScenes({ ...quiet, project: plotted, provider: model })
  assert.deepEqual(scenes[1].beats[0].takes, ['key'])
  assert.deepEqual(scenes[1].carried.map(prop => prop.id), ['key'])
})

test('a wall or a door is not a thing to walk up to', async () => {
  const model = answering({ scene: written('酒馆', { object: '仓库后门' }) }, { scene: written('酒馆') }, { scene: written('码头', { face: '', face_cast: [], lines: [] }) })
  await breakdownScenes({ ...quiet, project: plotted, provider: model })
  assert.match(model.asked[1], /“仓库后门”不能是互动的东西/)
})

const casePlot = { ...plotted, cast: [...people, { id: 'c3', name: '账房', playable: false }], plot: { type: 'case', case: wholeCase.case, places: [{ title: '酒馆', happens: '问话。', people: ['老板'], learned: '去对质。' }, { title: '对质', happens: '揭晓。', people: ['老板'], learned: '结案。' }] } }

test('the reveal is said out loud by whoever worked it out', async () => {
  const oneLine = { scene: written('对质') }
  const twoLines = { scene: written('对质', { lines: [{ who: '福尔摩斯', says: '煤灰不对。' }, { who: '老板', says: '你胡说。' }, { who: '福尔摩斯', says: '账目也不对。' }] }) }
  const model = answering({ scene: written('酒馆') }, oneLine, twoLines)
  await breakdownScenes({ ...quiet, project: casePlot, provider: model })
  assert.match(model.asked[2], /福尔摩斯要亲口说出推理/)
})

// A provider whose story editor has things to say, and writers who answer in turn.
const withEditor = (reviews, ...answers) => ({
  asked: [], reviewed: [],
  async text({ system, user }) {
    if (system.includes('剧本监督')) { this.reviewed.push(user); return JSON.stringify(reviews.length > 1 ? reviews.shift() : reviews[0]) }
    this.asked.push(user)
    return JSON.stringify(answers.shift())
  },
})
const pier = over => ({ scene: written('码头', { face: '', face_cast: [], lines: [], ...over }) })

test('the whole is read through, and only the place with a problem is written again', async () => {
  const model = withEditor([{ ok: false, problems: [{ place: 2, what: '手帕上的字母观众不知道。' }] }, { ok: true }], { scene: written('酒馆') }, pier(), pier({ objective: '看账，发现字母' }))
  const logged = []
  const scenes = await breakdownScenes({ ...quiet, log: message => logged.push(message), project: plotted, provider: model })
  assert.equal(model.asked.length, 3, 'one place written twice, the other once')
  assert.match(model.asked[2], /手帕上的字母观众不知道/)
  assert.match(model.asked[2], /这一场的上一稿/)
  assert.equal(scenes[1].beats[0].objective, '看账，发现字母')
  assert.equal(model.reviewed.length, 2)
  assert.ok(logged.some(line => line.includes('重写这几场')))
})

test('a change upstream that takes away what a later place needs brings that place along', async () => {
  const givesKey = over => ({ scene: { ...written('酒馆', { gives: ['key'], ...over }), props: [{ id: 'key', name: '钥匙', look: '铜' }] } })
  const model = withEditor([{ ok: false, problems: [{ place: 1, what: '不该有钥匙。' }] }, { ok: true }], givesKey(), pier({ takes: ['key'] }), { scene: written('酒馆') }, pier())
  const logged = []
  const scenes = await breakdownScenes({ ...quiet, log: message => logged.push(message), project: plotted, provider: model })
  assert.equal(model.asked.length, 4)
  assert.deepEqual(scenes[1].beats[0].takes, [])
  assert.ok(logged.some(line => line.includes('前面的场改了')))
})

test('what it still has doubts about is left in the log, and scenes come back all the same', async () => {
  const model = withEditor([{ ok: false, problems: [{ place: 1, what: '还是看不懂。' }] }], { scene: written('酒馆') }, pier(), { scene: written('酒馆') }, { scene: written('酒馆') })
  const logged = []
  const scenes = await breakdownScenes({ ...quiet, log: message => logged.push(message), project: plotted, provider: model })
  assert.equal(scenes.length, 2)
  assert.ok(logged.some(line => line.includes('留给你判断') && line.includes('还是看不懂')))
})

test('a read-through that cannot run does not stop the scenes', async () => {
  const answers = [{ scene: written('酒馆') }, pier()]
  const model = { async text({ system }) { if (system.includes('剧本监督')) throw new Error('断了'); return JSON.stringify(answers.shift()) } }
  const scenes = await breakdownScenes({ ...quiet, project: plotted, provider: model })
  assert.equal(scenes.length, 2)
})

test('someone never on screen is not given a face to pay for', async () => {
  const scenes = [{ beats: [{ faceCast: ['老板'] }], film: { ending: {} } }]
  const cast = [{ name: '福尔摩斯', playable: true }, { name: '老板' }, { name: '头目' }]
  assert.deepEqual(castOnScreen(cast, scenes).map(person => person.name), ['福尔摩斯', '老板'])
})

// ---------------------------------------------------------------- saying it
const lines = [{ who: '福尔摩斯', says: '那晚你在哪？' }, { who: '老板', says: '早关门了。' }]

test('a shot is as long as its lines take, within what the model can make', () => {
  assert.equal(speechSeconds([{ who: 'a', says: '嗯。' }]), 5)
  assert.ok(speechSeconds(lines) >= 5)
  assert.equal(speechSeconds([{ who: 'a', says: '话'.repeat(200) }]), 12)
  const timed = speechTiming(lines, 5)
  assert.equal(timed[0].from, 5)
  assert.equal(timed[0].to, timed[1].from)
  assert.equal(timed[0].text, '福尔摩斯：那晚你在哪？')
})

test('lines too long for a shot, or with no face to say them, are sent back', () => {
  const cast = people
  assert.match(linesProblem({ face: '', lines }, cast, '这步'), /没有露脸镜头/)
  assert.match(linesProblem({ face: '对视。', faceCast: ['老板'], lines: [{ who: '老板', says: '话'.repeat(60) }] }, cast, '这步'), /1 句共 60 个字.*要删掉 \d+ 个字以上.*老板：话+（60 字）/)
  assert.equal(linesProblem({ face: '对视。', faceCast: ['老板'], lines }, cast, '这步'), null)
})

function sceneWith(beat) {
  const made = { id: 's1', title: '酒馆', paint: 'relaxed', stage: closeStage({ kind: 'indoor', exit: 'door', width: 10, depth: 4.9, doorAt: 0.2 }), place: '酒馆。', mood: '灯。', openingLine: '进来。', endingLine: '走了。', props: [], carried: [], objects: [], edges: '',
    beats: [{ id: 'b1', objective: '问话', objectName: '吧台', prompt: '按 E', tooEarly: '', during: '我走到吧台前。', after: '他在说谎。', gives: [], takes: [], performed: true, action: '手按吧台。', face: '', faceCast: [], settle: '', sound: '', ...beat }],
    exit: { name: '门', beyond: '街', objective: '推门', prompt: '按 E', tooEarly: '', during: '门开了。', lastObjective: '' },
    film: { opening: { action: '进来。', sound: '' }, door: { action: '推门。', sound: '' }, ending: { action: '走出去。', face: '侧脸。', sound: '' } } }
  return { ...made, ...fallbackLayout(made) }
}
const castWithVoice = [{ id: 'c1', name: '福尔摩斯', costume: '风衣', look: '瘦', playable: true, voice: '中年男声，语速快' }, { id: 'c2', name: '老板', costume: '围裙', look: '胖', playable: false }]
const projectOf = scene => ({ id: 'x', title: 'T', story: 'S', style: '写实', provider: 'mock', cast: castWithVoice, scenes: [scene] })
const clipsOf = scene => filmClips(projectOf(scene), scene, stageOf(scene))

test('a shot with lines asks for them to be spoken, in the voice given, and is long enough', () => {
  const scene = sceneWith({ face: '老板抬头。', faceCast: ['老板'], lines })
  const part = clipsOf(scene).find(clip => clip.id === 'b1').parts.find(one => one.showsFace)
  assert.match(part.text, /福尔摩斯（声音：中年男声，语速快）说：“那晚你在哪？”/)
  assert.match(part.text, /老板说：“早关门了。”/)
  assert.match(part.text, /口型和台词对上/)
  assert.doesNotMatch(part.text, /没有人说话/)
  assert.equal(part.duration, speechSeconds(lines))
})

test('a shot without lines asks for exactly what it always did, so nothing already made goes out of date', () => {
  const part = clipsOf(sceneWith({ face: '老板抬头。', faceCast: ['老板'] })).find(clip => clip.id === 'b1').parts.find(one => one.showsFace)
  assert.match(part.text, /没有人说话/)
  assert.equal(part.duration, 4)
  const stage = stageOf(sceneWith({})).data.story
  assert.equal('speech' in stage.beats[0], false)
  assert.equal('speech' in stage.lastShot, false)
})

test('the graph pays for the shot as long as it really is', () => {
  const scene = sceneWith({ face: '老板抬头。', faceCast: ['老板'], lines })
  const nodes = buildGraph(projectOf(scene))
  const shot = nodes.find(node => node.id === 'scene:s1:clip:b1:1')
  assert.equal(shot.seconds, speechSeconds(lines))
})

test('the game has the lines on the clock, and the film has them as subtitles', () => {
  const scene = sceneWith({ face: '老板抬头。', faceCast: ['老板'], lines })
  const game = stageOf(scene).data.story.beats[0].speech
  assert.equal(game[0].from, 5)
  const project = projectOf(scene)
  const order = buildGraph(project).find(node => node.id === 'film').params.clips
  const chapters = order.map((clip, index) => ({ title: clip.title, start: index * 20 }))
  const said = captionsFrom(project, chapters, order.length * 20)
  const texts = said.map(line => line.text)
  for (const expected of ['进来。', '我走到吧台前。', '福尔摩斯：那晚你在哪？', '老板：早关门了。', '他在说谎。', '门开了。', '走了。']) assert.ok(texts.includes(expected), expected)
  assert.ok(said.every(line => line.to > line.from))
  assert.ok(texts.indexOf('我走到吧台前。') < texts.indexOf('福尔摩斯：那晚你在哪？'))
  const vtt = asWebVtt(said)
  assert.match(vtt, /^WEBVTT/)
  assert.match(vtt, /00:00:\d\d\.\d\d\d --> /)
})

test('a chapter list that no longer matches the film says nothing rather than something wrong', () => {
  const project = projectOf(sceneWith({}))
  assert.deepEqual(captionsFrom(project, [{ title: 'x', start: 0 }], 10), [])
})

test('a project read before this step stays as it was read, and a new one writes the story first', () => {
  const old = projectOf(sceneWith({}))
  assert.equal(buildGraph(old).some(node => node.id === 'story:plot'), false)
  assert.equal(buildGraph(old).find(node => node.id === 'story:cast').deps, undefined)
  const fresh = { ...old, premise: null }
  const nodes = buildGraph(fresh)
  assert.deepEqual(nodes.find(node => node.id === 'story:cast').deps, ['story:plot'])
  // The fuller story it leaves behind does not make the step out of date.
  const before = nodes.find(node => node.id === 'story:plot').params
  const after = buildGraph({ ...fresh, premise: fresh.story, story: `${fresh.story}，写完了。` }).find(node => node.id === 'story:plot').params
  assert.deepEqual(after, before)
})
