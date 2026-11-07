// A story with chapters, anchors and a map of places: what it takes to walk it, and what each stage leaves behind.
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import test from 'node:test'
import { arrive, completeStep, dueSteps, exitIsOpen, newProgress, objectiveIn, pathTo, progressBefore, stepKey, walkThrough } from '../runtime/journey.js'
import { closeStage, MOST_WAYS, normalizeStage, shellFrom } from '../runtime/shell.js'
import { applyEdits } from '../platform/agent.mjs'
import { checkClerkAnswer, checkWorldAnswer, dryOutline, dryWorld, filmingProblems, parseOutline, parseScript, placeSteps, reachableAt } from '../platform/authoring.mjs'
import { fallbackLayout, roomRules } from '../platform/breakdown.mjs'
import { buildGraph, stageOf } from '../platform/graph.mjs'
import { filmClips, platePrompts } from '../platform/prompts.mjs'
import { buildStage, shellFor } from '../platform/stage.mjs'
import { heldBefore, planOf, seenBefore, settleWorld, worldProblems } from '../platform/world.mjs'

const CAST = [{ id: 'c1', name: '林默', role: 'protagonist', playable: true, look: '短发', costume: '灰外套' }, { id: 'c2', name: '老周', role: 'supporting', playable: false, look: '秃顶', costume: '蓝工装' }]
const step = (scene, beat, extra = {}) => ({ scene, beat, objective: `做 ${beat}`, gives: [], takes: [], ...extra })

// Two rooms joined by a door that opens after the first anchor; a third place behind a door that opens with the chapter.
const PLAN = {
  start: 's1',
  chapters: [
    { id: 'ch1', title: '一', anchors: [
      { id: 'a1', title: '开头', needs: [], steps: [step('s1', 'b1', { gives: ['key'] })] },
      { id: 'a2', title: '走廊', needs: ['a1'], steps: [step('s2', 'b1')] },
      { id: 'a3', title: '回书房', needs: ['a1'], steps: [step('s1', 'b2')] },
      { id: 'a4', title: '章末', needs: ['a2', 'a3'], steps: [step('s2', 'b2', { takes: ['key'] })] },
    ] },
    { id: 'ch2', title: '二', anchors: [{ id: 'a5', title: '仓库', needs: [], steps: [step('s3', 'b1')] }] },
  ],
  places: {
    s1: { title: '书房', exits: [{ id: 'x1', to: 's2', opensAfter: 'a1' }] },
    s2: { title: '走廊', exits: [{ id: 'x1', to: 's1', opensAfter: 'a1' }, { id: 'x2', to: 's3', opensAfter: 'a4' }] },
    s3: { title: '仓库', exits: [{ id: 'x1', to: 's2', opensAfter: 'a4' }] },
  },
}

test('what is due follows what has been done, and anchors with nothing between them can be taken in either order', () => {
  let progress = newProgress(PLAN)
  assert.deepEqual(dueSteps(PLAN, progress).map(due => due.anchor), ['a1'])
  progress = completeStep(PLAN, progress, 's1', 'b1').progress
  assert.deepEqual(dueSteps(PLAN, progress).map(due => due.anchor), ['a2', 'a3'])
  assert.deepEqual(progress.items, ['key'])
  // The later of the two first.
  progress = completeStep(PLAN, progress, 's1', 'b2').progress
  assert.deepEqual(dueSteps(PLAN, progress).map(due => due.anchor), ['a2'])
  assert.throws(() => completeStep(PLAN, progress, 's2', 'b2'), /还没轮到/)
})

test('a way shut until an anchor is open once it has happened, and only then', () => {
  const exit = PLAN.places.s1.exits[0]
  const start = newProgress(PLAN)
  assert.equal(exitIsOpen(PLAN, start, exit), false)
  assert.equal(pathTo(PLAN, start, 's1', 's2'), null)
  const after = completeStep(PLAN, start, 's1', 'b1').progress
  assert.equal(exitIsOpen(PLAN, after, exit), true)
  assert.deepEqual(pathTo(PLAN, after, 's1', 's2'), ['s2'])
})

test('an exit waiting for an anchor no longer in the story does not stay shut for ever', () => {
  assert.equal(exitIsOpen(PLAN, newProgress(PLAN), { opensAfter: 'gone' }), true)
})

test('finishing a chapter carries the player to where the next one starts', () => {
  let progress = newProgress(PLAN)
  for (const [scene, beat] of [['s1', 'b1'], ['s2', 'b1'], ['s1', 'b2']]) progress = completeStep(PLAN, progress, scene, beat).progress
  const closing = completeStep(PLAN, progress, 's2', 'b2')
  assert.equal(closing.chapterEnded, true)
  assert.equal(closing.storyEnded, false)
  assert.equal(closing.progress.at, 's3')
  const end = completeStep(PLAN, closing.progress, 's3', 'b1')
  assert.equal(end.storyEnded, true)
  assert.deepEqual(end.progress.items, [])
})

test('the objective says what to do here, or where the next thing is', () => {
  const progress = completeStep(PLAN, newProgress(PLAN), 's1', 'b1').progress
  assert.equal(objectiveIn(PLAN, progress, 's2'), '做 b1')
  assert.equal(objectiveIn(PLAN, progress, 's3'), '做 b1（在走廊）')
})

test('walking it through gives the film order, with each opening the first time a place is come to', () => {
  const { film, problems } = walkThrough(PLAN)
  assert.deepEqual(problems, [])
  assert.deepEqual(film.map(shot => stepKey(shot.scene, shot.clip)), ['s1/opening', 's1/b1', 's2/opening', 's2/b1', 's1/b2', 's2/b2', 's3/opening', 's3/b1'])
})

test('a walk says what stops the story being finished', () => {
  const shut = { ...PLAN, places: { ...PLAN.places, s1: { title: '书房', exits: [{ id: 'x1', to: 's2', opensAfter: 'a5' }] } } }
  assert.match(walkThrough(shut).problems.join(), /走不到“走廊”/)
  const island = { ...PLAN, places: { ...PLAN.places, s9: { title: '孤岛', exits: [] } } }
  assert.match(walkThrough(island).problems.join(), /“孤岛”和其他地方都不相连/)
})

test('coming to a place is remembered, so its opening is only the first time', () => {
  const once = arrive(newProgress(PLAN), 's1')
  assert.deepEqual(arrive(once, 's1').seen, ['s1'])
})

// ---------------------------------------------------------------- several ways out of one room
test('a place with several ways out has one for each, spread out, with room kept clear in front of each', () => {
  const shell = shellFrom(closeStage({ width: 12, depth: 5.8, ways: [{ id: 'x1', kind: 'door', at: 0.2 }, { id: 'x2', at: 0.8 }] }))
  assert.equal(shell.exit, 'opening')
  assert.deepEqual(shell.EXITS.map(way => way.id), ['x1', 'x2'])
  assert.deepEqual(shell.EXITS.map(way => way.kind), ['door', 'opening'])
  assert.equal(shell.APPROACHES.length, 2)
  assert.ok(shell.EXITS[1].x > shell.EXITS[0].x + 3)
})

test('two ways out written on top of each other are spread, keeping which is left of which', () => {
  const { ways } = normalizeStage({ ways: [{ id: 'x1', at: 0.5 }, { id: 'x2', at: 0.45 }] })
  assert.ok(Math.abs(ways[0].at - ways[1].at) >= 0.24)
  assert.ok(ways[1].at < ways[0].at)
})

test('no more ways out than fit in the picture', () => {
  const { ways } = normalizeStage({ ways: [{}, {}, {}, {}, {}] })
  assert.equal(ways.length, MOST_WAYS)
})

test('a scene from before the map keeps the one way out it had', () => {
  const shell = shellFrom(closeStage({ width: 10, depth: 4.9, exit: 'door', doorAt: 0.2 }))
  assert.equal(shell.exit, 'door')
  assert.equal(shell.EXITS.length, 1)
  assert.deepEqual(shell.APPROACHES[0], shell.DOOR_APPROACH)
  assert.equal(shell.EXITS[0].anchor.x, shell.DOOR_ANCHOR.x)
})

// ---------------------------------------------------------------- the whole shape, on the dry run
function worldProject() {
  const project = { id: 'test-world', flow: 'chapters', title: '试', story: '第一句。第二句。第三句。第四句。第五句。第六句。', style: '写实', cast: structuredClone(CAST), scenes: [], provider: 'mock', ...dryOutline('第一句。第二句。第三句。第四句。第五句。第六句。') }
  const { design, start, scenes, where } = dryWorld(project)
  Object.assign(project, { mapDesign: design, start, scenes })
  const things = { s1: ['长桌', '书架'], s2: ['木箱', '长凳'], s3: ['货堆', '铁柜'] }
  const list = project.chapters.flatMap(chapter => chapter.anchors)
  list.forEach((anchor, index) => {
    anchor.where = where[anchor.id]
    const scene = project.scenes.find(place => place.id === anchor.where[0])
    const object = things[scene.id][scene.beats.length % 2]
    const beat = { id: `b${scene.beats.length + 1}`, objective: `查看${object}`, objectName: object, prompt: '按 E', tooEarly: '', during: '看', after: '完', performed: true, action: '手碰了碰它。', face: '', faceCast: [], settle: '', sound: '', gives: index === 0 ? ['clue'] : [], takes: index === list.length - 1 ? ['clue'] : [] }
    scene.beats.push(beat)
    if (index === 0) scene.props.push({ id: 'clue', name: '线索', look: '纸条' })
    anchor.steps = [{ scene: scene.id, beat: beat.id }]
  })
  settleWorld(project)
  for (const scene of project.scenes) Object.assign(scene, fallbackLayout(scene))
  return project
}

test('a dry story can be walked from beginning to end, and nothing is wrong with its places', () => {
  const project = worldProject()
  assert.deepEqual(worldProblems(project), [])
  for (const scene of project.scenes) assert.equal(buildStage(scene).ok, true, JSON.stringify(buildStage(scene).issues))
})

test('every way out can be walked to, and the stage says where each leads', () => {
  const project = worldProject()
  const hall = project.scenes.find(scene => scene.id === 's2')
  const { exits } = buildStage(hall).data.story
  assert.deepEqual(exits.map(exit => exit.to), ['s1', 's3'])
  assert.equal(exits[1].opensAfter, project.scenes[1].exits[1].opensAfter)
  assert.equal(exits[0].anchor.yaw, 0)
})

test('something standing in front of one way out, of several, is caught', () => {
  const project = worldProject()
  const hall = project.scenes.find(scene => scene.id === 's2')
  const { x } = shellFor(hall).EXITS[1]
  const wall = { ...hall, objects: [...hall.objects, { id: 'wall', name: '高墙', shape: { size: [3, 3, 1], parts: [] }, x, z: -2.2 }] }
  const said = buildStage(wall).issues.map(issue => issue.message).join()
  assert.match(said, /挡住了“铁门”|走不到“铁门”/)
})

test('a place has an opening and its steps, and no door or ending shot of its own', () => {
  const project = worldProject()
  const study = project.scenes.find(scene => scene.id === 's1')
  const ids = filmClips(project, study, stageOf(study)).map(clip => clip.id)
  assert.ok(ids.includes('opening'))
  assert.ok(!ids.includes('door'))
  assert.ok(!ids.includes('ending'))
})

test('the last step of a chapter runs on to black, with no picture to come back to', () => {
  const project = worldProject()
  const chapter = project.chapters[0]
  const last = chapter.anchors.at(-1).steps.at(-1)
  const scene = project.scenes.find(place => place.id === last.scene)
  assert.equal(scene.beats.find(beat => beat.id === last.beat).endsChapter, true)
  const clip = filmClips(project, scene, stageOf(scene)).find(candidate => candidate.id === last.beat)
  assert.equal(clip.hasLast, false)
  assert.match(clip.parts.at(-1).text, /全黑/)
  assert.equal(stageOf(scene).data.story.beats.find(beat => beat.id === last.beat).isEnding, true)
  // And no other step does.
  const first = chapter.anchors[0].steps[0]
  const firstScene = project.scenes.find(place => place.id === first.scene)
  assert.equal(filmClips(project, firstScene, stageOf(firstScene)).find(candidate => candidate.id === first.beat).hasLast, true)
})

test('the picture is told about every way out, and the room rules about the ground in front of each', () => {
  const project = worldProject()
  const hall = project.scenes.find(scene => scene.id === 's2')
  const prompts = platePrompts(project, hall, stageOf(hall))
  assert.match(prompts.a_paint, /书房的门/)
  assert.match(prompts.a_paint, /铁门/)
  assert.match(prompts.a_paint, /出口一共只有 2 个/)
  assert.match(roomRules(hall), /“铁门”在/)
  assert.match(roomRules(hall), /“书房的门”在/)
})

test('a prop is drawn where it is first handed over and comes along everywhere else', () => {
  const project = worldProject()
  const owner = project.scenes.find(scene => scene.props.some(prop => prop.id === 'clue'))
  assert.equal(owner.id, 's1')
  for (const scene of project.scenes.filter(place => place !== owner)) assert.equal(scene.carried.find(prop => prop.id === 'clue')?.from, 's1')
})

test('the graph makes the text steps in order, and the film in the order of the story', () => {
  const project = worldProject()
  const nodes = buildGraph(project)
  assert.deepEqual(nodes.filter(node => node.kind !== 'layout' && node.group === 'authoring').map(node => node.id), ['story:outline', 'story:cast', 'story:world', 'story:script'])
  assert.deepEqual(nodes.find(node => node.id === 'story:layout:s1').deps, ['story:script'])
  const films = nodes.find(node => node.id === 'film').params.clips.map(clip => clip.file)
  assert.equal(films[0], 'scenes/s1/opening.mp4')
  assert.equal(films.length, new Set(films).size)
  assert.deepEqual(films, walkThrough(planOf(project)).film.map(({ scene, clip }) => `scenes/${scene}/${clip}.mp4`))
})

test('nothing paid for is asked for someone the story does not show', () => {
  const project = worldProject()
  const ids = buildGraph(project).map(node => node.id)
  assert.ok(ids.includes('cast:c1:face'))
  assert.ok(!ids.includes('cast:c2:face'))
})

test('editing what a stage wrote never brings its writer back to write over it', () => {
  const project = worldProject()
  const before = buildGraph(project).filter(node => ['outline', 'cast', 'world', 'script'].includes(node.kind)).map(node => JSON.stringify(node.params))
  const edited = structuredClone(project)
  edited.chapters[0].anchors[0].happens = '完全不同的事'
  edited.scenes[0].place = '完全不同的地方'
  edited.story = '另一个故事'
  assert.deepEqual(buildGraph(edited).filter(node => ['outline', 'cast', 'world', 'script'].includes(node.kind)).map(node => JSON.stringify(node.params)), before)
})

test('a story with no steps yet can have no last anchor to end on', () => {
  const project = worldProject()
  project.chapters[0].anchors[3].needs = []
  settleWorld(project)
  assert.deepEqual(project.chapters[0].anchors[3].needs, ['a1', 'a2', 'a3'])
})

test('what is sure to have been seen and held does not count what could come after', () => {
  const project = worldProject()
  const [a1, a2, a3] = project.chapters[0].anchors
  assert.deepEqual(seenBefore(project, a2).surely.map(anchor => anchor.id), ['a1'])
  assert.deepEqual(seenBefore(project, a2).maybe.map(anchor => anchor.id), ['a3'])
  assert.deepEqual(seenBefore(project, a3).maybe.map(anchor => anchor.id), ['a2'])
  assert.deepEqual([...heldBefore(project, a2)], ['clue'])
  assert.deepEqual([...heldBefore(project, a1)], [])
})

// ---------------------------------------------------------------- reading what the writers wrote
const OUTLINE = `【真相】老周杀了人。
【第 1 章：雨夜】林默接到电话
【锚点 1：电话】之前以为：这是个平常的夜晚；发生：电话响了；之后以为：有人出事了
【锚点 2：酒馆】之前以为：酒保知道内情；发生：酒保撒了谎；之后以为：酒保在包庇
【锚点 3：码头｜等锚点 1】之前以为：码头没人；发生：有脚印；之后以为：有人来过
【锚点 4：对质】之前以为：酒保是凶手；发生：不是他；之后以为：另有其人
【第 2 章：天亮】真相大白
【锚点 5：揭晓】之前以为：另有其人；发生：是老周；之后以为：一切结束了`

test('chapters and anchors are read as the writer wrote them', () => {
  const { truth, chapters } = parseOutline(OUTLINE)
  assert.equal(truth, '老周杀了人。')
  assert.deepEqual(chapters.map(chapter => chapter.anchors.length), [4, 1])
  assert.equal(chapters[0].anchors[0].happens, '电话响了')
  assert.deepEqual(chapters[0].anchors.map(anchor => anchor.id), ['a1', 'a2', 'a3', 'a4'])
  assert.equal(chapters[1].anchors[0].id, 'a5')
})

test('an anchor waits for the one before it, unless it says otherwise', () => {
  const [{ anchors }] = parseOutline(OUTLINE).chapters
  assert.deepEqual(anchors[1].needs, ['a1'])
  assert.deepEqual(anchors[2].needs, ['a1'])
  assert.deepEqual(anchors[0].needs, [])
})

test('an outline that is not one goes back with the reason', () => {
  assert.throws(() => parseOutline('就写一段话。'), /请按格式输出/)
  assert.throws(() => parseOutline('【真相】x\n【第 1 章：一】y'), /没有锚点/)
  assert.throws(() => parseOutline('【真相】x\n【第 1 章：一】y\n【锚点 1：z】乱写一气'), /之前以为/)
  assert.throws(() => parseOutline('【第 1 章：一】y\n【锚点 1：z】之前以为a；发生b；之后以为c'), /真相/)
})

const worldAnswer = () => ({
  design: '从书房到走廊。', start: 1,
  places: [{ title: '书房', kind: 'indoor', width: 10, depth: 4.9, place: '灰墙木地板', opening_action: '后拉' }, { title: '走廊', kind: 'indoor', width: 12, depth: 5.8, place: '灰墙', opening_action: '后拉' }],
  links: [{ a: 1, b: 2, a_exit: { name: '木门', kind: 'door', at: 0.3 }, b_exit: { name: '书房门', kind: 'door', at: 0.7 } }],
  anchors: [{ id: 'a1', places: [1] }, { id: 'a2', places: [2] }],
})
const twoAnchors = () => ({ cast: CAST, chapters: [{ id: 'ch1', title: '一', anchors: [{ id: 'a1', title: '甲', needs: [] }, { id: 'a2', title: '乙', needs: ['a1'] }] }] })

test('a map becomes places with a way out at each end of every road', () => {
  const { scenes, start, where } = checkWorldAnswer(worldAnswer(), twoAnchors())
  assert.equal(start, 's1')
  assert.deepEqual(scenes[0].exits.map(exit => [exit.to, exit.kind]), [['s2', 'door']])
  assert.deepEqual(scenes[1].exits.map(exit => exit.to), ['s1'])
  assert.deepEqual(where, { a1: ['s1'], a2: ['s2'] })
  assert.equal(scenes[0].paint, 'relaxed')
  assert.equal(scenes[0].stage.framing, 'close')
})

test('a one-way road has a way out at only one end', () => {
  const answer = worldAnswer()
  answer.links[0].one_way = true
  const { scenes } = checkWorldAnswer(answer, twoAnchors())
  assert.equal(scenes[0].exits.length, 1)
  assert.equal(scenes[1].exits.length, 0)
})

test('a map that cannot be walked, or filmed, goes back with the reason', () => {
  const shut = worldAnswer()
  shut.links = []
  assert.throws(() => checkWorldAnswer(shut, twoAnchors()), /走不通/)
  const late = worldAnswer()
  late.links[0].opens_after = 'a2'
  assert.throws(() => checkWorldAnswer(late, twoAnchors()), /走不通/)
  const wrongAnchor = worldAnswer()
  wrongAnchor.links[0].opens_after = 'a9'
  assert.throws(() => checkWorldAnswer(wrongAnchor, twoAnchors()), /a9/)
  const crowded = worldAnswer()
  crowded.places.push(...['甲', '乙', '丙'].map(title => ({ title, place: '灰', opening_action: '后拉' })))
  crowded.links.push(...[3, 4, 5].map(b => ({ a: 1, b, a_exit: {}, b_exit: {} })))
  assert.throws(() => checkWorldAnswer(crowded, twoAnchors()), /最多 3 个/)
  const doubled = worldAnswer()
  doubled.links.push(doubled.links[0])
  assert.throws(() => checkWorldAnswer(doubled, twoAnchors()), /两条路/)
})

const SCRIPT = `【书房】
旁白：雨下了一整夜。
主角去做：走到书桌前
旁白：桌上有一封信。
旁白：我没有拆。
主角去做：走到炉子前
旁白：炉火快灭了。
林默：你来多久了？
老周：比你早。
旁白：他没有看我。`

test('a script is cut into steps, and every word on screen comes from it by code', () => {
  const { steps } = parseScript(SCRIPT, '林默')
  assert.equal(steps.length, 2)
  assert.equal(steps[0].place, '书房')
  assert.equal(steps[0].during, '雨下了一整夜。')
  assert.equal(steps[0].after, '桌上有一封信。我没有拆。')
  assert.equal(steps[1].during, '炉火快灭了。')
  assert.deepEqual(steps[1].lines, [{ who: '林默', says: '你来多久了？' }, { who: '老周', says: '比你早。' }])
  assert.equal(steps[1].after, '他没有看我。')
})

test('only what cannot be filmed is held against a script', () => {
  const project = { cast: CAST, scenes: [{ id: 's1', title: '书房' }] }
  const places = project.scenes
  assert.deepEqual(filmingProblems(SCRIPT, project, places), [])
  assert.match(filmingProblems('旁白：空的', project, places).join(), /没有“主角去做”/)
  assert.match(filmingProblems('【地窖】\n主角去做：下去', project, places).join(), /不是现在走得到的地方/)
  assert.match(filmingProblems('【书房】\n老周：先说。\n主角去做：走过去', project, places).join(), /第一个“主角去做”之前/)
  assert.match(filmingProblems('【书房】\n主角去做：走过去\n路人：你好', project, places).join(), /人物表里没有/)
  assert.match(filmingProblems(`【书房】\n主角去做：走过去\n老周：${'说'.repeat(80)}`, project, places).join(), /最多 12 秒/)
})

test('what can be reached by an anchor is what is open by then', () => {
  const project = { start: 's1', scenes: [{ id: 's1', title: '书房', exits: [{ to: 's2' }] }, { id: 's2', title: '走廊', exits: [{ to: 's3', opensAfter: 'a2' }] }, { id: 's3', title: '仓库', exits: [] }], cast: CAST, chapters: [{ id: 'ch1', anchors: [{ id: 'a1', needs: [] }, { id: 'a2', needs: ['a1'] }, { id: 'a3', needs: ['a2'] }] }] }
  const [a1, , a3] = project.chapters[0].anchors
  assert.deepEqual(reachableAt(project, a1).map(scene => scene.id), ['s1', 's2'])
  assert.deepEqual(reachableAt(project, a3).map(scene => scene.id), ['s1', 's2', 's3'])
})

const clerkStep = (extra = {}) => ({ objective: '看', object: '书桌', prompt: '按 E', action: '手碰书桌。', sound: '', gives: [], takes: [], ...extra })
const clerkContext = (steps, held = new Set(), knownProps = []) => ({ project: { cast: CAST }, steps, held, knownProps })

test('the clerk adds what filming needs, and cannot touch the words', () => {
  const steps = [{ place: '书房', doing: '走过去', during: '雨。', after: '停了。', lines: [{ who: '老周', says: '来了？' }] }]
  const { beats } = checkClerkAnswer({ steps: [clerkStep({ face: '老周抬头。', during: '模型自己写的', after: '模型自己写的' })] }, clerkContext(steps))
  assert.equal(beats[0].during, '雨。')
  assert.equal(beats[0].after, '停了。')
  assert.deepEqual(beats[0].lines, steps[0].lines)
  assert.deepEqual(beats[0].faceCast, ['老周'])
  assert.equal(beats[0].performed, true)
})

test('whoever a face shot names is in it, or their portrait would never be shown', () => {
  const steps = [{ place: '书房', doing: '走过去', during: '', after: '', lines: [] }]
  const { beats } = checkClerkAnswer({ steps: [clerkStep({ face: '老周看着门。' })] }, clerkContext(steps))
  assert.deepEqual(beats[0].faceCast, ['老周'])
})

test('a filing that cannot be filmed goes back with the reason', () => {
  const quiet = [{ place: '书房', doing: '走过去', during: '', after: '', lines: [] }]
  assert.throws(() => checkClerkAnswer({ steps: [] }, clerkContext(quiet)), /正好 1 项/)
  assert.throws(() => checkClerkAnswer({ steps: [clerkStep({ object: '木门' })] }, clerkContext(quiet)), /摆不出来/)
  assert.throws(() => checkClerkAnswer({ steps: [clerkStep({ action: '' })] }, clerkContext(quiet)), /没写 action/)
  assert.throws(() => checkClerkAnswer({ steps: [clerkStep({ action: '老周递过来。' })] }, clerkContext(quiet)), /不露脸的镜头里不能有别的人物/)
  assert.throws(() => checkClerkAnswer({ steps: [clerkStep({ takes: ['key'] })] }, clerkContext(quiet)), /手里不一定有/)
  assert.throws(() => checkClerkAnswer({ steps: [clerkStep({ gives: ['key'] })] }, clerkContext(quiet)), /不在 props 里/)
  const talking = [{ place: '书房', doing: '走过去', during: '', after: '', lines: [{ who: '老周', says: '嗯' }] }]
  assert.throws(() => checkClerkAnswer({ steps: [clerkStep()] }, clerkContext(talking)), /要写 face/)
})

test('steps go into the places they happen in, in the anchor\'s order', () => {
  const project = worldProject()
  const anchor = project.chapters[0].anchors[1]
  const study = project.scenes.find(scene => scene.id === 's1')
  const count = study.beats.length
  const beat = { objective: '新', objectName: '长桌', performed: true, action: '手。', gives: ['stamp'], takes: [], during: '', after: '' }
  placeSteps(project, anchor, [{ place: '书房' }], [beat], [{ id: 'stamp', name: '印章', look: '铜' }])
  assert.equal(study.beats.length, count + 1)
  assert.deepEqual(anchor.steps.map(item => item.scene), ['s1'])
  assert.ok(study.props.some(prop => prop.id === 'stamp'))
})

// ---------------------------------------------------------------- the agent
test('the agent can change a chapter and an anchor before there are any places', () => {
  const project = { id: 'test-world', flow: 'chapters', title: '试', story: '故事。', style: '', cast: [], scenes: [], ...dryOutline('故事。') }
  const { next, changed, needsLayout } = applyEdits(project, [{ op: 'chapter', target: 'ch1', title: '新的章名' }, { op: 'anchor', target: 'a1', happens: '不一样的事' }])
  assert.equal(next.chapters[0].title, '新的章名')
  assert.equal(next.chapters[0].anchors[0].happens, '不一样的事')
  assert.equal(changed.length, 2)
  assert.deepEqual(needsLayout, [])
})

test('the agent can add, move and remove anchors, and the chapter still ends on its last', () => {
  const project = { id: 'test-world', flow: 'chapters', title: '试', story: '故事。', style: '', cast: [], scenes: [], ...dryOutline('故事。') }
  const added = applyEdits(project, [{ op: 'anchor_add', chapter: 'ch1', behind: 'a1', title: '新锚点', happens: '发生' }]).next
  const ids = added.chapters[0].anchors.map(anchor => anchor.id)
  assert.equal(ids[1], 'a7')
  assert.deepEqual(added.chapters[0].anchors.at(-1).needs, ids.slice(0, -1))
  const removed = applyEdits(project, [{ op: 'anchor_remove', target: 'a2' }]).next
  assert.ok(!removed.chapters[0].anchors.some(anchor => anchor.id === 'a2'))
  assert.ok(!removed.chapters[0].anchors.some(anchor => anchor.needs.includes('a2')))
})

test('the agent can redraw the map: a new place, a road to it, and when a road opens', () => {
  const project = worldProject()
  const { next, needsLayout } = applyEdits(project, [
    { op: 'scene_add', scene: { title: '屋顶', kind: 'outdoor', width: 12, depth: 5.8, place: '灰色屋顶', opening_action: '后拉' } },
    { op: 'link_add', a: 's1', b: 's4', a_exit: { name: '天窗梯', kind: 'opening', at: 0.88 }, b_exit: { name: '天窗', kind: 'opening', at: 0.5 } },
    { op: 'link', from: 's2', to: 's3', opens_after: 'a1' },
  ])
  assert.deepEqual(next.scenes.find(scene => scene.id === 's1').exits.map(exit => exit.to), ['s2', 's4'])
  assert.deepEqual(next.scenes.find(scene => scene.id === 's4').exits.map(exit => exit.to), ['s1'])
  assert.equal(next.scenes.find(scene => scene.id === 's2').exits.find(exit => exit.to === 's3').opensAfter, 'a1')
  assert.equal(next.scenes.find(scene => scene.id === 's3').exits.find(exit => exit.to === 's2').opensAfter, 'a1')
  assert.deepEqual(needsLayout, ['s4'])
  assert.deepEqual(worldProblems(next), [])
})

test('a change that would leave the story unwalkable is refused, whatever else it does', () => {
  const project = worldProject()
  assert.throws(() => applyEdits(project, [{ op: 'link_remove', a: 's1', b: 's2' }]), /走不通/)
  assert.throws(() => applyEdits(project, [{ op: 'link', from: 's1', to: 's2', opens_after: 'a6' }]), /走不通/)
})

test('a place stays somewhere with no steps, which a scene before the map could not', () => {
  const project = worldProject()
  const { next } = applyEdits(project, [{ op: 'scene_add', scene: { title: '空屋', place: '灰', opening_action: '后拉' } }, { op: 'link_add', a: 's3', b: 's4', a_exit: { at: 0.8 }, b_exit: {} }])
  assert.equal(next.scenes.find(scene => scene.id === 's4').beats.length, 0)
})

test('the agent adds a step to an anchor, and it comes in that anchor\'s order', () => {
  const project = worldProject()
  const { next } = applyEdits(project, [{ op: 'beat_add', scene: 's1', anchor: 'a1', after: 'b1', beat: { objective: '再看一眼', object: '书架', action: '手摸书脊。' } }])
  const anchor = next.chapters[0].anchors[0]
  assert.equal(anchor.steps.length, 2)
  assert.equal(next.scenes[0].beats.find(beat => beat.id === anchor.steps[1].beat).objective, '再看一眼')
})

test('removing a step takes it out of its anchor too', () => {
  const project = worldProject()
  const extra = applyEdits(project, [{ op: 'beat_add', scene: 's1', anchor: 'a1', after: 'b1', beat: { objective: '再看一眼', object: '书架', action: '手摸书脊。' } }]).next
  const added = extra.chapters[0].anchors[0].steps[1]
  const { next } = applyEdits({ ...extra, id: project.id }, [{ op: 'beat_remove', scene: added.scene, target: added.beat }])
  assert.equal(next.chapters[0].anchors[0].steps.length, 1)
})

test('a new name reaches the chapters and the scripts', () => {
  const project = worldProject()
  project.chapters[0].anchors[0].happens = '老周来了'
  project.chapters[0].anchors[0].script = '老周：你好'
  const { next } = applyEdits(project, [{ op: 'cast', target: 'c2', name: '老陈' }])
  assert.equal(next.chapters[0].anchors[0].happens, '老陈来了')
  assert.equal(next.chapters[0].anchors[0].script, '老陈：你好')
})

test('what makes no sense on a map is said to the model plainly', () => {
  const project = worldProject()
  assert.throws(() => applyEdits(project, [{ op: 'scene_move', target: 's2', after: 's1' }]), /地点不分先后/)
  assert.throws(() => applyEdits(project, [{ op: 'beat_add', scene: 's1', beat: { objective: 'x', object: '书架', action: '手' } }]), /属于哪个锚点/)
})

test.after(() => rm('projects/test-world', { recursive: true, force: true }))

test('trying a place out by itself starts where the story first needs it', () => {
  const progress = progressBefore(PLAN, 's3')
  assert.equal(progress.at, 's3')
  assert.deepEqual(dueSteps(PLAN, progress).map(due => due.scene), ['s3'])
  assert.deepEqual(progress.items, [])
})

test('a line said with a note after the name, or a short name, is still said by that person', () => {
  const names = ['林默', '格雷汉姆探长', '汤姆']
  const { steps } = parseScript('【书房】\n主角去做：走过去\n格雷汉姆探长（画外）：站住。\n汤姆（守夜人）：别开枪。\n格雷汉姆：滚。\n主角：等等。', '林默', names)
  assert.deepEqual(steps[0].lines.map(line => line.who), ['格雷汉姆探长', '汤姆', '格雷汉姆探长', '林默'])
})
