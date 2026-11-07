import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { applyEdits, applyProposal, dismissProposal, forgetUndo, hearNote, lookAtWhatWasMade, planAfter, publicAgent, undoLast } from '../platform/agent.mjs'
import { fallbackLayout } from '../platform/breakdown.mjs'
import { adoptNode, nodeStatuses, readState, resetNode, updateRecords } from '../platform/engine.mjs'
import { ffmpeg } from '../platform/ffmpeg.mjs'
import { buildGraph, generationTargets, stageOf } from '../platform/graph.mjs'
import { closeStage } from '../runtime/shell.js'
import { createProject, projectDir, readProject, writeProject } from '../platform/store.mjs'

const box = (x, y, z, w, h, d) => ({ shape: 'box', at: [x, y, z], size: [w, h, d] })

const beat = (id, objective, objectName, extra = {}) => ({ id, objective, objectName, prompt: '按 E', tooEarly: '', during: `${objective}的旁白`, after: '', gives: [], takes: [], performed: true, action: `手碰${objectName}。`, face: '', faceCast: [], settle: '', sound: '', ...extra })

function scene(id, title, beats, props = []) {
  const made = { id, title, paint: 'relaxed', stage: closeStage({ kind: 'indoor', exit: 'door', width: 10, depth: 4.9, doorAt: id === 's1' ? 0.5 : 0.2 }), edges: '砖墙', place: `${title}，灰墙，木地板。`, mood: '一盏灯。', openingLine: `进${title}。`, endingLine: `离开${title}。`, props, carried: [], beats, objects: [],
    exit: { name: '木门', beyond: '走廊', objective: '推门', prompt: '按 E', tooEarly: '', during: '', lastObjective: '' },
    film: { opening: { action: '走进来。', sound: '' }, door: { action: '推门。', sound: '' }, ending: { action: '走出去。', face: '侧脸。', sound: '' } } }
  return { ...made, ...fallbackLayout(made) }
}

const story = (extra = {}) => ({
  id: 'x', title: '测试', story: '华生找到钥匙，用它打开箱子。', style: '写实', provider: 'mock', updatedAt: 1,
  cast: [
    { id: 'c1', name: '福尔摩斯', role: 'protagonist', age: '中年', look: '瘦长脸', costume: '长外套', personality: '敏锐', playable: true },
    { id: 'c2', name: '华生', role: 'supporting', age: '中年', look: '方脸', costume: '短大衣', personality: '可靠', playable: false },
  ],
  scenes: [
    scene('s1', '书房', [beat('b1', '找钥匙', '书桌', { gives: ['key'], during: '华生说过钥匙在这里。' }), beat('b2', '查柜子', '柜子')], [{ id: 'key', name: '钥匙', look: '铜钥匙' }]),
    { ...scene('s2', '码头', [beat('b1', '开箱', '木箱', { takes: ['key'] })]), carried: [{ id: 'key', name: '钥匙', look: '铜钥匙', from: 's1' }] },
  ],
  ...extra,
})

// ---------------------------------------------------------------- what may change
test('a change that passes comes back with exactly what changed, and the original is untouched', () => {
  const project = story()
  const { next, changed } = applyEdits(project, [{ op: 'beat', scene: 's1', target: 'b1', during: '新的旁白。' }, { op: 'cast', target: 'c2', costume: '灰风衣' }])
  assert.equal(next.scenes[0].beats[0].during, '新的旁白。')
  assert.equal(next.cast[1].costume, '灰风衣')
  assert.equal(project.scenes[0].beats[0].during, '华生说过钥匙在这里。')
  assert.equal(project.cast[1].costume, '短大衣')
  assert.deepEqual(changed.map(line => line.what), ['进行时的旁白', '服装'])
  assert.equal(changed[1].from, '短大衣')
  assert.equal(changed[1].to, '灰风衣')
})

test('a field written with what it already says is no change at all', () => {
  assert.equal(applyEdits(story(), [{ op: 'cast', target: 'c2', costume: '短大衣' }]).changed.length, 0)
})

test('a new name reaches every sentence that used the old one, but never an id', () => {
  const project = story()
  project.scenes[1].beats[0].faceCast = ['华生']
  const { next } = applyEdits(project, [{ op: 'cast', target: 'c2', name: '约翰' }])
  assert.equal(next.cast[1].name, '约翰')
  assert.equal(next.story, '约翰找到钥匙，用它打开箱子。')
  assert.equal(next.scenes[0].beats[0].during, '约翰说过钥匙在这里。')
  assert.deepEqual(next.scenes[1].beats[0].faceCast, ['约翰'])
  assert.equal(next.scenes[0].id, 's1')
})

test('someone in a face shot has to be in the cast', () => {
  assert.throws(() => applyEdits(story(), [{ op: 'beat', scene: 's1', target: 'b2', face: '两人对视。', face_cast: ['莫里亚蒂'] }]), /人物表里没有/)
  assert.deepEqual(applyEdits(story(), [{ op: 'beat', scene: 's1', target: 'b2', face: '两人对视。', face_cast: ['华生'] }]).next.scenes[0].beats[1].faceCast, ['华生'])
})

test('someone written into a face shot and not listed would never appear, so it goes back', () => {
  assert.throws(() => applyEdits(story(), [{ op: 'beat', scene: 's1', target: 'b2', face: '华生点头。' }]), /不在名单里/)
  assert.throws(() => applyEdits(story(), [{ op: 'scene', target: 's2', film: { ending: { face: '两人在雾里碰面，华生提着灯。' } } }]), /不在名单里/)
})

test('a shot the note did not touch is left alone, even if it mentions someone off screen', () => {
  const project = story()
  project.scenes[1].film.ending.face = '他望向华生离开的方向。'
  assert.ok(applyEdits(project, [{ op: 'beat', scene: 's1', target: 'b2', during: '新旁白。' }]).changed.length)
})

test('a supporting player can really be in the last shot, and a scene without one keeps its prompt', () => {
  const { next } = applyEdits(story(), [{ op: 'scene', target: 's2', film: { ending: { face: '两人在雾里碰面，华生提着灯。', face_cast: ['华生'] } } }])
  const shot = buildGraph(next).find(node => node.id === 'scene:s2:clip:ending:1')
  assert.deepEqual(shot.inputs, ['cast/c1/plate_face.png', 'cast/c2/plate_face.png'])
  assert.match(shot.params.prompt, /华生的定妆照/)
  const untouched = buildGraph(story()).find(node => node.id === 'scene:s2:clip:ending:1')
  assert.deepEqual(untouched.inputs, ['cast/c1/plate_face.png'])
})

test('the player cannot be removed, and moving the player to someone else is one change', () => {
  assert.throws(() => applyEdits(story(), [{ op: 'cast_remove', target: 'c1' }]), /玩家操作/)
  const { next } = applyEdits(story(), [{ op: 'cast', target: 'c2', make_player: true }])
  assert.deepEqual(next.cast.map(person => [person.playable, person.role]), [[false, 'supporting'], [true, 'protagonist']])
})

test('a prop has to be in hand before it is used, however the steps get moved', () => {
  assert.throws(() => applyEdits(story(), [{ op: 'beat', scene: 's1', target: 'b1', gives: [] }]), /手里没有/)
  assert.throws(() => applyEdits(story(), [{ op: 'scene_move', target: 's2', after: '' }]), /手里没有/)
  assert.throws(() => applyEdits(story(), [{ op: 'beat', scene: 's1', target: 'b2', gives: ['map'] }]), /没有定义/)
})

test('what is carried is worked out again when the steps change', () => {
  const project = story()
  const { next } = applyEdits(project, [
    { op: 'prop', id: 'map', scene: 's1', name: '地图', look: '旧图纸' },
    { op: 'beat', scene: 's1', target: 'b2', gives: ['map'] },
  ])
  assert.deepEqual(next.scenes[0].props.map(prop => prop.id), ['key', 'map'])
  assert.deepEqual(next.scenes[1].carried.map(prop => [prop.id, prop.from]), [['key', 's1'], ['map', 's1']])
})

test('a prop nothing hands over any more is not kept, so nobody pays for a picture of it', () => {
  const project = story()
  const { next } = applyEdits(project, [{ op: 'beat', scene: 's2', target: 'b1', takes: [] }, { op: 'beat', scene: 's1', target: 'b1', gives: [] }])
  assert.deepEqual(next.scenes[0].props, [])
  assert.deepEqual(next.scenes[1].carried, [])
})

test('a new step keeps the ids of the others, so what was filmed for them still belongs to them', () => {
  const { next } = applyEdits(story(), [{ op: 'beat_add', scene: 's1', after: 'b1', beat: { objective: '看柜顶', object: '柜子', action: '手摸柜顶。' } }, { op: 'beat_remove', scene: 's1', target: 'b2' }])
  assert.deepEqual(next.scenes[0].beats.map(item => item.id), ['b1', 'b3'])
  assert.equal(next.scenes[0].beats[1].object, next.scenes[0].objects.find(object => object.name === '柜子').id)
})

test('a step has to use something that is there, and one thing per step', () => {
  assert.throws(() => applyEdits(story(), [{ op: 'beat', scene: 's1', target: 'b2', object: '钢琴' }]), /不在这个地方/)
  assert.throws(() => applyEdits(story(), [{ op: 'beat', scene: 's1', target: 'b2', object: '书桌' }]), /两步都用/)
})

test('a step can use a thing put there by the same change', () => {
  const { next } = applyEdits(story(), [
    { op: 'set', scene: 's1', changes: [{ op: 'add', name: '壁炉', x: -3.5, z: -2, look: '砖砌', parts: [box(0, 0.6, 0, 1.2, 1.2, 0.5)] }] },
    { op: 'beat', scene: 's1', target: 'b2', object: '壁炉' },
  ])
  const made = next.scenes[0].objects.find(object => object.name === '壁炉')
  assert.equal(next.scenes[0].beats[1].object, made.id)
  assert.ok(stageOf(next.scenes[0]).ok)
})

test('a set change that leaves the place unplayable is refused with the reason', () => {
  assert.throws(() => applyEdits(story(), [{ op: 'set', scene: 's1', changes: [{ op: 'remove', target: '书桌' }] }]), /不能移除/)
})

test('what was already wrong in a scene does not stop a note about something else', () => {
  const project = story()
  const desk = project.scenes[0].objects.find(object => object.name === '书桌')
  const cabinet = project.scenes[0].objects.find(object => object.name === '柜子')
  Object.assign(cabinet, { x: desk.x, z: desk.z })
  assert.ok(!stageOf(project.scenes[0]).ok)
  assert.ok(applyEdits(project, [{ op: 'cast', target: 'c2', costume: '灰风衣' }]).changed.length)
})

test('a new scene goes where it was asked for, picks up what is in hand, and waits for its whitebox', () => {
  const { next, needsLayout } = applyEdits(story(), [{ op: 'scene_add', after: 's1', scene: {
    title: '马车', place: '颠簸的车厢，皮座椅，木地板。', mood: '一盏马灯。', stage: { kind: 'indoor', exit: 'opening', width: 10, depth: 4.9 },
    beats: [{ objective: '看窗外', object: '座椅', action: '手扶座椅。' }],
    film: { opening: { action: '上车。' }, ending: { action: '下车。' } },
  } }])
  assert.deepEqual(next.scenes.map(item => item.id), ['s1', 's3', 's2'])
  assert.deepEqual(needsLayout, ['s3'])
  assert.deepEqual(next.scenes[1].carried.map(prop => prop.id), ['key'])
})

test('nothing but known changes gets through, and an empty story cannot be left behind', () => {
  assert.throws(() => applyEdits(story(), [{ op: 'explode' }]), /没有 explode/)
  assert.throws(() => applyEdits(story(), [{ op: 'meta', story: '  ' }]), /故事不能是空的/)
  assert.throws(() => applyEdits(story(), [{ op: 'beat_remove', scene: 's2', target: 'b1' }, { op: 'beat', scene: 's1', target: 'b1', gives: [] }, { op: 'beat', scene: 's1', target: 'b1', action: '' }]), /一步都没有|没写视频内容/)
  assert.throws(() => applyEdits(story({ readonly: true }), []), /只读/)
})

// ---------------------------------------------------------------- what it costs
const ID = 'agent-test'
// Reading its own change back is a call of its own, and these models have no complaints about theirs.
const quietModel = (...answers) => ({ asked: [], async text({ system, user }) {
  if (system.includes('片场监督')) return JSON.stringify({ ok: true, problems: [] })
  this.asked.push(user)
  return answers.length > 1 ? answers.shift() : answers[0]
} })
const signal = new AbortController().signal

// Every step of a story, as if it had been made, with files that are simply there.
async function madeStory(extra = {}) {
  await rm(projectDir(ID), { recursive: true, force: true })
  const project = await createProject({ ...story(extra), id: ID })
  for (const node of buildGraph(project)) {
    for (const file of node.outputs ?? []) {
      const path = join(projectDir(ID), file)
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, node.id)
    }
  }
  // Done in order, since what a step reads has to exist for it to be called done.
  for (const node of buildGraph(project)) await adoptNode(project, node)
  return readProject(ID)
}
const allDone = async project => {
  const nodes = buildGraph(project)
  const statuses = await nodeStatuses(project, nodes, await readState(project.id))
  return nodes.filter(node => statuses[node.id] !== 'done').map(node => node.id)
}

test('a line of narration costs nothing and redoes nothing, even though it sits in what the render steps read', async () => {
  const project = await madeStory()
  assert.deepEqual(await allDone(project), [])
  const plan = await planAfter(project, applyEdits(project, [{ op: 'beat', scene: 's1', target: 'b1', during: '只改一句旁白。' }]))
  assert.deepEqual(plan.calls, { text: 0, image: 0, imageMin: 0, video: 0, videoSeconds: 0 })
  assert.equal(plan.steps, 0)
})

test('changing a shot pays for that shot and re-cuts the film, nothing else', async () => {
  const project = await madeStory()
  const plan = await planAfter(project, applyEdits(project, [{ op: 'beat', scene: 's1', target: 'b2', action: '手拉开柜门。' }]))
  assert.equal(plan.calls.image, 0)
  assert.equal(plan.calls.video, 1)
  assert.deepEqual(plan.items.map(item => item.title), ['查柜子', '整部影片'])
})

test('changing a place repaints that scene and its shots, and leaves the other scene alone', async () => {
  const project = await madeStory()
  const plan = await planAfter(project, applyEdits(project, [{ op: 'scene', target: 's1', mood: '窗外的月光。' }]))
  assert.ok(plan.calls.image >= 1)
  assert.ok(plan.calls.video >= 1)
  assert.ok(plan.items.some(item => item.section === '布景' && item.title === '书房'))
  assert.ok(!plan.items.some(item => item.title === '码头'))
})

test('making something again is one thing on the list, without a word of the story changing', async () => {
  const project = await madeStory()
  const result = applyEdits(project, [{ op: 'remake', target: 'clip:s1:b2' }])
  assert.equal(result.changed.length, 0)
  assert.ok(result.remake.every(id => id.startsWith('scene:s1:clip:b2:')))
  const plan = await planAfter(project, result)
  assert.equal(plan.calls.video, 1)
  assert.throws(() => applyEdits(project, [{ op: 'remake', target: 'clip:s9:b1' }]), /没有可以重做/)
})

test('a new scene is counted before it has a whitebox', async () => {
  const project = await madeStory()
  const plan = await planAfter(project, applyEdits(project, [{ op: 'scene_add', after: 's2', scene: {
    title: '马车', place: '车厢，皮座椅，木地板。', mood: '一盏马灯。', stage: { kind: 'indoor', exit: 'door', width: 10, depth: 4.9 },
    beats: [{ objective: '看窗外', object: '座椅', action: '手扶座椅。' }],
    film: { opening: { action: '上车。' }, door: { action: '开门。' }, ending: { action: '下车。' } },
  } }]))
  assert.ok(plan.items.some(item => item.title === '马车'))
  assert.ok(plan.calls.video > 0)
})

// ---------------------------------------------------------------- the conversation
test('a note comes back as a proposal, and nothing has changed until it is applied', async () => {
  await madeStory()
  const model = quietModel(JSON.stringify({ kind: 'change', reply: '把这句旁白改掉。', edits: [{ op: 'beat', scene: 's1', target: 'b1', during: '改过的旁白。' }] }))
  const waiting = await hearNote({ id: ID, message: '这句旁白太长', provider: model, signal })
  assert.equal(waiting.scenes[0].beats[0].during, '华生说过钥匙在这里。')
  assert.equal(waiting.agent.proposal.plan.steps, 0)
  assert.deepEqual(waiting.agent.chat.map(line => line.role), ['user', 'agent'])
  assert.match(model.asked[0], /这句旁白太长/)
  const { project: applied } = await applyProposal(ID)
  assert.equal(applied.scenes[0].beats[0].during, '改过的旁白。')
  assert.equal(applied.agent.proposal, null)
  assert.deepEqual(await allDone(applied), [], 'still all up to date')
})

test('asking to remake what the same note rewrites is dropped, and a real request to remake something else stays', async () => {
  await madeStory()
  const project = await hearNote({ id: ID, message: '改', provider: quietModel(JSON.stringify({ kind: 'change', reply: '好。', edits: [
    { op: 'beat', scene: 's1', target: 'b2', action: '手拉开柜门。' }, { op: 'remake', target: 'clip:s1:b2' }, { op: 'remake', target: 'clip:s2:b1' },
  ] })), signal })
  const { edits, remakes, plan } = project.agent.proposal
  assert.deepEqual(edits.filter(edit => edit.op === 'remake').map(edit => edit.target), ['clip:s2:b1'])
  assert.deepEqual(remakes, ['clip:s2:b1'])
  assert.equal(plan.calls.video, 2)
  assert.equal(plan.nodes, undefined)
})

test('undo puts back the story and what was remembered about the steps', async () => {
  const before = await madeStory()
  await hearNote({ id: ID, message: '改', provider: quietModel(JSON.stringify({ kind: 'change', reply: '好。', edits: [{ op: 'scene', target: 's1', mood: '月光。' }, { op: 'remake', target: 'cast:c2' }] })), signal })
  const { project: applied } = await applyProposal(ID)
  assert.ok((await allDone(applied)).includes('scene:s1:guides') === false)
  assert.ok((await allDone(applied)).some(id => id === 'cast:c2:face'))
  assert.ok(applied.agent.redoPending)
  const undone = await undoLast(ID)
  assert.equal(undone.scenes[0].mood, before.scenes[0].mood)
  assert.deepEqual(await allDone(undone), [])
  assert.equal(undone.agent.redoPending, false)
  await assert.rejects(undoLast(ID), /没有可以撤销/)
})

test('an answer that fails its checks goes back to the model with the reason', async () => {
  await madeStory()
  const model = quietModel(JSON.stringify({ kind: 'change', reply: '让莫里亚蒂露脸。', edits: [{ op: 'beat', scene: 's1', target: 'b2', face: '对视。', face_cast: ['莫里亚蒂'] }] }), JSON.stringify({ kind: 'change', reply: '让华生露脸。', edits: [{ op: 'beat', scene: 's1', target: 'b2', face: '对视。', face_cast: ['华生'] }] }))
  const project = await hearNote({ id: ID, message: '加个人', provider: model, signal })
  assert.equal(model.asked.length, 2)
  assert.match(model.asked[1], /人物表里没有/)
  assert.equal(project.agent.proposal.edits[0].face_cast[0], '华生')
})

test('saying it will change something without writing the change goes back too, and a question is just answered', async () => {
  await madeStory()
  const model = quietModel(JSON.stringify({ kind: 'change', reply: '好的，改好了。', edits: [] }), JSON.stringify({ kind: 'talk', reply: '要改成什么颜色？', edits: [] }))
  const project = await hearNote({ id: ID, message: '换个颜色', provider: model, signal })
  assert.equal(model.asked.length, 2)
  assert.match(model.asked[1], /没有写 edits/)
  assert.equal(project.agent.proposal, null)
  assert.equal(project.agent.chat.at(-1).text, '要改成什么颜色？')
})

test('when the model cannot get there, the person is told and nothing moves', async () => {
  const before = await madeStory()
  const project = await hearNote({ id: ID, message: '改', provider: quietModel(JSON.stringify({ kind: 'change', reply: '好。', edits: [{ op: 'explode' }] })), signal })
  assert.equal(project.agent.chat.at(-1).failed, true)
  assert.equal(project.agent.proposal, null)
  assert.deepEqual(project.scenes, before.scenes)
})

test('a note that comes to nothing leaves what was waiting where it was', async () => {
  await madeStory()
  await hearNote({ id: ID, message: '第一条', provider: quietModel(JSON.stringify({ kind: 'change', reply: '好。', edits: [{ op: 'cast', target: 'c2', costume: '灰风衣' }] })), signal })
  const project = await hearNote({ id: ID, message: '第二条', provider: quietModel(JSON.stringify({ kind: 'change', reply: '好。', edits: [{ op: 'explode' }] })), signal })
  assert.equal(project.agent.chat.at(-1).failed, true)
  assert.equal(project.agent.proposal.edits[0].costume, '灰风衣')
})

test('a proposal is checked again when applied, since the story may have moved on', async () => {
  await madeStory()
  await hearNote({ id: ID, message: '改', provider: quietModel(JSON.stringify({ kind: 'change', reply: '好。', edits: [{ op: 'beat', scene: 's2', target: 'b1', during: '新旁白。' }] })), signal })
  const project = await readProject(ID)
  project.scenes = project.scenes.filter(item => item.id !== 's2')
  await writeProject(project)
  await assert.rejects(applyProposal(ID), /应用不上/)
  assert.equal((await readProject(ID)).agent.proposal, null)
})

test('a later note replaces what was waiting, and the model is told what that was', async () => {
  await madeStory()
  await hearNote({ id: ID, message: '第一条', provider: quietModel(JSON.stringify({ kind: 'change', reply: '好。', edits: [{ op: 'cast', target: 'c2', costume: '灰风衣' }] })), signal })
  const model = quietModel(JSON.stringify({ kind: 'change', reply: '好。', edits: [{ op: 'cast', target: 'c2', costume: '蓝风衣' }] }))
  const project = await hearNote({ id: ID, message: '换蓝的', provider: model, signal })
  assert.match(model.asked[0], /灰风衣/)
  assert.equal(project.agent.proposal.edits[0].costume, '蓝风衣')
  assert.equal((await dismissProposal(ID)).agent.proposal, null)
})

test('a new scene applied waits for its whitebox, and the steps before it are not read again', async () => {
  await madeStory()
  const model = quietModel(JSON.stringify({ kind: 'change', reply: '加一场。', edits: [
    { op: 'meta', story: '华生找到钥匙，坐马车去码头，用它打开箱子。' },
    { op: 'scene_add', after: 's1', scene: { title: '马车', place: '车厢，皮座椅，木地板。', mood: '一盏马灯。', stage: { kind: 'indoor', exit: 'door', width: 10, depth: 4.9 }, beats: [{ objective: '看窗外', object: '座椅', action: '手扶座椅。' }], film: { opening: { action: '上车。' }, door: { action: '开门。' }, ending: { action: '下车。' } } } },
  ] }))
  await hearNote({ id: ID, message: '加一场马车戏', provider: model, signal })
  const { project, needsLayout } = await applyProposal(ID)
  assert.deepEqual(needsLayout, ['s3'])
  const nodes = buildGraph(project)
  assert.deepEqual(generationTargets(nodes), [], 'nothing can be made until the new scene stands')
  const statuses = await nodeStatuses(project, nodes, await readState(ID))
  assert.equal(statuses['story:cast'], 'done')
  assert.equal(statuses['story:scenes'], 'done')
  assert.equal(statuses['story:layout:s1'], 'done')
  assert.equal(statuses['story:layout:s3'], 'ready')
})

test('the page is not sent the copy kept for undoing', async () => {
  await madeStory()
  await hearNote({ id: ID, message: '改', provider: quietModel(JSON.stringify({ kind: 'change', reply: '好。', edits: [{ op: 'cast', target: 'c2', costume: '灰风衣' }] })), signal })
  const { project } = await applyProposal(ID)
  const agent = publicAgent(project)
  assert.equal(agent.canUndo, true)
  assert.equal(agent.undo, undefined)
  forgetUndo(project)
  assert.equal(publicAgent(project).canUndo, false)
})

// ---------------------------------------------------------------- lines
test('adding lines to a shot pays for that shot alone, and only someone in it can speak', async () => {
  const project = await madeStory()
  const talk = { op: 'beat', scene: 's1', target: 'b2', face: '两人对视。', face_cast: ['华生'], lines: [{ who: '华生', says: '你确定？' }, { who: '福尔摩斯', says: '确定。' }] }
  const result = applyEdits(project, [talk])
  assert.ok(result.changed.some(line => line.what === '台词' && line.to.includes('华生：你确定？')))
  const plan = await planAfter(project, result)
  assert.equal(plan.calls.image, 0)
  assert.ok(plan.calls.video >= 1)
  assert.ok(plan.nodes.every(id => id.startsWith('scene:s1:clip:b2') || id === 'film'))
  assert.throws(() => applyEdits(project, [{ ...talk, face_cast: [] }]), /是“华生”说的|写到了华生/)
  assert.throws(() => applyEdits(project, [{ op: 'beat', scene: 's1', target: 'b2', lines: [{ who: '福尔摩斯', says: '好。' }] }]), /没有露脸镜头/)
})

// ---------------------------------------------------------------- checking its own change
const reviewing = (reviews, ...answers) => ({
  asked: [], reviewed: [], shown: [],
  async text({ system, user, images }) {
    if (system.includes('挑修改里的错')) { this.reviewed.push(user); return JSON.stringify(reviews.length > 1 ? reviews.shift() : reviews[0]) }
    this.asked.push(user)
    this.shown.push(images ?? [])
    return answers.length > 1 ? answers.shift() : answers[0]
  },
})
const change = (during, reply = '好。') => JSON.stringify({ kind: 'change', reply, edits: [{ op: 'beat', scene: 's1', target: 'b1', during }] })

test('what it wrote is read back, and what the reading finds goes back to be put right', async () => {
  await madeStory()
  const model = reviewing([{ ok: false, problems: ['结尾的全黑被删了，要留着。'] }, { ok: true, problems: [] }], change('第一稿。'), change('第二稿。'))
  const project = await hearNote({ id: ID, message: '改旁白', provider: model, signal })
  assert.equal(model.reviewed.length, 2)
  assert.match(model.asked[1], /结尾的全黑被删了/)
  assert.equal(project.agent.proposal.changed[0].to, '第二稿。')
  assert.equal(project.agent.proposal.doubts, undefined)
})

test('what it still cannot put right is shown to the person, not hidden', async () => {
  await madeStory()
  const model = reviewing([{ ok: false, problems: ['华生没有露脸。'] }], change('一。'), change('二。'), change('三。'))
  const project = await hearNote({ id: ID, message: '改旁白', provider: model, signal })
  assert.deepEqual(project.agent.proposal.doubts, ['华生没有露脸。'])
  assert.equal(model.reviewed.length, 3)
})

test('a review that cannot run does not stop the note', async () => {
  await madeStory()
  const model = { async text({ system }) { if (system.includes('挑修改里的错')) throw new Error('断了'); return change('一。') } }
  const project = await hearNote({ id: ID, message: '改旁白', provider: model, signal })
  assert.equal(project.agent.proposal.changed[0].to, '一。')
})

// ---------------------------------------------------------------- saying yes in words
test('a question leaves what is waiting where it is', async () => {
  await madeStory()
  await hearNote({ id: ID, message: '改', provider: quietModel(change('一。')), signal })
  const project = await hearNote({ id: ID, message: '要花多少钱？', provider: quietModel(JSON.stringify({ kind: 'talk', reply: '不花钱。', edits: [] })), signal })
  assert.equal(project.agent.proposal.changed[0].to, '一。')
})

test('"go" is only what was asked for when something is waiting, and nothing is applied by hearing it', async () => {
  await madeStory()
  const eager = quietModel(JSON.stringify({ kind: 'go', reply: '好。', edits: [] }), JSON.stringify({ kind: 'talk', reply: '现在没有要落实的。', edits: [] }))
  const idle = await hearNote({ id: ID, message: '可以', provider: eager, signal })
  assert.equal(idle.go, undefined)
  assert.match(eager.asked[1], /没有等待同意的修改/)
  await hearNote({ id: ID, message: '改', provider: quietModel(change('一。')), signal })
  const heard = await hearNote({ id: ID, message: '可以，重拍', provider: quietModel(JSON.stringify({ kind: 'go', reply: '好，这就做。', edits: [] })), signal })
  assert.deepEqual(heard.go, { regenerate: true })
  assert.equal(heard.agent.chat.at(-1).text, '好，就按上面这条修改开始做。', 'what happens next is what is written in the change, not what the model says about it')
  assert.ok(heard.agent.proposal, 'whoever called carries it out')
  assert.equal((await readProject(ID)).go, undefined, 'what one sentence meant is not kept')
  const only = await hearNote({ id: ID, message: '先只改内容', provider: quietModel(JSON.stringify({ kind: 'go', regenerate: false, reply: '好。', edits: [] })), signal })
  assert.deepEqual(only.go, { regenerate: false })
})

// ---------------------------------------------------------------- looking at pictures
// A real video where the clip is, since a sheet of frames is cut from it, and the steps done again on top of it.
async function storyWithRealClip(extra = {}) {
  const made = await madeStory({ provider: 'ark', ...extra })
  await ffmpeg(['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:d=2:r=12', '-pix_fmt', 'yuv420p', join(projectDir(ID), 'scenes/s1/b1.mp4')])
  for (const node of buildGraph(made)) await adoptNode(made, node)
  return made
}

test('it can ask to see a shot, and is then shown it', async () => {
  await storyWithRealClip()
  const model = quietModel(JSON.stringify({ kind: 'look', reply: '我看看。', look: ['clip:s1:b1', 'set:s9'], edits: [] }), JSON.stringify({ kind: 'talk', reply: '华生没有拿灯。', edits: [] }))
  const seenImages = []
  const seeing = { ...model, text(request) { seenImages.push(request.images ?? []); return model.text(request) } }
  const project = await hearNote({ id: ID, message: '华生手里有灯吗', provider: seeing, signal })
  assert.equal(seenImages[0].length, 0)
  assert.equal(seenImages[1].length, 1)
  assert.match(seenImages[1][0], /^data:image\/jpeg;base64,/)
  assert.match(model.asked[1], /没有真实的画面可看：set:s9/)
  assert.match(model.asked[1], /声音你听不到/)
  assert.equal(project.agent.chat.at(-1).text, '华生没有拿灯。')
  assert.ok(project.agent.chat.at(-1).looked[0].includes('书房'))
})

test('a preview has nothing to look at, and says so', async () => {
  await madeStory()
  const model = quietModel(JSON.stringify({ kind: 'look', reply: '我看看。', look: ['clip:s1:b1'], edits: [] }), JSON.stringify({ kind: 'talk', reply: '现在是占位素材。', edits: [] }))
  await hearNote({ id: ID, message: '拍得怎么样', provider: model, signal })
  assert.match(model.asked[1], /没有真实的画面可看/)
})

// ---------------------------------------------------------------- after it has been made
const watching = (reports, ...answers) => ({
  asked: [], shown: [],
  async text({ system, user, images }) {
    if (system.includes('刚拍好的画面')) { this.shown.push(images ?? []); return JSON.stringify(reports.length > 1 ? reports.shift() : reports[0]) }
    if (system.includes('挑修改里的错')) return JSON.stringify({ ok: true, problems: [] })
    this.asked.push(user)
    return answers.length > 1 ? answers.shift() : answers[0]
  },
})

async function afterMaking(report, ...answers) {
  const project = await storyWithRealClip()
  const state = await updateRecords(ID, nodes => { nodes['scene:s1:clip:b1:0'].finishedAt = Date.now() + 60000; return nodes })
  assert.ok(state)
  project.agent = { chat: [{ role: 'user', text: '让华生拿灯' }], proposal: null, pendingCheck: { note: '让华生拿灯', changed: [{ where: '码头', what: '露脸镜头', from: '', to: '华生拿灯' }] }, ...project.agent }
  await writeProject(project)
  const model = watching(report, ...answers)
  const after = await lookAtWhatWasMade({ id: ID, startedAt: Date.now() + 1000, provider: model, signal })
  return { after, model }
}

test('what was made is looked at, and if it is right it says so and that it cannot hear', async () => {
  const { after, model } = await afterMaking([{ seen: '华生拿着灯。', problems: [] }])
  assert.equal(model.shown[0].length, 1)
  assert.match(after.agent.chat.at(-1).text, /华生拿着灯。没看到和要求不一样/)
  assert.match(after.agent.chat.at(-1).text, /声音我听不到/)
  assert.equal(after.agent.pendingCheck, null)
  assert.equal(after.agent.checking, false)
  assert.equal(after.agent.proposal, null)
})

test('if it is wrong it proposes the correction and waits: paying again is not its decision', async () => {
  const { after, model } = await afterMaking([{ seen: '华生空着手。', problems: [{ where: '结尾', what: '要求拿灯，实际空手。' }] }], change('修正稿。', '把拿灯写进露脸镜头。'))
  assert.match(model.asked[0], /要求拿灯，实际空手/)
  assert.equal(after.agent.proposal.changed[0].to, '修正稿。')
  assert.match(after.agent.chat.at(-1).text, /你说可以我就照这个重做/)
  assert.equal(after.agent.selfFixes, 1)
  assert.equal(after.scenes[0].beats[0].during, '华生说过钥匙在这里。', 'nothing has changed')
})

test('after two tries at the same thing it stops proposing and hands the decision back', async () => {
  const project = await storyWithRealClip()
  await updateRecords(ID, nodes => { nodes['scene:s1:clip:b1:0'].finishedAt = Date.now() + 60000 })
  project.agent = { chat: [], proposal: null, selfFixes: 2, pendingCheck: { note: '让华生拿灯', changed: [] } }
  await writeProject(project)
  const model = watching([{ seen: '空手。', problems: [{ where: '结尾', what: '还是空手。' }] }], change('不该问到这里。'))
  const after = await lookAtWhatWasMade({ id: ID, startedAt: Date.now() + 1000, provider: model, signal })
  assert.equal(model.asked.length, 0)
  assert.equal(after.agent.proposal, null)
  assert.match(after.agent.chat.at(-1).text, /连着改了 2 次/)
})

test('saying yes to a correction does not start the count of tries again', async () => {
  await madeStory()
  await hearNote({ id: ID, message: '改', provider: quietModel(change('一。')), signal })
  const project = await readProject(ID)
  project.agent.selfFixes = 1
  await writeProject(project)
  const yes = await hearNote({ id: ID, message: '可以', provider: quietModel(JSON.stringify({ kind: 'go', reply: '好。', edits: [] })), signal })
  assert.equal(yes.agent.selfFixes, 1)
  const note = await hearNote({ id: ID, message: '换个说法', provider: quietModel(change('二。')), signal })
  assert.equal(note.agent.selfFixes, 0)
})

test('a run that did not finish is not looked at yet, and a preview never is', async () => {
  const project = await storyWithRealClip()
  project.agent = { chat: [], proposal: null, pendingCheck: { note: '改', changed: [] } }
  await writeProject(project)
  await resetNode(ID, 'film')
  const model = watching([{ seen: '不该看。', problems: [] }])
  assert.equal(await lookAtWhatWasMade({ id: ID, startedAt: 1000, provider: model, signal }), null)
  assert.equal(model.shown.length, 0)
  assert.ok((await readProject(ID)).agent.pendingCheck, 'waits for the run that does finish')
  const preview = await madeStory()
  preview.agent = { chat: [], proposal: null, pendingCheck: { note: '改', changed: [] } }
  await writeProject(preview)
  const after = await lookAtWhatWasMade({ id: ID, startedAt: 0, provider: model, signal })
  assert.equal(model.shown.length, 0)
  assert.equal(after.agent.pendingCheck, null)
})

test('what is kept for checking is not sent to the page', () => {
  const agent = publicAgent({ agent: { chat: [], proposal: null, pendingCheck: { note: 'x' }, checking: true, undo: {} } })
  assert.equal(agent.pendingCheck, undefined)
  assert.equal(agent.checking, true)
})

test('applying something that will be painted leaves it to be looked at; words alone do not', async () => {
  await madeStory()
  await hearNote({ id: ID, message: '改旁白', provider: quietModel(change('一。')), signal })
  const words = await applyProposal(ID)
  assert.equal(words.project.agent.pendingCheck, undefined)
  await hearNote({ id: ID, message: '华生穿灰风衣', provider: quietModel(JSON.stringify({ kind: 'change', reply: '好。', edits: [{ op: 'cast', target: 'c2', costume: '灰风衣' }] })), signal })
  const painted = await applyProposal(ID)
  assert.equal(painted.project.agent.pendingCheck.note, '华生穿灰风衣')
  const undone = await undoLast(ID)
  assert.equal(undone.agent.pendingCheck, null)
})

test('agreeing to a change on a story nothing has been made from makes nothing, and says so', async () => {
  await rm(projectDir(ID), { recursive: true, force: true })
  await createProject({ ...story({ provider: 'ark' }), id: ID })
  await hearNote({ id: ID, message: '改旁白', provider: quietModel(change('一。')), signal })
  const waiting = await readProject(ID)
  assert.equal(waiting.agent.proposal.plan.neverMade, true)
  assert.ok(waiting.agent.proposal.plan.calls.video > 0, 'the whole first generation is what the graph would count')
  const yes = await hearNote({ id: ID, message: '可以', provider: quietModel(JSON.stringify({ kind: 'go', reply: '马上开拍！', edits: [] })), signal })
  assert.match(yes.agent.chat.at(-1).text, /还没开始生成，不花钱/)
  const { project } = await applyProposal(ID)
  assert.equal(project.agent.redoPending, false)
  assert.equal(project.agent.pendingCheck, undefined)
})

test('a story something has been made from says what remaking costs', async () => {
  const project = await madeStory()
  const plan = await planAfter(project, applyEdits(project, [{ op: 'cast', target: 'c2', costume: '灰风衣' }]))
  assert.equal(plan.neverMade, false)
})

test('leaves nothing behind', async () => {
  await rm(projectDir(ID), { recursive: true, force: true })
  assert.ok(!existsSync(projectDir(ID)))
})
