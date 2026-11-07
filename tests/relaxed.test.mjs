import assert from 'node:assert/strict'
import test from 'node:test'
import { composeDetails, objectShare, regionsFor } from '../platform/detail.mjs'
import { OBJECT_COLOURS } from '../runtime/objectColours.js'
import { boundsFromPaint, footprintOf, isColourMap, labelThings, nearestWalkable, reachableFrom } from '../runtime/paintedThings.js'
import { buildGraph, stageOf } from '../platform/graph.mjs'
import { misplacedThings, roomSplitScore } from '../platform/metrics.mjs'
import { platePrompts } from '../platform/prompts.mjs'
import { hiddenShare, narrowPassages } from '../platform/stage.mjs'
import { figureTint, flicker, shadowFrom } from '../runtime/atmosphere.js'
import { fillSmallHoles } from '../runtime/draftHoles.js'
import { createFollowCamera, shotPose, solvePose } from '../runtime/followCamera.js'
import { normalizeStage, shellFrom, walkableIn } from '../runtime/shell.js'

const objects = [
  { id: 'table', name: '长桌', archetype: 'table', x: -1, z: 0.5, look: '胡桃木长桌' },
  { id: 'lamp', name: '台灯', archetype: 'lamp', on: 'table', dx: -0.3, dz: -0.05, look: '黄铜台灯', glow: { color: '#ffb46a', radius: 1.5 } },
  { id: 'pillar', name: '石柱', archetype: 'pillar', x: -3.9, z: 1, look: '石柱' },
  { id: 'shelf', name: '书架', archetype: 'shelf', x: 0.5, z: -3.7, look: '书架' },
  { id: 'chest', name: '木箱', archetype: 'chest', x: 4.2, z: -1.5, look: '木箱' },
  { id: 'cabinet', name: '高柜', archetype: 'cabinet', x: 5.8, z: 1.5, look: '高柜' },
  { id: 'couch', name: '沙发', archetype: 'couch', x: 3, z: 2.28, look: '沙发' },
]
const beat = (id, object) => ({ id, object, objectName: object, objective: `看${object}`, performed: true, action: '手的特写。' })
const sceneWith = extra => ({
  id: 's1', title: '阅览室', place: '旧阅览室', mood: '台灯的暖光', openingLine: '开场', endingLine: '结尾',
  stage: { kind: 'indoor', exit: 'door', width: 12, depth: 7.4, doorAt: 1 / 6 },
  objects, props: [], beats: [beat('shelf', 'shelf'), beat('chest', 'chest')],
  exit: { name: '木门', beyond: '走廊', objective: '推门' },
  film: { opening: { action: '开场。' }, ending: { action: '结尾。' } },
  ...extra,
})
const projectWith = scene => ({ id: 'test', story: '故事', style: '写实', provider: 'mock', cast: [{ id: 'c1', name: '我', playable: true, costume: '外套', look: '短发' }], scenes: [scene] })
const relaxedScene = () => sceneWith({ paint: 'relaxed', stage: { kind: 'indoor', exit: 'door', width: 12, depth: 7.4, doorAt: 1 / 6, lens: 'low' } })
const nodeOf = (project, name) => buildGraph(project).find(node => node.id === `scene:s1:${name}`)

test('the low lens is only for a scene that asks for it', () => {
  assert.deepEqual(Object.keys(normalizeStage({ width: 10 })).includes('lens'), false)
  const usual = shellFrom({ width: 12, depth: 7.4 })
  const low = shellFrom({ width: 12, depth: 7.4, lens: 'low' })
  assert.ok(low.CAMERAS.a.position[1] < usual.CAMERAS.a.position[1])
  assert.ok(low.CAMERAS.b.position[1] < usual.CAMERAS.b.position[1])
  assert.deepEqual(usual.CAMERAS.a.position, shellFrom({ width: 12, depth: 7.4 }).CAMERAS.a.position)
})

test('the room can still be walked and filmed from the low lens', () => {
  const stage = stageOf(relaxedScene())
  assert.deepEqual(stage.issues.filter(issue => issue.level === 'error'), [])
})

test('a scene that did not ask to be painted loosely has exactly the steps it always had', () => {
  const project = projectWith(sceneWith())
  const nodes = buildGraph(project)
  assert.equal(nodes.some(node => node.kind === 'refine' || node.kind === 'composeDetail'), false)
  assert.equal(nodeOf(project, 'a_closed').kind, 'image')
  assert.ok(nodeOf(project, 'a_closed').params.gate.guide)
  assert.ok(nodeOf(project, 'b').params.gate.guide)
  assert.equal(nodeOf(project, 'a_matte'), undefined)
  assert.equal(stageOf(project.scenes[0]).data.relaxed, undefined)
  assert.equal(nodeOf(project, 'guides').params.shape.relaxed, undefined)
  assert.equal(platePrompts(project, project.scenes[0], stageOf(project.scenes[0])).a_paint, undefined)
})

test('a loosely painted picture is checked for its room, not for filling its blocks', () => {
  const project = projectWith(relaxedScene())
  const paint = nodeOf(project, 'a_paint')
  assert.equal(paint.params.gate.guide, undefined)
  assert.equal(paint.params.gate.room, 'scenes/s1/clay_a_mask.png')
  assert.deepEqual(paint.params.references, ['scenes/s1/clay_a_closed.png'])
  assert.doesNotMatch(paint.params.prompt, /正好填满/)
  assert.doesNotMatch(paint.params.prompt, /光线柔和均匀/)
  assert.match(paint.params.prompt, /不能有方块感/)
  assert.match(paint.params.prompt, /台灯的暖光/)
})

test('the picture everything reads is the one with the repainted parts laid back in', () => {
  const project = projectWith(relaxedScene())
  const final = nodeOf(project, 'a_closed')
  assert.equal(final.kind, 'composeDetail')
  assert.deepEqual(final.outputs, ['scenes/s1/plate_a_closed.png'])
  assert.ok(final.deps.includes('scene:s1:a_paint'))
  const details = buildGraph(project).filter(node => node.id.startsWith('scene:s1:a_closed_detail_'))
  assert.ok(details.length >= 1)
  for (const detail of details) {
    assert.equal(detail.kind, 'refine')
    assert.equal(detail.resource, 'image')
    assert.ok(final.deps.includes(detail.id))
  }
  assert.ok(nodeOf(project, 'a_open_raw').deps.includes('scene:s1:a_closed'))
})

// Shown the finished picture, the model painted the first camera's view again, three times running.
test('the second camera is not shown the first camera\'s finished picture', () => {
  const paint = nodeOf(projectWith(relaxedScene()), 'b_paint')
  assert.deepEqual(paint.params.references, ['scenes/s1/guide_b_draft.png', 'scenes/s1/clay_b_full_mask.png'])
  assert.doesNotMatch(paint.params.prompt, /图3/)
  assert.equal(paint.params.gate.room, 'scenes/s1/clay_b_full_mask.png')
  assert.ok(paint.deps.includes('scene:s1:guide_draft'))
})

test('what only shows at the edge of the first picture is still described', () => {
  const scene = relaxedScene()
  const stage = stageOf(scene)
  const atEdge = stage.blocks.filter(block => block.paintedBy)
  assert.ok(atEdge.length > 0)
  const { a_paint: paint } = platePrompts(projectWith(scene), scene, stage)
  for (const block of atEdge) assert.ok(paint.includes(block.look), block.label)
  assert.match(paint, /硬边影子只是渲染痕迹/)
})

test('the shots wait for the mattes that hide the player', () => {
  const project = projectWith(relaxedScene())
  const frames = nodeOf(project, 'frames')
  assert.ok(frames.deps.includes('scene:s1:a_matte') && frames.deps.includes('scene:s1:b_matte'))
  assert.ok(frames.inputs.includes('scenes/s1/plate_b_matte.png'))
  assert.equal(nodeOf(project, 'a_matte').params.hint.kind, 'matte')
})

test('the stage tells the game what glows', () => {
  const { data } = stageOf(relaxedScene())
  assert.equal(data.relaxed, true)
  assert.equal(data.glows.length, 1)
  assert.equal(data.glows[0].color, '#ffb46a')
})

test('parts to repaint fit the picture, and a lamp goes with its table', () => {
  const stage = stageOf(relaxedScene())
  for (const camera of ['a', 'b']) {
    const regions = regionsFor(stage, camera)
    assert.ok(regions.length >= 1 && regions.length <= 3, `${camera}: ${regions.length}`)
    for (const { x, y, side } of regions) {
      assert.ok(x >= 0 && y >= 0 && x + side <= 2560 && y + side <= 1440, JSON.stringify({ x, y, side }))
    }
  }
  const withTable = regionsFor(stage, 'a', 7).find(region => region.labels.includes('长桌'))
  assert.ok(withTable?.labels.includes('台灯'))
  assert.equal(regionsFor(stage, 'a', 7).some(region => region.labels.includes('石柱')), false)
})

test('a repainted part goes back in without touching what is around it', () => {
  const width = 100
  const height = 100
  const base = new Uint8ClampedArray(width * height * 4).fill(100)
  const side = 40
  const detail = new Uint8ClampedArray(side * side * 4).fill(200)
  const out = composeDetails({ base, width, height, regions: [{ x: 30, y: 30, side }], details: [detail] })
  const at = (x, y) => out[(y * width + x) * 4]
  assert.equal(at(10, 10), 100)
  assert.equal(at(29, 50), 100)
  assert.ok(at(30, 50) <= 101, 'the edge is still the old picture')
  // Asked to come out lighter by far more than a model's tone drift, its colour is pulled back towards the old.
  assert.ok(at(50, 50) > 100 && at(50, 50) < 200)
  assert.equal(base[0], 100, 'the original is not changed')
})

test('a room that has moved scores lower than one that has not', () => {
  const width = 80
  const height = 80
  const paint = line => {
    const pixels = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.fill(y < line ? 40 : 170, (y * width + x) * 4, (y * width + x) * 4 + 3)
    return pixels
  }
  const mask = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) mask.fill(y < 40 ? 0 : 120, (y * width + x) * 4, (y * width + x) * 4 + 3)
  assert.equal(roomSplitScore(mask, paint(40), width, height), 1)
  assert.ok(roomSplitScore(mask, paint(64), width, height) < 0.8)
})

test('a figure dims in the dark and takes a little of the colour around it', () => {
  const lit = figureTint([230, 180, 120])
  const dark = figureTint([24, 22, 26])
  assert.ok(lit[0] > dark[0] * 1.5)
  assert.ok(lit[0] > lit[2], 'warm light warms it')
  for (const channel of [...lit, ...dark]) assert.ok(channel > 0 && channel <= 1)
})

test('the shadow falls away from the nearest lamp and fades with distance', () => {
  const glows = [{ position: [0, 1, 0] }]
  const near = shadowFrom(glows, 1, 0)
  const far = shadowFrom(glows, 8, 0)
  assert.ok(near.offset[0] < 0, 'the light stands on the lamp side')
  assert.ok(near.opacity > far.opacity)
  assert.equal(shadowFrom([], 1, 1), null)
})

test('small grey holes in a draft are filled in, and a wall still to paint is left', () => {
  const width = 40
  const height = 40
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let at = 0; at < pixels.length; at += 4) pixels.set([100, 50, 20, 255], at)
  const grey = (x0, y0, x1, y1) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) pixels.set([173, 173, 173, 255], (y * width + x) * 4)
  }
  grey(5, 5, 8, 8) // Small: the shape of something in the way.
  grey(20, 0, 40, 40) // Big: wall nobody has painted.
  const isGrey = (data, at) => data[at] === 173 && data[at + 1] === 173
  const filled = fillSmallHoles(pixels, width, height, isGrey, 50)
  assert.equal(filled, 9)
  assert.deepEqual([...pixels.subarray((6 * width + 6) * 4, (6 * width + 6) * 4 + 3)], [100, 50, 20])
  assert.deepEqual([...pixels.subarray((20 * width + 30) * 4, (20 * width + 30) * 4 + 3)], [173, 173, 173])
})

test('the second camera is told when the door is out of its sight, and to keep things where they stand', () => {
  const scene = relaxedScene()
  const { b_paint: paint } = platePrompts(projectWith(scene), scene, stageOf(scene))
  assert.match(paint, /这个机位看不到木门/)
  assert.match(paint, /不得左右挪动/)
})

const fixedObjects = () => {
  const place = { table: [-2, -0.7], pillar: [-4.1, 0.2], shelf: [-0.1, -3.7], chest: [3.6, -2.6], cabinet: [4.3, -0.4], couch: [2.1, 0.3] }
  return objects.map(object => (place[object.id] ? { ...object, x: place[object.id][0], z: place[object.id][1] } : object))
}
const fixedScene = () => sceneWith({ paint: 'relaxed', stage: { kind: 'indoor', exit: 'door', width: 10, depth: 7.6, doorAt: 0.1, lens: 'fixed' }, objects: fixedObjects() })

test('a fixed view has one camera, square on to the back wall, that never moves or changes', () => {
  const { CAMERAS: { a, b }, CAMERA_SWITCH } = shellFrom({ width: 10, depth: 7.6, lens: 'fixed' })
  assert.equal(a.position[0], a.target[0], 'square on')
  assert.equal(a.position[0], 0, 'in the middle of the room')
  assert.deepEqual(a.position, b.position)
  assert.ok(!(8 > CAMERA_SWITCH.toB), 'no place in the room switches to another camera')
  assert.deepEqual(solvePose(a, { x: 4, z: 3 }).position, a.position)
  assert.equal(solvePose(a, { x: -4, z: -3 }).fov, a.fov)
  assert.deepEqual(shotPose(a, { x: 4, z: 3 }, 2).target, a.target)
  const follow = createFollowCamera({ a, b })
  follow.snapTo(solvePose(a, { x: 0, z: 0 }), 'a')
  follow.turn(0.3, 0.2)
  follow.update({ x: 4, z: 2 }, 'a', 0.5)
  assert.deepEqual(follow.pose.target, a.target)
  assert.deepEqual(follow.look, { yaw: 0, pitch: 0 })
})

test('the whole fixed room can be walked and filmed', () => {
  const stage = stageOf(fixedScene())
  assert.deepEqual(stage.issues.filter(issue => issue.level === 'error'), [])
  assert.equal(stage.shell.DOOR.x, -4)
  for (const beat of stage.data.story.beats.filter(entry => entry.clip)) assert.equal(beat.camera, 'a')
})

test('a fixed view needs one picture: no second camera is painted', () => {
  const project = projectWith(fixedScene())
  const nodes = buildGraph(project)
  assert.equal(nodes.some(node => node.id.includes('b_paint') || node.id.includes('guide_draft') || node.id.includes(':b_detail')), false)
  assert.equal(nodeOf(project, 'corridor'), undefined, 'the picture with the door open already shows the corridor from here')
  assert.ok(nodeOf(project, 'a_open_raw'))
  assert.equal(nodeOf(project, 'b').kind, 'copy')
  assert.equal(nodeOf(project, 'b').params.from, 'scenes/s1/plate_a_closed.png')
  assert.equal(nodeOf(project, 'b_matte').kind, 'copy')
  assert.equal(nodeOf(project, 'a_matte').resource, 'image')
  const painted = nodes.filter(node => node.id.startsWith('scene:s1:') && node.resource === 'image' && !node.id.includes('prop_'))
  assert.ok(painted.length <= 7, `${painted.length} pictures`)
  assert.ok(nodeOf(project, 'frames').deps.includes('scene:s1:b_matte'))
})

test('each thing gets its own colour in the picture that tells them apart', () => {
  const scene = fixedScene()
  const stage = stageOf(scene)
  const { a_matte: prompt } = platePrompts(projectWith(scene), scene, stage)
  stage.blocks.forEach((block, index) => assert.ok(prompt.includes(`${block.label}涂成${OBJECT_COLOURS[index].name}`), block.label))
  assert.ok(stage.blocks.length <= OBJECT_COLOURS.length)
})

// A little picture for the tests: letters are colours, . is green keyed out, # is a drawn line.
const pictureOf = rows => {
  const colours = { k: [0, 117, 254, 255], l: [0, 187, 255, 255], r: [255, 0, 0, 255], d: [170, 27, 61, 255], m: [222, 23, 211, 255], b: [30, 110, 240, 255], y: [250, 240, 120, 255], c: [0, 255, 255, 255], w: [250, 250, 250, 255], o: [255, 128, 0, 255], '#': [10, 10, 10, 255], '.': [0, 255, 0, 0] }
  const width = rows[0].length
  const pixels = new Uint8ClampedArray(width * rows.length * 4)
  rows.forEach((row, y) => [...row].forEach((letter, x) => pixels.set(colours[letter], (y * width + x) * 4)))
  return { pixels, width, height: rows.length }
}
const nearEverything = () => true
const nothingNear = () => false

test('an impure colour near its thing is still that thing', () => {
  const picture = pictureOf(['bbbb', 'bbbb', 'bbbb', 'bbbb'])
  const labels = labelThings({ ...picture, things: 2, isNear: nearEverything })
  assert.ok(labels.every(label => label === 1))
})

test('what is painted inside a thing is that thing, whatever its colour', () => {
  // A lock on a chest, kept pale, is nearest to white. White is another thing, standing somewhere else.
  const picture = pictureOf([
    'cccccc',
    'ccwwcc',
    'ccwwcc',
    'cccccc',
    'cccccc',
  ])
  const labels = labelThings({ ...picture, things: 6, isNear: thing => thing === 4 })
  assert.ok(labels.every(label => label === 4))
})

// Seen on 《闭馆之后》: the gaps between the books on a shelf, dark red and right behind the table, were taken for the
// table, and a piece of the shelf was laid over the player whenever they stood behind it.
test('a colour near a thing but unlike it belongs to what it is inside', () => {
  const picture = pictureOf([
    'mmmmmmmmmmmm',
    'mmddddddddmm',
    'mmddddddddmm',
    'mmmmmmmmmmmm',
    'rrrrrrrrrrrr',
    'rrrrrrrrrrrr',
    'rrrrrrrrrrrr',
    'rrrrrrrrrrrr',
  ])
  const labels = labelThings({ ...picture, things: 4, isNear: nearEverything })
  const at = (x, y) => labels[y * 12 + x]
  assert.equal(at(5, 2), 3, 'the dark red gap is the shelf')
  assert.equal(at(5, 6), 0, 'the table is still the table')
})

// Seen on 《闭馆之后》: the lamp's base came out paler than its shade, nearer the cyan asked of the chest across the room.
test('a paler part of a thing goes by that thing\'s own colour, not the colour it was asked for', () => {
  const picture = pictureOf([
    'kkkkkkkkkkkk........cccccccc',
    'kkkkkkkkkkkk........cccccccc',
    '.....llll...........cccccccc',
    '.....llll...........cccccccc',
  ])
  const labels = labelThings({ ...picture, things: 5, isNear: (thing, at) => (thing === 1 ? at % 28 < 14 : thing === 4 ? at % 28 >= 20 : false) })
  assert.equal(labels[2 * 28 + 6], 1, 'the base is the lamp')
  assert.equal(labels[25], 4, 'the chest is still the chest')
})

// Seen on 《闭馆之后》: the lamp's stem was too pale to be its shade's colour, touched the bookcase, and went to it.
test('paint of no clear colour inside a thing\'s block is that thing, and green inside it stays floor', () => {
  const width = 12
  const picture = pictureOf([
    'kkkkkkmmmmmm',
    'kkkkkkmmmmmm',
    'kkkkkkmmmmmm',
    '..##..mmmmmm',
    '..dd..mmmmmm',
    '..dd..mmmmmm',
  ])
  const isLamp = at => at % width < 6
  const blockAt = Int8Array.from({ length: width * 6 }, (_, at) => (isLamp(at) ? 1 : 3))
  const labels = labelThings({ ...picture, things: 4, isNear: (thing, at) => (thing === 1 ? isLamp(at) : thing === 3 ? !isLamp(at) : false), blockAt })
  assert.equal(labels[4 * width + 2], 1, 'the stem')
  assert.equal(labels[3 * width + 2], 1, 'a line on it')
  assert.equal(labels[4 * width + 0], -1, 'the wall beside the stem')
  assert.equal(labels[4 * width + 8], 3, 'the bookcase')
})

// Seen on 《闭馆之后》: a dark edge of the bookcase crossed the lamp's block, and was laid over the player as lamp.
test('another thing\'s dark edge across a block stays with that other thing', () => {
  const width = 12
  const colours = pictureOf(['kkkkkkmmmmmm', 'kkkkkkmmmmmm', 'kkkkkkmmmmmm', 'kkkkkkmmmmmm'])
  // Column 5 is the shelf's dark edge, reaching into the lamp's block.
  for (let y = 0; y < 4; y++) colours.pixels.set([150, 10, 140, 255], (y * width + 5) * 4)
  const blockAt = Int8Array.from({ length: width * 4 }, (_, at) => (at % width < 6 ? 1 : 3))
  const labels = labelThings({ ...colours, things: 4, isNear: (thing, at) => (thing === 1 ? at % width < 6 : thing === 3 ? at % width >= 4 : false), blockAt })
  assert.equal(labels[width + 5], 3)
  assert.equal(labels[width + 2], 1)
})

// Seen on 《闭馆之后》: the bookcase stands a metre from its block, and the strip of its base showing under the table
// was given to the table, so it hid the legs of a player standing behind.
test('a part of a thing far from its block is still that thing, if it is within what is painted of it', () => {
  const picture = pictureOf([
    'mmmmmmmmmmmmmmmm',
    'mmmmmmmmmmmmmmmm',
    'mmmmmmmmmmmmmmmm',
    'mmmmmmmmmmmmmmmm',
    'rrrrrrrrrrrrrrrm',
    'rrrrrrrrrrrrrrrm',
    '###############m',
    'mmmmmmmmmmmmmm#m',
  ])
  const labels = labelThings({ ...picture, things: 4, isNear: (thing, at) => thing === 0 || (thing === 3 && at % 16 >= 4 && (at - (at % 16)) / 16 < 4) })
  assert.equal(labels[7 * 16 + 1], 3, 'the strip under the table')
})

test('a patch near nothing that is its own stays out of everything', () => {
  // A window on the wall, painted in the lamp's colour.
  const picture = pictureOf([
    '........',
    '.bb.....',
    '.bb.....',
    '........',
  ])
  const labels = labelThings({ ...picture, things: 2, isNear: nothingNear })
  assert.ok(labels.every(label => label === -1))
})

test('a thing\'s outline is part of it, and lines drawn on the wall are not', () => {
  const row = (left, right) => left + '.'.repeat(30 - left.length - right.length) + right
  const picture = pictureOf([
    row('rrrrrr#', '####'),
    row('rrrrrr#', '####'),
    row('rrrrrr#', ''),
  ])
  const labels = labelThings({ ...picture, things: 1, isNear: nearEverything })
  assert.equal(labels[6], 0, 'the outline joins the thing')
  assert.equal(labels[29], -1, 'a line out on the wall joins nothing')
})

test('a real picture of flat colours is told from a plain cut-out', () => {
  assert.equal(isColourMap(pictureOf(['rrr', 'ccc', '...']).pixels), true)
  const painted = new Uint8ClampedArray(400)
  for (let at = 0; at < 400; at += 4) painted.set([90, 60, 40, 255], at)
  assert.equal(isColourMap(painted), false)
})

const floorOf = (x, y) => ({ x, z: y })
const sameColumn = x => x

test('a thing stands where its paint meets the floor', () => {
  const picture = pictureOf([
    '..............',
    '..rrrrrrrrrr..',
    '..rrrrrrrrrr..',
    '..rrrrrrrrrr..',
    '..rrrrrrrrrr..',
    '..rrrrrrrrrr..',
    '..............',
    '..............',
  ])
  const labels = labelThings({ ...picture, things: 1, isNear: nearEverything })
  const footprint = footprintOf(labels, 0, 14, 8, floorOf, sameColumn, -9)
  assert.deepEqual(footprint, { minX: 2, maxX: 11, frontZ: 5, footSeen: true })
})

// Seen on 《闭馆之后》: the table hid the foot of the shelf behind it, so the shelf's left side had no collision at all.
test('how wide a thing is comes from its outline, even with its foot hidden', () => {
  const picture = pictureOf([
    '................',
    'mmmmmmmmmmmmmmm.',
    'mmmmmmmmmmmmmmm.',
    'mmmmmmmmmmmmmmm.',
    'mmmmmmmmmmmmmmm.',
    'mmmmmmmmmmmmmmm.',
    'mmmmmmmmmmmmmmm.',
    'mmmmmmmmmmmmmmm.',
    'rrrrrrrmmmmmmmm.',
    'rrrrrrrmmmmmmmm.',
    'rrrrrrr.........',
    '................',
    '................',
  ])
  const labels = labelThings({ ...picture, things: 4, isNear: nearEverything })
  const footprint = footprintOf(labels, 3, 16, 13, floorOf, sameColumn, -9)
  assert.equal(footprint.minX, 0, 'the side the table hides the foot of')
  assert.equal(footprint.maxX, 14)
  assert.equal(footprint.frontZ, 9)
})

test('with no foot to be seen, a thing stays where its block says', () => {
  const picture = pictureOf([
    '................',
    '..cccccccccccc..',
    '..cccccccccccc..',
    '..cccccccccccc..',
    '..cccccccccccc..',
    '..cccccccccccc..',
    '..oooooooooooo..',
    '..oooooooooooo..',
    '................',
    '................',
  ])
  const labels = labelThings({ ...picture, things: 7, isNear: nearEverything })
  const footprint = footprintOf(labels, 4, 16, 10, floorOf, sameColumn, -9)
  assert.equal(footprint.footSeen, false)
  assert.equal(footprint.frontZ, -9)
  assert.equal(footprint.minX, 2)
})

test('a thing not in the picture has no footprint', () => {
  const labels = labelThings({ ...pictureOf(['rrrrrrrr', 'rrrrrrrr']), things: 4, isNear: nearEverything })
  assert.equal(footprintOf(labels, 2, 8, 2, floorOf, sameColumn, -9), null)
})

test('the underside of a table top does not bring its front edge forward or widen it', () => {
  // Legs on the floor at the front, and the top's underside, which carried to the floor lands far back and far out.
  const picture = pictureOf([
    '................',
    '.rrrrrrrrrrrrrr.',
    '.rrrrrrrrrrrrrr.',
    '.rr..........rr.',
    '.rr..........rr.',
    '.rr..........rr.',
    '................',
    '................',
    '................',
    '................',
  ])
  const labels = labelThings({ ...picture, things: 1, isNear: nearEverything })
  const carried = (x, y) => (y >= 5 ? { x, z: 5 } : { x: (x - 8) * 4 + 8, z: 1 })
  const { minX, maxX, frontZ } = footprintOf(labels, 0, 16, 10, carried, sameColumn, -9)
  assert.deepEqual({ minX, maxX, frontZ }, { minX: 1, maxX: 14, frontZ: 5 })
})

test('where something else hides a thing\'s foot, that edge says nothing about the floor', () => {
  // The chest's lowest edge on the left is the top of the couch standing in front of it.
  const picture = pictureOf([
    '............',
    '..cccccccc..',
    '..cccccccc..',
    '..oooocccc..',
    '..oooocccc..',
    '..oooo......',
    '............',
    '............',
  ])
  const labels = labelThings({ ...picture, things: 7, isNear: nearEverything })
  const points = []
  footprintOf(labels, 4, 12, 8, (x, y) => { points.push(x); return { x, z: y } }, sameColumn, -9)
  assert.deepEqual(points, [6, 7, 8, 9])
})

test('collision follows the paint forward and sideways, and only so far', () => {
  const block = { center: [0, 1, -3.7], size: [2.5, 2, 0.5] }
  const painted = boundsFromPaint(block, { minX: -1.7, maxX: 1.6, frontZ: -2.9 })
  assert.deepEqual(painted, { minX: -1.7, maxX: 1.6, minZ: -3.95, maxZ: -2.9 })
  const asBlocked = { minX: -1.25, maxX: 1.25, minZ: -3.95, maxZ: -3.45 }
  assert.deepEqual(boundsFromPaint(block, null), asBlocked)
  assert.deepEqual(boundsFromPaint(block, { minX: -5, maxX: 1.6, frontZ: -2.9 }), asBlocked, 'that is not this thing')
  // Nearly all of it behind something else, so only this much of its foot shows.
  assert.deepEqual(boundsFromPaint(block, { minX: 0.9, maxX: 1.2, frontZ: -3.6 }), asBlocked, 'a hidden foot does not shrink it')
})

// Seen on 《闭馆之后》: the table painted forward of its block kept the block's back edge, and shut the way to the door.
test('a thing painted forward moves forward whole, unless it is against the wall', () => {
  const table = { center: [-1.7, 0.4, -1.9], size: [2, 0.85, 1] }
  assert.deepEqual(boundsFromPaint(table, { minX: -2.7, maxX: -0.7, frontZ: -1 }), { minX: -2.7, maxX: -0.7, minZ: -2, maxZ: -1 })
  const shelf = { center: [0, 1, -3.7], size: [2.5, 2, 0.5] }
  assert.equal(boundsFromPaint(shelf, { minX: -1.25, maxX: 1.25, frontZ: -2.75 }).minZ, -3.95, 'nobody walks round behind it')
})

test('a mark moves off what it has come to stand on, and a walled-off place is not reached', () => {
  const walkable = (x, z) => Math.abs(x) < 3 && Math.abs(z) < 3 && !(x > 0 && x < 1)
  const moved = nearestWalkable({ x: 0.4, z: 0 }, walkable)
  assert.ok(walkable(moved.x, moved.z) && Math.hypot(moved.x - 0.4, moved.z) < 0.6)
  assert.deepEqual(nearestWalkable({ x: -1, z: 0 }, walkable), { x: -1, z: 0 })
  const reached = reachableFrom({ x: -2, z: 0 }, walkable)
  assert.equal(reached({ x: -1, z: 2 }), true)
  assert.equal(reached({ x: 2, z: 0 }), false)
})

test('every colour is different, and none is the black of a drawn line', () => {
  assert.equal(new Set(OBJECT_COLOURS.map(colour => colour.hex)).size, OBJECT_COLOURS.length)
  assert.equal(OBJECT_COLOURS.some(colour => Math.max(...colour.rgb) < 70), false)
})

test('the matte comes from the first painting, and the repainted parts wait for it', () => {
  const project = projectWith(fixedScene())
  const matte = nodeOf(project, 'a_matte')
  assert.deepEqual(matte.params.references, ['scenes/s1/plate_a_paint.png'])
  assert.deepEqual(matte.deps, ['scene:s1:a_paint'])
  const final = nodeOf(project, 'a_closed')
  assert.ok(final.deps.includes('scene:s1:a_matte'))
  assert.equal(final.params.matte, 'scenes/s1/plate_a_matte.png')
  assert.ok(final.inputs.includes('scenes/s1/plate_a_matte.png'))
})

test('a repainted part goes back in over the thing, and the floor around it stays as it was', () => {
  const width = 60
  const height = 60
  const base = new Uint8ClampedArray(width * height * 4).fill(100)
  const side = 40
  const detail = new Uint8ClampedArray(side * side * 4).fill(120)
  const matte = new Uint8ClampedArray(width * height * 4)
  for (let at = 0; at < matte.length; at += 4) matte.set([0, 255, 0, 255], at)
  for (let y = 22; y < 38; y++) for (let x = 22; x < 38; x++) matte.set([255, 0, 0, 255], (y * width + x) * 4)
  const keep = objectShare(matte, width, height)
  const out = composeDetails({ base, width, height, regions: [{ x: 10, y: 10, side }], details: [detail], keep })
  const at = (x, y) => out[(y * width + x) * 4]
  assert.equal(at(15, 15), 100, 'floor inside the square, away from the thing, is untouched')
  assert.ok(at(14, 30) === 100)
  assert.ok(keep[30 * width + 30] > 0.99)
  assert.equal(keep[5 * width + 5], 0)
  // Matched to what it replaces, the part brings its detail and not a change of tone.
  assert.ok(Math.abs(at(30, 30) - 100) < 3, `${at(30, 30)}`)
})

test('close framing fills the picture with the back wall and leaves little floor', () => {
  const close = shellFrom({ width: 10, depth: 5, lens: 'fixed', framing: 'close' })
  const wide = shellFrom({ width: 10, depth: 7.6, lens: 'fixed' })
  const { position } = close.CAMERAS.a
  assert.ok(position[2] + 4 < wide.CAMERAS.a.position[2] + 4 - 4, 'the camera has moved in by metres')
  assert.ok(position[1] < wide.CAMERAS.a.position[1], 'and come down')
  assert.deepEqual(normalizeStage({ framing: 'close' }).framing, undefined, 'only a fixed view frames close')
  assert.equal(wide.inFrame(40, 0), true, 'and a wide one is not narrowed')
})

test('nobody can walk out of a close picture at the sides', () => {
  const close = shellFrom({ width: 10, depth: 5, lens: 'fixed', framing: 'close' })
  const { position, target } = close.CAMERAS.a
  assert.equal(close.inFrame(0, 0), true)
  assert.equal(close.inFrame(4.7, -3.6), true, 'the back of the room is wide open')
  assert.equal(close.inFrame(4.7, 0.3), false, 'but near the camera the picture is narrow')
  const walkable = walkableIn(close, [])
  assert.equal(walkable(4.7, 0.3, false), false)
  assert.equal(position[0], target[0])
})

const closeScene = (place, depth = 4.9) => sceneWith({ paint: 'relaxed', stage: { kind: 'indoor', exit: 'door', width: 10, depth, doorAt: 0.16, lens: 'fixed', framing: 'close' }, objects: objects.map(object => (place[object.id] ? { ...object, x: place[object.id][0], z: place[object.id][1] } : object)) })

test('the close room can be walked and filmed as laid out, with room to walk', () => {
  const place = { table: [-1.3, -1.4], pillar: [-4.4, -3.1], shelf: [0, -3.7], chest: [3, -1.3], couch: [2.4, -3.5], cabinet: [3.95, -3.4] }
  assert.deepEqual(stageOf(closeScene(place)).issues.filter(issue => issue.level === 'error'), [])
})

// Seen on 《闭馆之后》: the player squeezed between a pillar and a table, and only found out by playing it.
test('a gap a person only just fits through stops the layout before anything is painted', () => {
  const tight = { table: [-1.7, -1.9], pillar: [-3.4, -1.7], shelf: [0, -3.7], chest: [2.6, -3.3], cabinet: [3.95, -2.7], couch: [2.25, -1.3] }
  const stage = stageOf(closeScene(tight, 4.7))
  const messages = stage.issues.filter(issue => issue.level === 'error').map(issue => issue.message)
  assert.equal(stage.ok, false)
  assert.ok(messages.some(message => message.includes('过道太窄')), messages.join(' / '))
})

test('things pushed right together are no passage at all, so they pass', () => {
  const shell = shellFrom({ width: 10, depth: 4.9, lens: 'fixed', framing: 'close' })
  const at = (x, z, w = 1, d = 1) => ({ label: `${x}`, name: `${x}`, center: [x, 0.5, z], size: [w, 1, d] })
  assert.equal(narrowPassages(shell, [at(-1, -1.5)]).length, 0, 'one thing with room all round')
  assert.equal(narrowPassages(shell, [at(-0.5, -1.5), at(0.5, -1.5)]).length, 0, 'two things touching')
  assert.equal(narrowPassages(shell, [at(-1.2, -1.5), at(0.2, -1.5)]).length, 0, 'two things too close for anyone to enter')
  // The tighter the gap, the less a person's centre has room in it, so these are the ones most easily missed.
  for (const gap of [0.55, 0.6, 0.7, 0.8, 0.9, 1, 1.05]) {
    assert.ok(narrowPassages(shell, [at(-0.5 - gap / 2, -1.5, 1, 1.5), at(0.5 + gap / 2, -1.5, 1, 1.5)]).length > 0, `a gap of ${gap} m`)
  }
  for (const gap of [1.15, 1.3, 1.6, 2.1]) {
    assert.equal(narrowPassages(shell, [at(-0.5 - gap / 2, -1.5, 1, 1.5), at(0.5 + gap / 2, -1.5, 1, 1.5)]).length, 0, `a gap of ${gap} m`)
  }
})

// Seen on 《闭馆之后》: with the chest behind the couch, the model painted each where the other should be.
test('something the story uses cannot stand hidden behind something else', () => {
  const hidden = { table: [-1.3, -1.4], pillar: [-4.4, -3.1], shelf: [0, -3.7], chest: [2.75, -3.4], cabinet: [3.95, -3.4], couch: [2.8, -1.3] }
  const stage = stageOf(closeScene(hidden))
  assert.equal(stage.ok, false)
  assert.ok(stage.issues.some(issue => issue.level === 'error' && issue.object === 'chest' && issue.message.includes('挡住')))
  const standing = stage.blocks.filter(block => !block.onTop)
  assert.ok(hiddenShare(stage.blocks.find(block => block.name === 'chest'), standing, stage.shell.CAMERAS.a) > 0.25)
  assert.equal(hiddenShare(stage.blocks.find(block => block.name === 'couch'), standing, stage.shell.CAMERAS.a), 0, 'nothing stands in front of what is at the front')
})

test('two things painted in each other\'s place are found, and things in their own are not', () => {
  const width = 40
  const height = 20
  const paint = (leftColour, rightColour) => {
    const pixels = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const colour = y < 4 || y > 15 ? [0, 255, 0] : x >= 4 && x < 16 ? leftColour : x >= 24 && x < 36 ? rightColour : [0, 255, 0]
        pixels.set([...colour, 255], (y * width + x) * 4)
      }
    }
    return pixels
  }
  const scale = 2560 / width
  const things = [{ index: 4, label: '木箱', x: 10 * scale, y: 10 * scale }, { index: 6, label: '沙发', x: 30 * scale, y: 10 * scale }]
  const cyan = OBJECT_COLOURS[4].rgb
  const orange = OBJECT_COLOURS[6].rgb
  assert.deepEqual(misplacedThings(paint(cyan, orange), width, height, things), [])
  assert.deepEqual(misplacedThings(paint(orange, cyan), width, height, things), [{ label: '木箱', standsAt: '沙发' }, { label: '沙发', standsAt: '木箱' }])
})

// Seen on a real picture: a desk asked for at 570 pixels wide came out at 1570, and took the corner of the room.
test('a thing painted far too wide or too near is found, and a thin or tall one is not', () => {
  const width = 80
  const height = 45
  const scale = 2560 / width
  const paint = (x0, x1, y0, y1) => {
    const pixels = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set(x >= x0 && x < x1 && y >= y0 && y < y1 ? [...OBJECT_COLOURS[0].rgb, 255] : [0, 255, 0, 255], (y * width + x) * 4)
    return pixels
  }
  const check = (picture, wide, bottom) => misplacedThings(picture, width, height, [{ index: 0, label: '书桌', x: 40 * scale, y: 22 * scale }], { 0: { wide: wide * scale, bottom: bottom * scale } })
  assert.deepEqual(check(paint(30, 50, 15, 30), 20, 30), [], 'as blocked')
  assert.equal(check(paint(5, 75, 15, 30), 20, 30)[0].label, '书桌', 'far too wide')
  assert.equal(check(paint(30, 50, 15, 44), 20, 30)[0].label, '书桌', 'its foot far too near the camera')
  assert.deepEqual(check(paint(38, 42, 15, 30), 1, 30), [], 'many times a thin block, by a few pixels')
  assert.deepEqual(check(paint(30, 50, 1, 30), 20, 30), [], 'taller costs no floor')
})

test('a close picture stops at the check that finds things out of place, without painting it again', () => {
  const place = { table: [-1.3, -1.4], pillar: [-4.4, -3.1], shelf: [0, -3.7], chest: [3, -1.3], couch: [2.4, -3.5], cabinet: [3.95, -3.4] }
  const matte = nodeOf(projectWith(closeScene(place)), 'a_matte')
  assert.ok(matte.params.gate.things.some(thing => thing.label === '木箱'))
  assert.equal(matte.params.gate.things.some(thing => thing.label === '台灯'), false, 'what stands on something goes with it')
  assert.equal(nodeOf(projectWith(fixedScene()), 'a_matte').params.gate, undefined)
})

// Seen on 《闭馆之后》: standing right beside the chest offered nothing, because only the front of it was in reach.
test('with one camera, a thing can be used from any side of it', () => {
  const place = { table: [-1.3, -1.4], pillar: [-4.4, -3.1], shelf: [0, -3.7], chest: [3, -1.3], couch: [2.4, -3.5], cabinet: [3.95, -3.4] }
  const { data: { story: { beats } } } = stageOf(closeScene(place))
  const { target } = beats.find(beat => beat.id === 'chest')
  assert.deepEqual([target.x, target.z], [3, -1.3])
  for (const [x, z] of [[1.6, -1.5], [3, -0.2], [3, -2.2]]) assert.ok(Math.hypot(x - target.x, z - target.z) <= target.radius, `${x}, ${z}`)
})

test('a wide room is not held to this', () => {
  const stage = stageOf(fixedScene())
  assert.equal(stage.issues.some(issue => issue.message.includes('过道太窄')), false)
})

test('a close picture is told to keep the ways through, and others are not', () => {
  const place = { table: [-1.3, -1.4], pillar: [-4.4, -3.1], shelf: [0, -3.7], chest: [3, -1.3], couch: [2.4, -3.5], cabinet: [3.95, -3.4] }
  const close = closeScene(place)
  assert.match(platePrompts(projectWith(close), close, stageOf(close)).a_paint, /必须原样留出来/)
  const wide = fixedScene()
  assert.doesNotMatch(platePrompts(projectWith(wide), wide, stageOf(wide)).a_paint, /必须原样留出来/)
})

test('a lamp flickers without ever going out', () => {
  for (let seconds = 0; seconds < 60; seconds += 0.07) {
    const value = flicker(seconds, 1.3)
    assert.ok(value >= 0.7 && value <= 1.3)
  }
})
