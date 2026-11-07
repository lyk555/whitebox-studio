import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLayout } from '../platform/breakdown.mjs'
import { applyChanges, chatWithSet } from '../platform/setChat.mjs'
import { shapeFromParts } from '../platform/shapes.mjs'
import { buildStage, placeObjects, repeatedLayout, settleForFilming, shapeOf } from '../platform/stage.mjs'

const quiet = { log: () => {}, progress: () => {}, signal: new AbortController().signal }
const scripted = (...answers) => {
  const asked = []
  return { asked, text: async ({ user }) => { asked.push(user); return answers.length > 1 ? answers.shift() : answers[0] } }
}

const box = (x, y, z, w, h, d) => ({ shape: 'box', at: [x, y, z], size: [w, h, d] })
const typewriter = [box(0, 0.05, 0, 0.4, 0.1, 0.35), { shape: 'dome', at: [0, 0.1, -0.05], radius: 0.08, length: 0.42 }]
const workbench = [box(0, 0.9, 0, 1.8, 0.1, 0.8), box(-0.8, 0.43, 0, 0.1, 0.85, 0.7), box(0.8, 0.43, 0, 0.1, 0.85, 0.7)]

test('a rough model always ends up centred and on the floor, whatever numbers it came with', () => {
  const { size, parts } = shapeFromParts(workbench.map(part => ({ ...part, at: [part.at[0] + 3, part.at[1] + 1, part.at[2] - 2] })), { name: '工作台' })
  assert.deepEqual(size, [1.8, 0.945, 0.8])
  assert.equal(parts[0].at[0], 0)
  assert.equal(parts[1].at[1], 0.425)
})

test('every kind of part is measured by what it really takes up', () => {
  assert.deepEqual(shapeFromParts([{ shape: 'round', at: [0, 1, 0], radius_top: 0.1, radius_bottom: 0.3, height: 2 }]).size, [0.6, 2, 0.6])
  assert.deepEqual(shapeFromParts([{ shape: 'dome', at: [0, 0, 0], radius: 0.5, length: 2 }]).size, [2, 0.5, 1])
})

test('what cannot stand on a stage is refused with the reason', () => {
  assert.throws(() => shapeFromParts([box(0, 1, 0, 6, 2, 1)], { name: '大墙' }), /最大/)
  assert.throws(() => shapeFromParts([box(0, 0.5, 0, 2, 1, 1)], { name: '大盒子', onTop: true }), /放在别的东西上面/)
  assert.throws(() => shapeFromParts([{ shape: 'cone', at: [0, 0, 0] }], { name: '锥' }), /只能是 box、round 或 dome/)
  assert.throws(() => shapeFromParts([{ shape: 'box', at: [0, 0], size: [1, 1, 1] }], { name: '坏' }), /at 要写成/)
  assert.throws(() => shapeFromParts([box(0, 0.5, 0, 'wide', 1, 1)], { name: '坏' }), /不是数字/)
  assert.throws(() => shapeFromParts(Array.from({ length: 17 }, () => box(0, 0.5, 0, 1, 1, 1)), { name: '太碎' }), /最多 16/)
  assert.throws(() => shapeFromParts([], { name: '空' }), /没有 parts/)
})

test('parts a model left floating are slid onto their neighbours, and the thing is one piece', () => {
  const { parts, size } = shapeFromParts([box(0, 0.5, 0, 1, 1, 1), box(0.1, 1.6, 0, 0.4, 0.4, 0.4), box(3, 0.5, 0, 1, 1, 1)], { name: '漏了缝' })
  const [body, top, side] = parts
  assert.ok(Math.abs(top.at[1] - top.size[1] / 2 - (body.at[1] + body.size[1] / 2)) < 0.001, '上面的零件落到了下面的零件上')
  assert.ok(Math.abs(side.at[0] - side.size[0] / 2 - (body.at[0] + body.size[0] / 2)) < 0.001, '旁边的零件贴了过来')
  assert.ok(size[0] < 2.1)
})

test('a rough model stands on the stage exactly like a stock one', () => {
  const objects = [{ id: 'o1', name: '工作台', shape: shapeFromParts(workbench), x: 4.2, z: -1.5, look: '' }]
  const beats = [{ id: 'b1', objective: '查看', objectName: '工作台', object: 'o1', performed: true, gives: [], takes: [] }]
  const { ok, issues, blocks, data } = buildStage({ objects, beats, props: [], exit: {} })
  assert.ok(ok, JSON.stringify(issues))
  assert.deepEqual(blocks[0].size, [1.8, 0.945, 0.8])
  assert.equal(blocks[0].parts.length, 3)
  assert.equal(data.story.beats[0].clip, 'b1')
})

test('a thing asked for a taken or impossible spot lands as close as it fits', () => {
  const shape = shapeFromParts(workbench)
  const placed = placeObjects([{ id: 'a', name: 'a', shape, x: 2, z: 0 }, { id: 'b', name: 'b', shape, x: 2, z: 0 }, { id: 'c', name: 'c', shape, x: -3, z: -3.4 }, { id: 'd', name: 'd', shape, x: 20, z: 20 }])
  assert.deepEqual(placed.find(object => object.id === 'a').x, 2, '能放就放在要求的位置')
  const b = placed.find(object => object.id === 'b')
  assert.ok(Math.hypot(b.x - 2, b.z) < 2.5 && Math.hypot(b.x - 2, b.z) > 0, '被占了就放到最近的地方')
  const c = placed.find(object => object.id === 'c')
  assert.ok(!(Math.abs(c.x + 3) < 1.75 && c.z < -2.0), '不挡门')
  const issues = buildStage({ objects: placed.filter(object => object.id !== 'd'), beats: [], props: [], exit: {} }).issues
  assert.deepEqual(issues.filter(issue => issue.level === 'error'), [])
})

test('something that cannot be filmed where it stands is moved to where it can', () => {
  const shape = shapeFromParts(workbench)
  const objects = [{ id: 'o1', name: '台子', shape, x: 1.25, z: -3.3 }]
  const scene = { props: [], exit: {}, beats: [{ id: 'b1', objective: '查', objectName: '台子', object: 'o1', performed: true, gives: [], takes: [] }] }
  const settled = settleForFilming(scene, objects)
  assert.deepEqual(buildStage({ ...scene, objects: settled }).issues.filter(issue => issue.level === 'error'), [])
})

const scene = {
  id: 's1', title: '书房', place: '灰墙', props: [],
  beats: [{ id: 'b1', objective: '查看工作台', objectName: '工作台', object: 'o1', performed: true, gives: [], takes: [] }],
  exit: {},
  objects: [
    { id: 'o1', name: '工作台', shape: shapeFromParts(workbench), x: 4.2, z: -1.5, look: '旧木' },
    { id: 'o2', name: '木箱', archetype: 'crate', x: -3.9, z: 1, look: '' },
    { id: 'o3', name: '台灯', archetype: 'lamp', on: 'o1', dx: 0, dz: 0, look: '' },
  ],
}
const project = { style: '写实', scenes: [scene], cast: [] }

test('the model can add something of its own making, on the floor or on something', () => {
  const { objects, changed } = applyChanges(scene, [
    { op: 'add', name: '打字机', on: '工作台', parts: typewriter, look: '黑色旧打字机' },
    { op: 'add', name: '衣帽架', x: -1, z: -1, parts: [{ shape: 'round', at: [0, 0.9, 0], radius_top: 0.03, radius_bottom: 0.03, height: 1.8 }, { shape: 'round', at: [0, 0.03, 0], radius_top: 0.25, radius_bottom: 0.25, height: 0.06 }], look: '铁的' },
  ])
  const machine = objects.find(object => object.name === '打字机')
  assert.equal(machine.on, 'o1')
  assert.ok(shapeOf(machine).onTop)
  assert.equal(objects.find(object => object.name === '衣帽架').x, -1)
  assert.equal(changed.length, 2)
  assert.deepEqual(buildStage({ ...scene, objects }).issues.filter(issue => issue.level === 'error'), [])
})

test('the model can reshape, move, rename and remove, and nothing else is touched', () => {
  const { objects, beats } = applyChanges(scene, [
    { op: 'reshape', target: '木箱', parts: [{ shape: 'round', at: [0, 0.5, 0], radius_top: 0.4, radius_bottom: 0.4, height: 1 }], look: '大水缸' },
    { op: 'update', target: '工作台', name: '钳工台' },
    { op: 'move', target: '木箱', x: -4, z: 2 },
    { op: 'remove', target: '台灯' },
  ])
  const crate = objects.find(object => object.id === 'o2')
  assert.equal(crate.archetype, undefined)
  assert.equal(crate.shape.parts[0].shape, 'round')
  assert.equal(crate.look, '大水缸')
  assert.deepEqual([crate.x, crate.z], [-4, 2])
  assert.equal(objects.find(object => object.id === 'o3'), undefined)
  assert.equal(beats[0].objectName, '钳工台')
  assert.equal(scene.objects.find(object => object.id === 'o2').archetype, 'crate', '原来的房间没有被改动')
})

test('what a story step needs cannot be removed, and a name that is not there is said so', () => {
  assert.throws(() => applyChanges(scene, [{ op: 'remove', target: '工作台' }]), /第 1 步要互动/)
  assert.throws(() => applyChanges(scene, [{ op: 'move', target: '飞船', x: 0, z: 0 }]), /没有“飞船”/)
  assert.throws(() => applyChanges(scene, [{ op: 'explode', target: '木箱' }]), /没有 explode/)
})

test('removing a thing takes what stands on it too', () => {
  const room = { ...scene, beats: [], objects: scene.objects }
  const { objects } = applyChanges(room, [{ op: 'remove', target: '工作台' }])
  assert.deepEqual(objects.map(object => object.id), ['o2'])
})

test('a question changes nothing', async () => {
  const answer = await chatWithSet({ project, scene, message: '现在有几件东西？', provider: scripted(JSON.stringify({ reply: '三件。', changes: [] })), ...quiet })
  assert.equal(answer.changes, 0)
  assert.equal(answer.objects, undefined)
})

test('a change that fails its check goes back with the reason, then the next answer is used', async () => {
  const bad = JSON.stringify({ reply: '好', changes: [{ op: 'reshape', target: '木箱', parts: [box(0, 1, 0, 6, 2, 1)] }] })
  const good = JSON.stringify({ reply: '改好了', changes: [{ op: 'reshape', target: '木箱', parts: [box(0, 0.5, 0, 1, 1, 1)] }] })
  const provider = scripted(bad, good)
  const answer = await chatWithSet({ project, scene, message: '改箱子', provider, ...quiet })
  assert.equal(answer.reply, '改好了')
  assert.ok(provider.asked[1].includes('最大'))
})

test('the model hears what is selected and what was just said', async () => {
  const withHistory = { ...scene, chat: [{ role: 'user', text: '上一句' }, { role: 'designer', text: '上一句的回答' }] }
  const provider = scripted(JSON.stringify({ reply: '好', changes: [] }))
  await chatWithSet({ project, scene: withHistory, message: '把这个做大', selected: 'o2', provider, ...quiet })
  assert.ok(provider.asked[0].includes('选中的是“木箱”'))
  assert.ok(provider.asked[0].includes('上一句的回答'))
})

const standingAt = (id, x, z) => ({ id, name: id, shape: shapeFromParts(workbench), x, z })

test('a room that repeats another is noticed, and one that does not is left alone', () => {
  const other = { title: '上一场', objects: [standingAt('a', 4, -1.5), standingAt('b', 0.5, -3), standingAt('c', -1, 0.5)] }
  assert.equal(repeatedLayout([standingAt('x', 4.2, -1.3), standingAt('y', 0.3, -3), standingAt('z', -1.2, 0.6)], [other]), other)
  assert.equal(repeatedLayout([standingAt('x', -4, 2), standingAt('y', 3, 2), standingAt('z', 6, 0)], [other]), null)
})

test('a layout that repeats another scene goes back to the model', async () => {
  const parsed = { ...scene, id: 's2', objects: [], beats: [{ id: 'b1', objective: '查看', objectName: '工作台', performed: true, gives: [], takes: [] }] }
  const earlier = { id: 's1', title: '上一场', objects: [standingAt('a', 4.2, -1.5), standingAt('b', -3.9, 1)] }
  const answerAt = (x1, z1, x2, z2) => JSON.stringify({ objects: [
    { step: 1, name: '工作台', x: x1, z: z1, look: '', parts: workbench },
    { step: 0, name: '矮凳', x: x2, z: z2, look: '', parts: [box(0, 0.2, 0, 0.5, 0.4, 0.5)] },
  ] })
  const provider = scripted(answerAt(4.2, -1.5, -3.9, 1), answerAt(-1, 0.5, 5.5, 2))
  const { objects } = await buildLayout({ ...quiet, project: { style: '写实', scenes: [earlier, parsed], cast: [] }, scene: parsed, provider })
  assert.ok(provider.asked[1].includes('太像了'))
  assert.equal(objects.find(object => object.name === '工作台').x, -1)
  assert.ok(objects[0].shape.parts.length)
})
