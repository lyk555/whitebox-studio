// The others in a story standing in the room before their face shot. No test here calls a model.
import assert from 'node:assert/strict'
import test from 'node:test'
import { checkClerkAnswer } from '../platform/authoring.mjs'
import { beatFromAnswer } from '../platform/breakdown.mjs'
import { buildGraph, stageOf } from '../platform/graph.mjs'
import { inPicture, onStageFrom } from '../platform/people.mjs'
import { filmClips } from '../platform/prompts.mjs'
import { cutOutFigure } from '../platform/sprites.mjs'
import { buildStage, hiddenShare, personBox } from '../platform/stage.mjs'
import { settleWorld } from '../platform/world.mjs'
import { walkableIn } from '../runtime/shell.js'

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
// A close, fixed room that already passes as laid out (see relaxed.test.mjs).
const place = { table: [0.6, -1.9], pillar: [-4.4, -3.1], shelf: [0, -3.7], chest: [3, -1.3], couch: [2.4, -3.5], cabinet: [3.95, -3.4] }
const step = (id, object, extra = {}) => ({ id, object, objectName: { shelf: '书架', chest: '木箱' }[object], objective: `看${object}`, performed: true, action: '手的特写。', ...extra })
const room = (extra = {}) => ({
  id: 's1', title: '阅览室', place: '旧阅览室', mood: '台灯的暖光', openingLine: '开场', endingLine: '结尾', paint: 'relaxed',
  stage: { kind: 'indoor', exit: 'door', width: 10, depth: 4.9, doorAt: 0.16, lens: 'fixed', framing: 'close' },
  objects: objects.map(object => (place[object.id] ? { ...object, x: place[object.id][0], z: place[object.id][1] } : object)),
  props: [],
  // The policeman comes in at the shelf; the landlord was at the chest all along.
  beats: [
    step('shelf', 'shelf', { face: '警察推门进来，盯着我。', faceCast: ['警察'], arrives: ['警察'], settle: '书脊。' }),
    step('chest', 'chest', { face: '老板擦着箱子，抬头看我。', faceCast: ['老板'], lines: [{ who: '老板', says: '别碰它。' }], settle: '锁扣。' }),
  ],
  exit: { name: '木门', beyond: '走廊', objective: '推门' },
  film: { opening: { action: '开场。' }, ending: { action: '结尾。' } },
  ...extra,
})
const withPeople = () => {
  const scene = room()
  return { ...scene, onStage: onStageFrom(cast, scene) }
}
const projectOf = scene => ({ id: 'test', story: '故事', style: '写实', provider: 'mock', cast, scenes: [scene] })

test('who stands in a room: whoever a face shot shows, by its thing, from the start unless they come in then', () => {
  const scene = { beats: [
    { id: 'b1', faceCast: ['老板'], face: '我盯着桌面。' },
    { id: 'b2', faceCast: ['老板'], face: '对面的人压低声音。', lines: [{ who: '老板', says: '小声点。' }] },
    { id: 'b3', faceCast: ['警察', '老板'], face: '警察推门进来。', arrives: ['警察'] },
    { id: 'b4', faceCast: ['我'], face: '我笑了。' },
  ] }
  assert.deepEqual(onStageFrom(cast, scene), [{ cast: 'c2', by: 'b2' }, { cast: 'c3', by: 'b3', after: 'b3' }], 'listed but neither seen nor heard in b1, so by b2; the player never')
  const at = inPicture({ ...scene, onStage: onStageFrom(cast, scene) })
  const who = entries => entries.map(entry => entry.cast)
  assert.deepEqual(who(at('opening').first), ['c2'])
  assert.deepEqual([who(at('b3').first), who(at('b3').last)], [['c2'], ['c2', 'c3']], 'there at the end of the step they come in at')
  assert.deepEqual(who(at('b4').first), ['c2', 'c3'])
  assert.deepEqual(who(at('ending').first), ['c2', 'c3'])
})

test('a person stands near their thing, seen whole, clear of every mark, and the room can still be walked', () => {
  const scene = withPeople()
  const stage = buildStage(scene)
  assert.deepEqual(stage.issues.filter(issue => issue.level === 'error'), [])
  const { people, story: { beats }, spawn } = stage.data
  assert.deepEqual(people.map(({ id, after, file }) => ({ id, after, file })), [
    { id: 'c3', after: 'shelf', file: 'figure_c3.png' },
    { id: 'c2', after: undefined, file: 'figure_c2.png' },
  ])
  const walkable = walkableIn(stage.shell, stage.blocks)
  const standing = stage.blocks.filter(block => !block.onTop)
  for (const person of people) {
    const everyoneElse = people.filter(other => other !== person).map(personBox)
    assert.ok(walkable(person.x, person.z, false), `${person.id} stands on the floor`)
    assert.ok(hiddenShare(personBox(person), [...standing, ...everyoneElse], stage.shell.CAMERAS.a) <= 0.1, `${person.id} is not behind anything, or anyone`)
    for (const mark of [spawn, ...beats.flatMap(beat => beat.anchor ? [beat.anchor] : [])]) assert.ok(Math.hypot(person.x - mark.x, person.z - mark.z) >= 0.9)
  }
  const chest = stage.blocks.find(block => block.name === 'chest')
  const landlord = people.find(person => person.id === 'c2')
  assert.ok(Math.hypot(landlord.x - chest.center[0], landlord.z - chest.center[2]) < 3, 'by the chest')
  assert.equal(landlord.mirror, landlord.x < beats.find(beat => beat.id === 'chest').anchor.x, 'turned towards the player')
})

test('a scene that says nothing of people standing has no people, so what it filmed stays up to date', () => {
  const stage = buildStage(room())
  assert.equal('people' in stage.data, false)
  const nodes = buildGraph(projectOf(room()))
  assert.equal(nodes.some(node => /:figure$|:cutout$/.test(node.id)), false)
  const frames = nodes.find(node => node.id === 'scene:s1:frames')
  assert.equal('people' in frames.params.shape, false)
  for (const clip of filmClips(projectOf(room()), room(), stageOf(room()))) {
    for (const part of clip.parts) {
      assert.equal(/这里说到的这些人|看不清脸|走进来的/.test(part.text), false, `${clip.id}: ${part.text}`)
    }
  }
})

test('each person standing gets one picture, cut out; only the frames wait for it and hear of where they stand', () => {
  const scene = withPeople()
  const nodes = buildGraph(projectOf(scene))
  const figure = nodes.find(node => node.id === 'cast:c2:figure')
  assert.deepEqual(figure.params.references, ['cast/c2/plate_face.png'])
  assert.match(figure.params.prompt, /围裙/)
  assert.match(figure.params.prompt, /#00FF00/)
  assert.deepEqual(nodes.find(node => node.id === 'cast:c2:cutout').outputs, ['cast/c2/figure_c2.png'])
  assert.equal(nodes.some(node => node.id === 'cast:c1:figure'), false, 'the player walks, and has a figure already')
  const frames = nodes.find(node => node.id === 'scene:s1:frames')
  assert.ok(frames.inputs.includes('cast/c2/figure_c2.png') && frames.inputs.includes('cast/c3/figure_c3.png'))
  assert.ok(frames.deps.includes('cast:c3:cutout'))
  assert.equal(frames.params.shape.people.length, 2)
  const guides = nodes.find(node => node.id === 'scene:s1:guides')
  assert.deepEqual(guides.params, buildGraph(projectOf(room())).find(node => node.id === 'scene:s1:guides').params, 'nothing painted is made again for them')
})

test('the shots pinned to the game say who stands there and keep back from faces; the face shot is as it was', () => {
  const scene = withPeople()
  const project = projectOf(scene)
  const clips = filmClips(project, scene, stageOf(scene))
  const before = filmClips(projectOf(room()), room(), stageOf(room()))
  const [shelfStart, shelfFace, shelfEnd] = clips.find(clip => clip.id === 'shelf').parts
  assert.match(shelfStart.text, /第一帧里还有老板（围裙），站在画面(最左边|左侧|中间|右侧|最右边)/)
  assert.doesNotMatch(shelfStart.text, /警察（制服）/, 'not in yet')
  assert.match(shelfStart.text, /看不清脸/)
  assert.doesNotMatch(shelfStart.text, /推近到动作/)
  assert.match(shelfStart.text, /我全程不露脸/)
  assert.match(shelfStart.text, /除了这里说到的这些人，不得出现别的人物/)
  assert.match(shelfEnd.text, /尾帧里警察（制服），站在画面[^，。]+，是这时走进来的/)
  assert.match(shelfEnd.text, /特写里只拍手和东西/)
  assert.equal(shelfFace.text, before.find(clip => clip.id === 'shelf').parts[1].text)
  const opening = clips.find(clip => clip.id === 'opening').parts[0].text
  assert.match(opening, /老板（围裙）/)
  assert.doesNotMatch(opening, /警察/)
})

test('someone standing a few metres from their thing is placed by the picture alone, or a model walks them over to it', () => {
  const scene = withPeople()
  const stage = stageOf(scene)
  const moved = { ...stage, data: { ...stage.data, people: stage.data.people.map(person => person.id === 'c2' ? { ...person, x: -2.5, z: -1 } : person) } }
  const text = filmClips(projectOf(scene), scene, moved).find(clip => clip.id === 'chest').parts[0].text
  assert.match(text, /老板（围裙），站在画面(最左边|左侧)。/)
  assert.doesNotMatch(text, /木箱旁/)
  const chest = stage.blocks.find(block => block.name === 'chest')
  const beside = { ...stage, data: { ...stage.data, people: stage.data.people.map(person => person.id === 'c2' ? { ...person, x: chest.center[0] + 1.1, z: chest.center[2] } : person) } }
  assert.match(filmClips(projectOf(scene), scene, beside).find(clip => clip.id === 'chest').parts[0].text, /老板（围裙），站在画面(中间|右侧|最右边)的木箱旁。/)
})

test('whoever would show their face in the long-lens opening walks into place as it pulls back', () => {
  // Seen on 《雾都码头谜案》: the coal heaver beside the thing the film opens on, face and all, and the video model refused it.
  const scene = room()
  const opensOnChest = { ...scene, beats: [scene.beats[1], scene.beats[0]] }
  const withLandlord = { ...opensOnChest, onStage: onStageFrom(cast, opensOnChest) }
  const stage = stageOf(withLandlord)
  assert.equal(stage.data.people.find(person => person.id === 'c2').walksIn, true, 'he stands by the chest the film opens close on')
  const [opening] = filmClips(projectOf(withLandlord), withLandlord, stage).find(clip => clip.id === 'opening').parts
  assert.doesNotMatch(opening.text, /第一帧里还有老板/)
  assert.match(opening.text, /尾帧里老板（围裙），站在画面[^，。]+，是这时走进来的/)
  const [chestStart] = filmClips(projectOf(withLandlord), withLandlord, stage).find(clip => clip.id === 'chest').parts
  assert.match(chestStart.text, /第一帧里还有老板/, 'once the film has opened, he is simply there')
})

test('with a crowd in the room, the shot is told how many people there are and which one the player is', () => {
  // Seen on 《雾都码头谜案》: with three others standing, the model brought in a second player close to the camera.
  const scene = withPeople()
  const clips = filmClips(projectOf(scene), scene, stageOf(scene))
  const [chestStart, , chestEnd] = clips.find(clip => clip.id === 'chest').parts
  assert.match(chestStart.text, /画面里一共3个人。我是第一帧里画面(最左边|左侧|中间|右侧|最右边)背对镜头、穿外套的那一个/)
  assert.doesNotMatch(chestEnd.text, /一共/, 'pinned at both ends, it has nowhere to wander')
  assert.doesNotMatch(clips.find(clip => clip.id === 'shelf').parts[0].text, /一共/, 'one other is no crowd: the shot stays as it was')
})

test('a person nobody could find room for is left out of the pictures and of the words alike', () => {
  const scene = withPeople()
  const stage = stageOf(scene)
  const crowded = { ...stage, data: { ...stage.data, people: stage.data.people.filter(person => person.id !== 'c2') } }
  const text = filmClips(projectOf(scene), scene, crowded).find(clip => clip.id === 'opening').parts[0].text
  assert.doesNotMatch(text, /老板/)
})

test('a step says who comes in during it, and only of those its face shot shows', () => {
  assert.deepEqual(beatFromAnswer({ object: '吧台', face_cast: ['警察'], arrives: ['警察', '路人'] }).arrives, ['警察'])
  assert.equal('arrives' in beatFromAnswer({ object: '吧台', face_cast: ['警察'], arrives: [] }), false, 'a step with nobody coming in is kept as before')
  const { beats } = checkClerkAnswer({
    steps: [{ objective: '问话', object: '吧台', prompt: '按 E 问话', action: '手搭上吧台。', face: '警察推门进来，老板抬头。', face_cast: ['警察', '老板'], arrives: ['警察', '老板X'], gives: [], takes: [] }],
    props: [],
  }, { project: { cast }, steps: [{ lines: [], during: '', after: '' }], held: [], knownProps: [] })
  assert.deepEqual(beats[0].arrives, ['警察'])
})

test('a story made to have people standing works out who stands where whenever it is settled; an older one is left alone', () => {
  const settled = settleWorld({ cast, chapters: [], scenes: [room()], othersStand: true })
  assert.deepEqual(settled.scenes[0].onStage, [{ cast: 'c3', by: 'shelf', after: 'shelf' }, { cast: 'c2', by: 'chest' }])
  assert.equal('onStage' in settleWorld({ cast, chapters: [], scenes: [room()] }).scenes[0], false)
})

test('a figure is cut out of its green screen with its feet on the bottom edge, and the screen is gone', () => {
  const width = 40
  const height = 60
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let at = 0; at < pixels.length; at += 4) pixels.set([0, 255, 0, 255], at)
  for (let y = 10; y < 50; y++) for (let x = 15; x < 25; x++) pixels.set([120, 60, 40, 255], (y * width + x) * 4)
  const cut = cutOutFigure(pixels, width, height, 20)
  assert.deepEqual([cut.width, cut.height], [5, 20], 'trimmed to the person and made no taller than asked')
  assert.deepEqual([...cut.pixels.slice(0, 4)], [120, 60, 40, 255])
  const whole = cutOutFigure(pixels, width, height, 100)
  assert.deepEqual([whole.width, whole.height], [10, 40], 'never made bigger')
})
