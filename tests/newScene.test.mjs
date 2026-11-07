// What a new story gets: painted loosely, seen from one close camera, and laid out so it can be walked.
import assert from 'node:assert/strict'
import test from 'node:test'
import { breakdownScenes, buildLayout, fallbackLayout, roomRules } from '../platform/breakdown.mjs'
import { buildGraph, stageOf } from '../platform/graph.mjs'
import { filmClips, platePrompts } from '../platform/prompts.mjs'
import { applyChanges } from '../platform/setChat.mjs'
import { buildStage } from '../platform/stage.mjs'
import { closeStage, normalizeStage, shellFrom } from '../runtime/shell.js'

const beatsOf = names => names.map((objectName, index) => ({ id: `b${index + 1}`, objective: `看${objectName}`, objectName, performed: true, action: '手的特写。', gives: [], takes: [] }))
const sceneOf = (stage, names) => ({
  id: 's1', title: '这里', place: '一个地方', mood: '一盏灯', paint: 'relaxed', stage: closeStage(stage), openingLine: '开', endingLine: '结', props: [], objects: [], beats: beatsOf(names),
  exit: { name: '出口', beyond: '别处', objective: '离开' },
  film: { opening: { action: '开场。' }, door: { action: '推门。' }, ending: { action: '结尾。' } },
})
const person = { id: 'c1', name: '我', playable: true, costume: '外套', look: '短发' }
const provider = answer => ({ text: async () => JSON.stringify(answer) })
const quiet = { signal: new AbortController().signal, log: () => {}, progress: () => {} }

const filmed = { opening: { action: '开场。' }, door: { action: '推门。' }, ending: { action: '结尾。' } }
const answerWith = stage => ({ scenes: [{ title: '场', place: '地方', mood: '灯光', stage, beats: [{ objective: '看桌子', object: '桌子', action: '手的特写。' }], exit: {}, film: filmed }] })

test('a scene read from a story is painted loosely and seen from one close camera', async () => {
  const [scene] = await breakdownScenes({ project: { story: '故事', cast: [person] }, provider: provider(answerWith({ kind: 'indoor', width: 10, depth: 5, exit: 'door', door_at: 0.2 })), ...quiet })
  assert.equal(scene.paint, 'relaxed')
  assert.equal(scene.stage.lens, 'fixed')
  assert.equal(scene.stage.framing, 'close')
})

test('a prop no step hands over is not kept, since it would only cost a picture', async () => {
  const answer = answerWith({ width: 10 })
  answer.scenes[0].props = [{ id: 'gear', name: '齿轮', look: '铜的' }, { id: 'note', name: '字条', look: '旧的' }]
  answer.scenes[0].beats[0].gives = ['gear']
  const [scene] = await breakdownScenes({ project: { story: '故事', cast: [person] }, provider: provider(answer), ...quiet })
  assert.deepEqual(scene.props.map(prop => prop.id), ['gear'])
})

test('a preview without a text model gets the same treatment', async () => {
  const [scene] = await breakdownScenes({ project: { story: '桌子和书架。', cast: [person], title: '片' }, provider: {}, ...quiet })
  assert.equal(scene.paint, 'relaxed')
  assert.equal(scene.stage.framing, 'close')
  assert.equal(buildStage({ ...scene, ...fallbackLayout(scene) }).ok, true)
})

test('a size that would not work from close to comes out as one that does', () => {
  assert.equal(closeStage({ width: 5, depth: 12 }).width, 10)
  assert.ok(closeStage({ width: 5, depth: 12 }).depth <= 10 * 0.5)
  assert.equal(closeStage({ width: 18, depth: 12 }).width, 14)
  assert.ok(closeStage({ width: 18, depth: 12 }).depth <= 14 * 0.5)
  assert.equal(closeStage({ width: 12, depth: 1 }).depth, 5.6)
  assert.equal(closeStage({ width: 10, depth: 4.7 }).depth, 4.7)
})

test('an older scene keeps the size and the camera it had', () => {
  assert.deepEqual(normalizeStage({ kind: 'indoor', exit: 'door', width: 5, depth: 12, doorAt: 0.2 }), { kind: 'indoor', exit: 'door', width: 5, depth: 12, doorAt: 0.2 })
  assert.equal(shellFrom({ width: 5, depth: 12 }).CAMERAS.a.fixed, undefined)
})

// Every size, both kinds of place and of way out, every number of steps: the plain layout must always be playable.
const STORY_THINGS = ['书架', '木箱', '长桌', '高柜']
for (const width of [10, 11, 12, 13, 14]) {
  for (const [kind, exit] of [['indoor', 'door'], ['indoor', 'opening'], ['outdoor', 'opening'], ['outdoor', 'door']]) {
    for (const doorAt of [0.08, 0.16, 0.3, 0.5]) {
      for (const count of [2, 3, 4]) {
        test(`the plain layout works: ${width} m ${kind} ${exit} at ${doorAt}, ${count} steps`, () => {
          const scene = sceneOf({ kind, exit, width, depth: width * 0.45, doorAt }, STORY_THINGS.slice(0, count))
          const stage = buildStage({ ...scene, ...fallbackLayout(scene) })
          assert.deepEqual(stage.issues.filter(issue => issue.level === 'error').map(issue => issue.message), [])
        })
      }
    }
  }
}

test('the model is told the rules it will be checked by, in the words of the place', () => {
  const room = roomRules(sceneOf({ kind: 'indoor', width: 10 }, ['桌子']))
  assert.match(room, /1\.1 米/)
  assert.match(room, /四分之一/)
  assert.match(room, /后墙/)
  assert.doesNotMatch(room, /交界|Infinity/)
  assert.match(roomRules(sceneOf({ kind: 'outdoor', width: 10 }, ['桌子'])), /远端边界/)
})

test('a layout from the model that is too tight is moved apart, and what cannot be goes back with the reason', async () => {
  const scene = sceneOf({ kind: 'indoor', width: 10, depth: 4.9, doorAt: 0.16 }, ['桌子', '木箱'])
  const part = { shape: 'box', at: [0, 0.5, 0], size: [1.5, 1, 1.5] }
  const big = { shape: 'box', at: [0, 0.5, 0], size: [3.2, 1, 3.2] }
  const place = (x, z, parts, step, name) => ({ step, name, x, z, look: '', parts: [parts] })
  const ask = async answers => {
    const asked = []
    const result = await buildLayout({ project: { style: '', scenes: [scene] }, scene, provider: { text: async ({ user }) => { asked.push(user); return JSON.stringify(answers.shift()) } }, ...quiet })
    return { asked, result }
  }
  const moved = await ask([{ arrangement: '挤', objects: [place(-0.95, -1.5, part, 1, '桌子'), place(0.95, -1.5, part, 2, '木箱')] }])
  assert.equal(moved.asked.length, 1)
  assert.equal(moved.result.plain, undefined)
  assert.equal(buildStage({ ...scene, ...moved.result }).ok, true)
  const crowded = { arrangement: '满', objects: [1, 2, 3, 4, 5, 6].map(index => place(-3 + index, -1.5, big, index > 2 ? 0 : index, index === 1 ? '桌子' : index === 2 ? '木箱' : `大件${index}`)) }
  const fine = { arrangement: '开', objects: [place(-1.6, -1.5, part, 1, '桌子'), place(1.6, -1.5, part, 2, '木箱')] }
  const sentBack = await ask([crowded, fine])
  assert.equal(sentBack.asked.length, 2)
  assert.match(sentBack.asked[1], /没有通过检查/)
  assert.equal(buildStage({ ...scene, ...sentBack.result }).ok, true)
})

// Seen on a real story: three rounds refused for a wide table near a wall, under a rule made for a moving camera.
test('with one camera, a mark has only to be somewhere to stand', () => {
  const scene = sceneOf({ kind: 'indoor', width: 8, depth: 3.6, doorAt: 0.5 }, ['工作台'])
  const part = [{ shape: 'box', at: [0, 0.45, 0], size: [1.8, 0.9, 1] }]
  const placedAt = z => buildStage({ ...scene, objects: [{ id: 'o1', name: '工作台', x: 0.6, z, shape: { size: [1.8, 0.9, 1], parts: part } }], beats: [{ ...scene.beats[0], object: 'o1' }] })
  const roomy = placedAt(-3.45)
  assert.deepEqual(roomy.issues.filter(issue => issue.level === 'error').map(issue => issue.message), [])
  assert.ok(roomy.data.story.beats.find(beat => beat.id === 'b1').anchor)
  // Nowhere in front to stand is still wrong, and the model is told how far back it has to go.
  assert.match(placedAt(-0.1).issues.map(issue => issue.message).join(' '), /前沿.*不能超过 -0\.6/)
})

test('a beat cannot be a part of something, or what appears after it, and one thing can carry several actions', async () => {
  let asked = ''
  await breakdownScenes({ project: { story: '故事', cast: [person] }, provider: { text: async ({ user }) => { asked = user; return JSON.stringify(answerWith({ width: 10 })) } }, ...quiet })
  assert.match(asked, /不能是另一件东西的一部分/)
  assert.match(asked, /互动之后才出现/)
  assert.match(asked, /合并成一个 beat/)
  assert.match(asked, /1 到 5 个 beat/)
})

// Seen on a real story: a tall rack stood out in the room like a partition.
test('something tall stays towards the back', () => {
  const scene = sceneOf({ kind: 'indoor', width: 10, depth: 4.9, doorAt: 0.16 }, ['桌子'])
  const rack = z => ({ id: 'o2', name: '挂钟架', x: 3.5, z, shape: { size: [0.4, 2.4, 1], parts: [{ shape: 'box', at: [0, 1.2, 0], size: [0.4, 2.4, 1] }] } })
  const messages = z => buildStage({ ...scene, objects: [{ id: 'o1', name: '桌子', archetype: 'table', x: -1, z: -2.6 }, rack(z)], beats: [{ ...scene.beats[0], object: 'o1' }] }).issues.map(issue => issue.message).join(' ')
  assert.match(messages(-1.5), /挂钟架.*像一堵墙/)
  assert.doesNotMatch(messages(-3.4), /像一堵墙/)
})

test('the way out cannot be hidden behind something', () => {
  const part = { shape: 'box', at: [0, 1, 0], size: [2, 2, 1] }
  const scene = sceneOf({ kind: 'indoor', width: 10, depth: 4.9, doorAt: 0.5 }, ['桌子'])
  const placed = (x, z) => ({ ...scene, objects: [{ id: 'o1', name: '桌子', x, z, shape: { size: [2, 2, 1], parts: [{ shape: 'box', at: part.at, size: part.size }] } }], beats: [{ ...scene.beats[0], object: 'o1' }] })
  const { DOOR } = shellFrom(scene.stage)
  const messages = stage => buildStage(stage).issues.map(issue => issue.message).join(' ')
  assert.match(messages(placed(DOOR.x, -1.6)), /挡住了门/)
  assert.doesNotMatch(messages(placed(DOOR.x + 3.5, -1.6)), /挡住了门/)
})

test('a new size from the set designer stays one that works from close to', () => {
  const scene = sceneOf({ kind: 'indoor', width: 10, depth: 4.9, doorAt: 0.16 }, ['桌子'])
  const { objects, beats } = fallbackLayout(scene)
  const { stage } = applyChanges({ ...scene, objects, beats }, [{ op: 'stage', width: 18, depth: 12 }])
  assert.equal(stage.width, 14)
  assert.equal(stage.lens, 'fixed')
  assert.equal(stage.framing, 'close')
})

const projectOf = scene => ({ id: 't', story: '', style: '写实', provider: 'mock', cast: [person], scenes: [scene] })
const laidOut = scene => ({ ...scene, ...fallbackLayout(scene) })

test('a thing painted in the wrong place sends its picture back, before anything is built on it', () => {
  const nodes = buildGraph(projectOf(laidOut(sceneOf({ kind: 'indoor', width: 12, doorAt: 0.16 }, ['书架', '木箱']))))
  const matte = nodes.find(node => node.id === 'scene:s1:a_matte')
  assert.equal(matte.repaint.out, 'scenes/s1/plate_a_paint.png')
  assert.ok(matte.params.gate.things.length > 0)
  assert.equal('repaint' in matte.params, false, 'how a fault is put right is not part of what the step is')
  for (const node of nodes.filter(candidate => candidate.kind === 'refine')) assert.ok(node.deps.includes('scene:s1:a_matte'), node.id)
  assert.equal(nodes.find(node => node.id === 'scene:s1:a_paint').attempts, 3)
  assert.equal(matte.attempts, 5)
})

test('an outdoor picture is not asked for a ceiling, and an indoor one still is', () => {
  const outdoors = laidOut(sceneOf({ kind: 'outdoor', exit: 'opening', width: 12 }, ['石桌']))
  const indoors = laidOut(sceneOf({ kind: 'indoor', width: 12 }, ['书架']))
  const paint = scene => platePrompts(projectOf(scene), scene, stageOf(scene)).a_paint
  assert.doesNotMatch(paint(outdoors), /屋顶要有设计|护墙板|书脊/)
  assert.match(paint(outdoors), /远景要有设计/)
  assert.match(paint(indoors), /护墙板/)
})

test('a shot keeps the light of its picture, and starts from the whole room', () => {
  const scene = laidOut(sceneOf({ kind: 'indoor', width: 12 }, ['书架']))
  const clips = filmClips(projectOf(scene), scene, stageOf(scene))
  const shot = clips.find(clip => clip.id === 'b1').parts[0].text
  assert.match(shot, /不要增加或改变光源/)
  assert.doesNotMatch(shot, /不得出现阳光/)
  assert.match(shot, /固定全景/)
  assert.doesNotMatch(clips.find(clip => clip.id === 'opening').parts[0].text, /固定全景/, 'the opening starts close up, on its first thing')
})

const faceShot = (scene, clip) => buildGraph(projectOf(scene)).find(node => node.id === `scene:s1:clip:${clip}:1`).params

test('a face shot is never shown a frame with the person already in it', () => {
  const scene = laidOut(sceneOf({ kind: 'indoor', exit: 'door', width: 12 }, ['书架']))
  scene.beats[0].face = '人物皱眉'
  const beat = faceShot(scene, 'b1')
  assert.deepEqual(beat.references, ['cast/c1/plate_face.png', 'scenes/s1/plate_a_closed.png'])
  assert.match(beat.prompt, /每人只出现一次/)
  assert.match(beat.prompt, /眼睛不看镜头/)
})

test('the last face shot behind a door is outside it, and is shown no picture of the room', () => {
  const { references, prompt } = faceShot(laidOut(sceneOf({ kind: 'indoor', exit: 'door', width: 12 }, ['书架'])), 'ending')
  assert.deepEqual(references, ['cast/c1/plate_face.png'])
  assert.match(prompt, /门外/)
  assert.doesNotMatch(prompt, /图片2/)
})

test('the last face shot at an open way out is still in the place, without the person in the picture', () => {
  const { references } = faceShot(laidOut(sceneOf({ kind: 'outdoor', exit: 'opening', width: 12 }, ['缆桩'])), 'ending')
  assert.deepEqual(references, ['cast/c1/plate_face.png', 'scenes/s1/plate_a_open.png'])
})

test('an older scene is filmed as it always was', () => {
  const scene = { ...laidOut(sceneOf({ kind: 'indoor', width: 12 }, ['书架'])), paint: undefined, stage: { kind: 'indoor', exit: 'door', width: 12, depth: 7.4, doorAt: 0.16 } }
  const placed = { ...scene, ...fallbackLayout(scene) }
  const shot = filmClips(projectOf(placed), placed, stageOf(placed)).find(clip => clip.id === 'b1').parts[0].text
  assert.match(shot, /不得出现阳光/)
  assert.equal(faceShot(placed, 'ending').references.at(-1), 'scenes/s1/frame_ending_first.png')
  assert.doesNotMatch(faceShot(placed, 'ending').prompt, /每人只出现一次/)
})
