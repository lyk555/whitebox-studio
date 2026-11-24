// A step filmed as one take, how tall people stand, and who walks over to talk. No test here calls a model.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { FatalError } from '../platform/engine.mjs'
import { buildGraph, stageOf } from '../platform/graph.mjs'
import { ageIn, heightOf, MAN_HEIGHT, onStageFrom } from '../platform/people.mjs'
import { filmClips, framed, HELD_SECONDS } from '../platform/prompts.mjs'
import { pictureRefused } from '../platform/providers.mjs'
import { personBox, thingsApart } from '../platform/stage.mjs'
import { executeNode } from '../platform/steps.mjs'
import { createProject, projectDir } from '../platform/store.mjs'

const cast = [
  { id: 'c1', name: '我', playable: true, costume: '外套', look: '短发' },
  { id: 'c2', name: '老板', costume: '围裙', look: '圆脸' },
  { id: 'c3', name: '警察', costume: '制服', look: '方脸' },
]
const objects = [
  { id: 'table', name: '长桌', archetype: 'table', look: '胡桃木长桌' },
  { id: 'lamp', name: '台灯', archetype: 'lamp', on: 'table', dx: -0.3, dz: -0.05, look: '黄铜台灯' },
  { id: 'pillar', name: '石柱', archetype: 'pillar', look: '石柱' },
  { id: 'shelf', name: '书架', archetype: 'shelf', look: '书架' },
  { id: 'chest', name: '木箱', archetype: 'chest', look: '木箱' },
  { id: 'cabinet', name: '高柜', archetype: 'cabinet', look: '高柜' },
  { id: 'couch', name: '沙发', archetype: 'couch', look: '沙发' },
]
const place = { table: [0.6, -1.9], pillar: [-4.4, -3.1], shelf: [0, -3.7], chest: [3, -1.3], couch: [2.4, -3.5], cabinet: [3.95, -3.4] }
const step = (id, object, extra = {}) => ({ id, object, objectName: { shelf: '书架', chest: '木箱', couch: '沙发' }[object], objective: `看${object}`, performed: true, action: '手的特写。', ...extra })
const room = (beats, extra = {}) => ({
  id: 's1', title: '阅览室', place: '旧阅览室', mood: '台灯的暖光', openingLine: '开场', endingLine: '结尾', paint: 'relaxed',
  stage: { kind: 'indoor', exit: 'door', width: 10, depth: 4.9, doorAt: 0.16, lens: 'fixed', framing: 'close' },
  objects: objects.map(object => (place[object.id] ? { ...object, x: place[object.id][0], z: place[object.id][1] } : object)),
  props: [],
  beats: beats ?? [
    step('shelf', 'shelf', { face: '警察推门进来，盯着我。', faceCast: ['警察'], arrives: ['警察'], settle: '书脊。' }),
    step('chest', 'chest', { face: '老板擦着箱子，抬头看我。', faceCast: ['老板'], lines: [{ who: '老板', says: '别碰它。' }], settle: '锁扣。' }),
  ],
  exit: { name: '木门', beyond: '走廊', objective: '推门' },
  film: { opening: { action: '开场。' }, ending: { action: '结尾。' } },
  ...extra,
})
const standing = scene => ({ ...scene, onStage: onStageFrom(cast, scene, [], thingsApart(scene)) })
const projectOf = scene => ({ id: 'test', story: '故事', style: '写实', provider: 'mock', cast, scenes: [scene] })
const clipOf = (scene, id) => filmClips(projectOf(scene), scene, stageOf(scene)).find(clip => clip.id === id)

// ---------------------------------------------------------------- the picture it is pushed in to
test('the picture a take is pushed in to holds everything asked of it, as wide as the screen, and no closer than it can be painted from', () => {
  const box = (x0, y0, x1, y1) => ({ x0, y0, x1, y1 })
  const asked = [box(1000, 500, 1100, 800), box(1300, 600, 1400, 820)]
  const rect = framed(asked)
  for (const one of asked) assert.ok(rect.x0 <= one.x0 && rect.x1 >= one.x1 && rect.y0 <= one.y0 && rect.y1 >= one.y1)
  assert.ok(Math.abs((rect.x1 - rect.x0) / (rect.y1 - rect.y0) - 16 / 9) < 0.01)
  assert.ok(rect.x1 - rect.x0 >= 2560 * 0.7 - 0.01, 'pushed in no further than faces the video model will take')
  const edge = framed([box(10, 1300, 120, 1430)])
  assert.ok(edge.x0 >= 0 && edge.y0 >= 0 && edge.x1 <= 2560 && edge.y1 <= 1440, 'kept inside the picture')
  const all = framed([box(0, 0, 2560, 1440)])
  assert.deepEqual([all.x0, all.y0, all.x1, all.y1], [0, 0, 2560, 1440])
})

// ---------------------------------------------------------------- one take
test('a step with a face in a room people stand in is one take: in, the lines, and out, each starting where the last one ended', () => {
  const scene = standing(room())
  const clip = clipOf(scene, 'chest')
  assert.ok(clip.key)
  assert.deepEqual(clip.parts.map(part => [part.from, part.to]), [['first', 'key'], ['key', 'key'], ['key', 'last']])
  const [pushIn, hold, backOut] = clip.parts
  for (const part of clip.parts) {
    assert.match(part.text, /连续的镜头，中间不切镜头/)
    assert.doesNotMatch(part.text, /切到特写|切到给定尾帧/)
    assert.ok(part.fallback, 'each keeps the shot it was before, for when the picture is refused')
  }
  assert.match(pushIn.text, /镜头平稳地缓缓推近到我和木箱，以及老板/)
  // Everyone standing in that part of the picture is in it, the policeman too, said or not.
  assert.match(pushIn.text, /尾帧里：我在画面[^，]+，站在木箱前；[^。]*警察在画面[^，]+，站在[^。；]+；[^。]*老板在画面[^，]+，站在[^。；]+。我刚做完手上的事，还是背对镜头站着，只把头转向老板/)
  assert.match(hold.text, /^台词，按顺序说：老板说：“别碰它。”/)
  assert.match(hold.text, /第一帧和最后一帧都是给定的这张画面/)
  assert.match(hold.text, /谁站在哪，以画面为准/)
  assert.match(backOut.text, /镜头平稳地缓缓拉远，回到给定尾帧的全景构图。我转回去，背对镜头站定/)
  assert.deepEqual(clip.parts.map(part => part.fallback.showsFace ?? false), [false, true, false])
  assert.match(clip.parts[2].fallback.text, /切到特写/, 'the cut it falls back to is the old one')
})

test('the picture is cut from the end of the step, so someone who came in is in it, and painted with everyone in it', () => {
  const scene = standing(room())
  const { key } = clipOf(scene, 'shelf')
  assert.equal(key.from, 'last')
  assert.equal(key.people[0].name, '我')
  assert.ok(key.people.some(person => person.name === '警察'))
  assert.match(key.prompt, /图2是我的定妆照，穿着：外套；图\d是警察的定妆照，穿着：制服/)
  assert.match(key.prompt, /不得增加、移走或挪动任何人和东西/)
  const [pushIn, , backOut] = clipOf(scene, 'shelf').parts
  assert.match(pushIn.text, /动作进行时，警察（制服）从画面[^，。]+远处的木门走进来，走到画面[^，。]+站定/)
  assert.doesNotMatch(backOut.text, /走进来/)
})

test('the last step of a chapter is pushed in and holds there until it goes dark', () => {
  const base = room()
  const scene = standing({ ...base, beats: base.beats.map(beat => beat.id === 'chest' ? { ...beat, endsChapter: true } : beat) })
  const clip = clipOf(scene, 'chest')
  assert.equal(clip.key.from, 'first', 'it has no end picture of its own')
  assert.deepEqual(clip.parts.map(part => [part.from, part.to]), [['first', 'key'], ['key', null]])
  assert.match(clip.parts[1].text, /台词全部说完以后，画面才慢慢暗下去/)
})

test('a story without people standing in the room keeps its cuts: its face shots show people the game does not', () => {
  const clip = clipOf(room(), 'chest')
  assert.equal(clip.key, undefined)
  assert.equal(clip.parts.some(part => part.from), false)
})

test('in the graph the picture is cut out of the game\'s, painted with the faces, and each part of the take starts and ends on it', () => {
  const scene = standing(room())
  const nodes = buildGraph(projectOf(scene))
  const base = nodes.find(node => node.id === 'scene:s1:key:chest:base')
  assert.equal(base.kind, 'crop')
  assert.deepEqual(base.inputs, ['scenes/s1/frame_chest_last.png'])
  assert.ok(base.deps.includes('scene:s1:frames'))
  const key = nodes.find(node => node.id === 'scene:s1:key:chest')
  assert.equal(key.kind, 'image')
  assert.deepEqual(key.params.references, ['scenes/s1/key_chest_base.png', 'cast/c1/plate_face.png', 'cast/c3/plate_face.png', 'cast/c2/plate_face.png'], 'a portrait of everyone in the picture')
  assert.deepEqual(key.params.fit, [1280, 720])
  const parts = [0, 1, 2].map(index => nodes.find(node => node.id === `scene:s1:clip:chest:${index}`))
  assert.deepEqual(parts.map(part => [part.params.first, part.params.last]), [
    ['scenes/s1/frame_chest_first.png', 'scenes/s1/key_chest.png'],
    ['scenes/s1/key_chest.png', 'scenes/s1/key_chest.png'],
    ['scenes/s1/key_chest.png', 'scenes/s1/frame_chest_last.png'],
  ])
  for (const part of parts) {
    assert.ok(part.deps.includes('scene:s1:key:chest'))
    assert.deepEqual(part.params.references, [])
  }
  assert.deepEqual(parts[1].params.fallback.references, ['cast/c1/plate_face.png', 'cast/c2/plate_face.png', 'scenes/s1/plate_a_closed.png'])
  assert.ok(parts[0].deps.includes('scene:s1:clip:chest:1'), 'the part with the faces goes first')
  assert.ok(parts[1].inputs.includes('cast/c2/plate_face.png'), 'a new portrait makes the fallback, and so the part, out of date')
})

// ---------------------------------------------------------------- when the picture is refused
async function partProject(t) {
  const project = await createProject({ id: `test-${randomBytes(4).toString('hex')}` })
  t.after(() => rm(projectDir(project.id), { recursive: true, force: true }))
  for (const file of ['scenes/s1/frame_b1_first.png', 'scenes/s1/key_b1.png', 'cast/c1/plate_face.png']) {
    await mkdir(dirname(join(projectDir(project.id), file)), { recursive: true })
    await writeFile(join(projectDir(project.id), file), 'picture')
  }
  const node = {
    id: 'scene:s1:clip:b1:0', kind: 'clipPart', sceneId: 's1', outputs: ['scenes/s1/b1_part0.mp4'],
    params: {
      prompt: '一镜到底', duration: 5, audio: true, opensOnCut: false, references: [], first: 'scenes/s1/frame_b1_first.png', last: 'scenes/s1/key_b1.png',
      fallback: { prompt: '切镜头', duration: 5, audio: true, opensOnCut: false, references: [], first: 'scenes/s1/frame_b1_first.png', last: null },
    },
  }
  const record = { log: [], metrics: {}, external: null }
  const context = {
    project, node, signal: new AbortController().signal, external: null,
    setExternal: async value => { record.external = value },
    log: message => record.log.push(message), metric: (name, value) => { record.metrics[name] = value }, progress: () => {},
    path: file => join(projectDir(project.id), file),
  }
  return { project, node, context, record }
}

test('a part whose picture the video model refuses as a real person is made the way it was before, and says so', async t => {
  const { context, record } = await partProject(t)
  const asked = []
  const provider = {
    video: async ({ text, out, last, setExternal }) => {
      asked.push(text)
      if (last?.endsWith('key_b1.png')) throw pictureRefused(new FatalError('方舟接口 HTTP 400：InputImageSensitiveContentDetected.PrivacyInformation'))
      await setExternal({ taskId: 'task-2' })
      await writeFile(out, 'video')
    },
  }
  await executeNode(context, provider)
  assert.deepEqual(asked, ['一镜到底', '切镜头'])
  assert.equal(await readFile(context.path('scenes/s1/b1_part0.mp4'), 'utf8'), 'video')
  assert.equal(record.metrics['拍法'], '切镜头')
  assert.deepEqual(record.external, { taskId: 'task-2', fallback: true }, 'a restart collects the task it fell back to, not a new one')
})

test('any other failure is not hidden by the fallback', async t => {
  const { context } = await partProject(t)
  const provider = { video: async () => { throw new FatalError('方舟接口 HTTP 401：key') } }
  await assert.rejects(executeNode(context, provider), /401/)
  assert.equal(existsSync(context.path('scenes/s1/b1_part0.mp4')), false)
})

test('a fallback task already under way is collected as one', async t => {
  const { context } = await partProject(t)
  context.external = { taskId: 'task-2', fallback: true }
  const asked = []
  const provider = { video: async ({ text, external, out }) => { asked.push([text, external?.taskId]); await writeFile(out, 'video') } }
  await executeNode(context, provider)
  assert.deepEqual(asked, [['切镜头', 'task-2']])
})

test('an opening whose first picture is refused starts on the picture it ends on and holds there', async t => {
  const { context, record, node } = await partProject(t)
  await writeFile(context.path('scenes/s1/frame_b1_last.png'), 'picture')
  node.params = {
    prompt: '电影短片。从第一帧开始。主角走到木板旁停下。声音：脚踩湿泥的咕叽声。福尔摩斯全程不露脸。写实电影质感，浅景深。不得出现任何文字。',
    duration: 10, audio: true, opensOnCut: false, references: [], first: 'scenes/s1/frame_b1_first.png', last: 'scenes/s1/frame_b1_last.png',
  }
  const asked = []
  const provider = {
    video: async ({ text, first, last, duration, out, setExternal }) => {
      asked.push({ text, first, last, duration })
      if (first.endsWith('frame_b1_first.png')) throw pictureRefused(new FatalError("方舟接口 HTTP 400：the input image 'content[1]' may contain real person"))
      await setExternal({ taskId: 'task-3' })
      await writeFile(out, 'video')
    },
  }
  await executeNode(context, provider)
  assert.equal(asked.length, 2)
  assert.ok(asked[1].first.endsWith('frame_b1_last.png') && asked[1].last.endsWith('frame_b1_last.png'), 'starts and ends on the last picture')
  assert.equal(asked[1].duration, HELD_SECONDS)
  assert.match(asked[1].text, /声音：脚踩湿泥的咕叽声。写实电影质感，浅景深。不得出现任何文字。$/, 'keeps the sound and the rules')
  assert.doesNotMatch(asked[1].text, /走到木板旁/, 'nobody walks into a picture they already stand in')
  assert.equal(record.metrics['拍法'], '停在尾帧')
  assert.deepEqual(record.external, { taskId: 'task-3', held: true })

  // A restart collects the held task.
  context.external = record.external
  asked.length = 0
  await executeNode(context, provider)
  assert.equal(asked.length, 1)
  assert.ok(asked[0].first.endsWith('frame_b1_last.png'))
})

test('a refused picture in a shot that cannot hold is not hidden', async t => {
  const { context, node } = await partProject(t)
  node.params = { prompt: '脸', duration: 5, audio: true, opensOnCut: true, references: ['cast/c1/plate_face.png'], first: null, last: null }
  const provider = { video: async () => { throw pictureRefused(new FatalError('方舟接口 HTTP 400：may contain real person')) } }
  await assert.rejects(executeNode(context, provider), /real person/)
})

// ---------------------------------------------------------------- how tall
test('people stand as tall as their age and sex, and a grown man as tall as the player was always drawn', () => {
  assert.equal(ageIn('十四五岁少年'), 14)
  assert.equal(ageIn('二十三四岁青年'), 23)
  assert.equal(ageIn('六十六岁老年'), 66)
  assert.equal(ageIn('五十多岁中年'), 50)
  assert.equal(ageIn('不到三十岁青年'), 30)
  assert.equal(ageIn('8岁'), 8)
  assert.equal(ageIn('中年'), null)
  assert.equal(heightOf({ name: '杰姆', age: '十四五岁少年', costume: '短打上衣' }), 1.62)
  assert.equal(heightOf({ name: '埃伦', age: '二十三四岁青年', costume: '藏青色收腰长裙' }), 1.63)
  assert.equal(heightOf({ name: '女仆', age: '二十岁左右青年', costume: '粗布长裙，白色围裙' }), 1.63)
  assert.equal(heightOf({ name: '老板', costume: '围裙' }), MAN_HEIGHT, 'an apron is not a skirt')
  assert.equal(heightOf({ name: '风笛手', costume: '苏格兰裙' }), MAN_HEIGHT, 'nor is a kilt')
  assert.equal(heightOf({ name: '小妹', age: '七岁' }), 1.34)
  assert.equal(heightOf({ name: '巨人', height: 2.05 }), 2.05, 'said outright, it is taken')
  const boy = { id: 'c4', name: '杰姆', age: '十四五岁少年', costume: '短打上衣', look: '圆脸' }
  const scene = room([step('b1', 'chest', { face: '杰姆抬头。', faceCast: ['杰姆'] })])
  assert.deepEqual(onStageFrom([...cast, boy], scene), [{ cast: 'c4', by: 'b1', height: 1.62 }])
  assert.deepEqual(onStageFrom(cast, room([step('b1', 'chest', { face: '老板抬头。', faceCast: ['老板'] })])), [{ cast: 'c2', by: 'b1' }], 'a grown man is written as before')
  assert.equal(personBox({ x: 0, z: 0, height: 1.62 }).size[1], 1.62)
  assert.equal(personBox({ x: 0, z: 0 }).size[1], MAN_HEIGHT)
})

test('the stage places someone as tall as they are, and says so for the game', () => {
  const boy = { id: 'c4', name: '杰姆', age: '十四五岁少年', costume: '短打上衣', look: '圆脸' }
  const scene = room([step('b1', 'chest', { face: '杰姆抬头。', faceCast: ['杰姆'] })])
  const placed = { ...scene, onStage: onStageFrom([...cast, boy], scene) }
  assert.equal(stageOf(placed).data.people[0].height, 1.62)
})

// ---------------------------------------------------------------- walking over to talk
test('someone who speaks from across the room walks over; near enough, they stay where they are', () => {
  const apart = thingsApart(room())
  assert.ok(apart('pillar', 'chest') > 4, 'the pillar and the chest are across the room from each other')
  assert.ok(apart('chest', 'couch') < 4)
  const talks = (where, beat) => room([
    step('b1', where, { face: '老板站着。', faceCast: ['老板'] }),
    step('b2', beat, { face: '老板开口。', faceCast: ['老板'], lines: [{ who: '老板', says: '在这儿。' }] }),
  ])
  const across = talks('pillar', 'chest')
  assert.deepEqual(onStageFrom(cast, across, [], thingsApart(across)), [{ cast: 'c2', by: 'b1', until: 'b2' }, { cast: 'c2', by: 'b2', after: 'b2', key: 'c2#1' }])
  const near = talks('couch', 'chest')
  assert.deepEqual(onStageFrom(cast, near, [], thingsApart(near)), [{ cast: 'c2', by: 'b1' }])
  assert.deepEqual(onStageFrom(cast, across), [{ cast: 'c2', by: 'b1' }], 'without knowing where things are, nobody is moved')
  // Seen walking over in the take.
  const placed = { ...across, onStage: onStageFrom(cast, across, [], thingsApart(across)) }
  const [pushIn] = clipOf(placed, 'b2').parts
  assert.match(pushIn.text, /动作进行时，老板从画面[^，。]+走到画面[^，。]+站定/)
})
