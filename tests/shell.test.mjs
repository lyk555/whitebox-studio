import assert from 'node:assert/strict'
import test from 'node:test'
import { fallbackLayout } from '../platform/breakdown.mjs'
import { buildGraph } from '../platform/graph.mjs'
import { platePrompts } from '../platform/prompts.mjs'
import { applyChanges } from '../platform/setChat.mjs'
import { buildStage, wallsFirstCameraSees } from '../platform/stage.mjs'
import { LIMITS, normalizeStage, shellFrom, walkableIn } from '../runtime/shell.js'
import { panPose, plateSees, shotPose, solvePose, staysOnAnyPlate, staysOnPlate } from '../runtime/followCamera.js'
import { SHOT_DISTANCE } from '../runtime/story.js'

const beat = (id, objectName) => ({ id, objective: `查看${objectName}`, objectName, performed: true, gives: [], takes: [], action: 'a' })
const sceneIn = (stage, id = 's1') => {
  const scene = { id, title: '这里', stage, props: [], exit: {}, beats: [beat('b1', '长桌'), beat('b2', '木箱'), beat('b3', '高柜')] }
  return { ...scene, ...fallbackLayout(scene) }
}

const WIDTHS = [5, 7, 9, 12, 15, 18]
const DEPTHS = [4, 6, 8, 10, 12]
const everySize = WIDTHS.flatMap(width => DEPTHS.map(depth => ({ width, depth })))

test('with no description it is the room everything was tuned on, to the centimetre', () => {
  const shell = shellFrom()
  assert.deepEqual(shell.CAMERAS.a.position, [-1.5, 3.2, 7.5])
  assert.deepEqual(shell.CAMERAS.b.target, [4.5, 0.8, -1])
  assert.equal(shell.DOOR.x, -3)
  assert.equal(shell.WALL_HEIGHT, 5)
  assert.deepEqual(shell.room, { west: -5, east: 7, north: -4, south: 3.4, top: 5 })
  assert.deepEqual(shell.SHELLS.find(item => item.name === 'wall-north-right').size, [9.4, 5, 0.2])
})

test('whatever a description says, what gets built is within the limits', () => {
  const wild = normalizeStage({ kind: 'moon', exit: 'portal', width: 900, depth: -3, door_at: 7 })
  assert.deepEqual(wild, { kind: 'indoor', exit: 'door', width: LIMITS.width[1], depth: LIMITS.depth[0], doorAt: LIMITS.doorAt[1] })
  assert.equal(normalizeStage({ width: 'wide' }).width, 12)
  assert.equal(normalizeStage(null), null)
})

for (const stage of everySize) {
  const name = `${stage.width}×${stage.depth}`
  test(`${name}: the walls reach past the top of the picture, and the door is in the first camera's`, () => {
    const shell = shellFrom(stage)
    const { DOOR, CAMERAS, DOOR_ANCHOR } = shell
    assert.ok(plateSees(CAMERAS.a, [DOOR.x, DOOR.height, DOOR.z]) && plateSees(CAMERAS.a, [DOOR.x, 0, DOOR.z]), '门不在主机位画面里')
    const pose = shotPose(CAMERAS.a, DOOR_ANCHOR, SHOT_DISTANCE)
    assert.ok(staysOnPlate(pose, CAMERAS.a), '推门的镜头超出了画面')
    for (const camera of Object.values(CAMERAS)) {
      for (const sx of [-1, 0, 1]) assert.ok(staysOnPlate({ position: camera.position, target: camera.target, fov: 36 }, camera) || sx, '静止时看到了墙顶之外')
    }
  })

  test(`${name}: the player can be followed everywhere they can walk`, () => {
    const shell = shellFrom(stage)
    const { ROOM_WALK, CAMERAS, CAMERA_SWITCH } = shell
    for (let x = ROOM_WALK.minX; x <= ROOM_WALK.maxX; x += (ROOM_WALK.maxX - ROOM_WALK.minX) / 6) {
      for (let z = ROOM_WALK.minZ; z <= ROOM_WALK.maxZ; z += (ROOM_WALK.maxZ - ROOM_WALK.minZ) / 4) {
        const camera = x > CAMERA_SWITCH.toB ? CAMERAS.b : CAMERAS.a
        const pose = solvePose(camera, { x, z })
        assert.ok(staysOnAnyPlate(pose, Object.values(CAMERAS)), `在 ${x.toFixed(1)},${z.toFixed(1)} 画面跑出去了`)
      }
    }
  })

  test(`${name}: a plain set of three things can be walked and filmed`, () => {
    const scene = sceneIn({ ...stage, doorAt: 0.2 })
    const { ok, issues, data } = buildStage(scene)
    assert.ok(ok, JSON.stringify(issues.map(issue => issue.message)))
    assert.equal(data.story.beats.filter(entry => entry.clip).length, 4)
  })
}

test('a described stage is shot from a tripod: following turns and zooms, and never moves off the painted spot', () => {
  const { CAMERAS: { a }, ROOM_WALK } = shellFrom({ width: 14, depth: 9 })
  for (const player of [{ x: ROOM_WALK.minX + 1, z: ROOM_WALK.minZ + 1 }, { x: 0, z: 0 }, { x: ROOM_WALK.maxX - 1, z: ROOM_WALK.maxZ - 1 }]) {
    assert.deepEqual(solvePose(a, player).position, a.position)
    assert.deepEqual(shotPose(a, { ...player, yaw: 0 }, SHOT_DISTANCE).position, a.position)
  }
  const near = solvePose(a, { x: 0, z: 2 }).fov
  const far = shotPose(a, { x: 0, z: -3, yaw: 0 }, SHOT_DISTANCE).fov
  assert.ok(far < near, '站得越远，镜头推得越近')
  assert.ok(far >= 16)
})

test('looking around from a tripod turns the view and leaves the camera where it is', () => {
  const pose = { position: [0, 3, 8], target: [0, 1, 0], fov: 30 }
  const turned = panPose(pose, [0, 1, 0], 0.2, 0)
  assert.deepEqual(turned.position, pose.position)
  assert.ok(turned.target[0] > 0, '向右转，看向右边')
  assert.ok(panPose(pose, [0, 1, 0], 0, 0.1).target[1] < pose.target[1], '往下看，目标变低')
})

test('the room everything was tuned on keeps the camera it was made with', () => {
  assert.equal(shellFrom().CAMERAS.a.tripod, false)
})

test('the way out is always on the first camera\'s side of the line, in every size of space', () => {
  for (const { width, depth } of everySize) {
    for (const doorAt of LIMITS.doorAt) {
      const { DOOR_ANCHOR, ENDING_MARK, CAMERA_SWITCH, room } = shellFrom({ width, depth, doorAt, exit: 'opening' })
      assert.ok(DOOR_ANCHOR.x < CAMERA_SWITCH.toA, `${width}×${depth} 出口落在了机位交界上`)
      assert.ok(ENDING_MARK.x < CAMERA_SWITCH.toA)
      assert.ok(DOOR_ANCHOR.x - 0.6 >= room.west)
    }
  }
})

test('the door can be anywhere along the back, and the corridor and marks go with it', () => {
  for (const doorAt of [0.08, 0.3, 0.5]) {
    const shell = shellFrom({ width: 14, depth: 8, doorAt })
    assert.equal(shell.DOOR_ANCHOR.x, shell.DOOR.x)
    assert.ok(Math.abs(shell.ENDING_MARK.x - shell.DOOR.x) < 0.2)
    assert.ok(shell.SHELLS.find(item => item.name === 'corridor-west').center[0] < shell.DOOR.x)
    const walk = walkableIn(shell, [])
    assert.ok(walk(shell.DOOR.x, shell.room.north - 1, true), '门开了能走进通道')
    assert.equal(walk(shell.DOOR.x, shell.room.north - 1, false), false, '门没开走不进去')
    const { ok, issues } = buildStage(sceneIn({ width: 14, depth: 8, doorAt }))
    assert.ok(ok, JSON.stringify(issues.map(issue => issue.message)))
  }
})

test('a way out with nothing to open leaves the wall whole and ends the story at the wall', () => {
  const shell = shellFrom({ width: 12, depth: 8, exit: 'opening' })
  assert.deepEqual(shell.SHELLS.map(item => item.name), ['wall-west', 'wall-east', 'wall-north'])
  assert.equal(walkableIn(shell, [])(shell.DOOR.x, shell.room.north - 1, true), false, '后面没有路可走')
  assert.ok(shell.ENDING_MARK.z > shell.room.north, '结尾站在房间里')
  assert.ok(walkableIn(shell, [])(shell.ENDING_MARK.x, shell.ENDING_MARK.z, false))
})

test('a way out with nothing to open has no step and no shot of its own', () => {
  const { ok, issues, data } = buildStage(sceneIn({ width: 12, depth: 8, exit: 'opening', kind: 'outdoor' }))
  assert.ok(ok, JSON.stringify(issues.map(issue => issue.message)))
  assert.equal(data.story.beats.some(entry => entry.id === 'door'), false)
  assert.equal(data.stage.exit, 'opening')
})

test('what the first camera sees of the side walls depends on the room', () => {
  assert.deepEqual(wallsFirstCameraSees(shellFrom()).east, false)
  assert.equal(wallsFirstCameraSees(shellFrom({ width: 5, depth: 5 })).east, true)
})

test('saying the space should change moves everything into it, and the beats still work', () => {
  const scene = sceneIn({ width: 12, depth: 8 })
  const { stage, objects } = applyChanges(scene, [{ op: 'stage', width: 18, depth: 12, kind: 'outdoor', exit: 'opening' }])
  assert.deepEqual([stage.width, stage.depth, stage.kind, stage.exit], [18, 12, 'outdoor', 'opening'])
  const before = scene.objects.find(object => object.id === 'o1')
  const after = objects.find(object => object.id === 'o1')
  assert.notEqual(after.x, before.x)
  const { ok, issues } = buildStage({ ...scene, stage, objects })
  assert.ok(ok, JSON.stringify(issues.map(issue => issue.message)))
})

test('saying the way out should change renames it, and leaves it alone otherwise', () => {
  const scene = { ...sceneIn({ width: 12, depth: 8, exit: 'opening' }), exit: { name: '小路', beyond: '树林', prompt: '按 E' } }
  const changed = applyChanges(scene, [{ op: 'stage', exit: 'door', exit_name: '铁门', exit_objective: '推开铁门' }]).exit
  assert.deepEqual(changed, { name: '铁门', beyond: '树林', prompt: '按 E', objective: '推开铁门' })
  assert.equal(applyChanges(scene, [{ op: 'stage', width: 10 }]).exit.name, '小路')
  assert.equal(applyChanges(scene, [{ op: 'update', target: '长桌', look: '旧的' }]).exit.name, '小路')
})

test('only what was said about the space changes', () => {
  const scene = sceneIn({ width: 12, depth: 8, exit: 'opening', kind: 'outdoor' })
  const { stage } = applyChanges(scene, [{ op: 'stage', width: 10 }])
  assert.deepEqual([stage.width, stage.depth, stage.exit, stage.kind], [10, 8, 'opening', 'outdoor'])
})

test('a street is not told about skirting, and a door that is not there is not asked for', () => {
  const scene = sceneIn({ width: 16, depth: 10, kind: 'outdoor', exit: 'opening' })
  scene.exit = { name: '石拱门洞', beyond: '一条小巷' }
  const prompts = platePrompts({ style: '写实', cast: [] }, scene, buildStage(scene))
  assert.ok(!prompts.a_closed.includes('踢脚线'))
  assert.ok(!prompts.a_closed.includes('关闭'))
  assert.ok(prompts.a_closed.includes('石拱门洞'))
  assert.equal(prompts.a_open_raw, null)
  assert.ok(prompts.a_closed.includes('室外'))
  assert.ok(prompts.a_closed.includes('不是一件东西'), '标记不能被画成物体')
})

test('a way out with nothing to open costs no door pictures and no door shot', () => {
  const scene = sceneIn({ width: 16, depth: 10, kind: 'outdoor', exit: 'opening' })
  const film = { opening: { action: 'a' }, door: { action: '' }, ending: { action: 'c' } }
  const project = { story: '故事', style: '写实', cast: [{ id: 'c1', name: '人', costume: '衣', look: '脸', playable: true }], scenes: [{ ...scene, exit: { name: '小路', beyond: '树林' }, film }] }
  const nodes = buildGraph(project)
  const ids = nodes.map(node => node.id)
  assert.equal(ids.includes('scene:s1:a_open_raw'), false)
  assert.equal(ids.includes('scene:s1:clip:door'), false)
  assert.equal(ids.includes('scene:s1:corridor'), false)
  assert.equal(nodes.find(node => node.id === 'scene:s1:a_open').kind, 'copy')
  const known = new Set(ids)
  for (const node of nodes) for (const dep of node.deps ?? []) assert.ok(known.has(dep), `${node.id} 依赖不存在的 ${dep}`)
})

test('on a tripod each camera has one whole picture, and none of the stitching', () => {
  const scene = sceneIn({ width: 16, depth: 10, kind: 'outdoor', exit: 'opening' })
  const film = { opening: { action: 'a' }, door: { action: '' }, ending: { action: 'c' } }
  const nodes = buildGraph({ story: '故事', style: '写实', cast: [{ id: 'c1', name: '人', costume: '衣', look: '脸', playable: true }], scenes: [{ ...scene, exit: { name: '小路', beyond: '树林' }, film }] })
  const ids = nodes.map(node => node.id)
  for (const gone of ['a_empty', 'a_matte', 'guide_room', 'b_empty', 'guide_furniture', 'b_matte', 'report']) assert.equal(ids.includes(`scene:s1:${gone}`), false, gone)
  const second = nodes.find(node => node.id === 'scene:s1:b')
  assert.ok(second.params.prompt.includes('草稿'))
  assert.ok(second.params.prompt.includes('不得增加或复制'), '空白处不能多画东西')
  assert.equal(second.params.references.includes('scenes/s1/plate_a_closed.png'), false, '给成品当参考，模型就照抄它的构图')
  assert.ok(second.params.references.includes('scenes/s1/guide_b_draft.png'))
  assert.deepEqual(second.params.gate, { guide: 'scenes/s1/clay_b.png' })
  assert.ok(nodes.find(node => node.id === 'scene:s1:frames').deps.includes('scene:s1:a_open'))
  const known = new Set(ids)
  for (const node of nodes) for (const dep of node.deps ?? []) assert.ok(known.has(dep), `${node.id} 依赖不存在的 ${dep}`)
  assert.equal(nodes.filter(node => node.kind === 'image' && node.id.startsWith('scene:s1:') && !node.id.includes('prop_')).length, 2)
})

test('the first camera is only checked for an invented wall where it cannot see that wall', () => {
  const graphOf = stage => {
    const scene = sceneIn(stage)
    const film = { opening: { action: 'a' }, door: { action: 'b' }, ending: { action: 'c' } }
    return buildGraph({ story: '故事', style: '写实', cast: [{ id: 'c1', name: '人', costume: '衣', look: '脸', playable: true }], scenes: [{ ...scene, exit: { name: '门', beyond: '走廊' }, film }] })
  }
  assert.ok(graphOf(undefined).find(node => node.id === 'scene:s1:a_closed').params.gate.mask)
  assert.equal(graphOf({ width: 5, depth: 5 }).find(node => node.id === 'scene:s1:a_closed').params.gate.mask, undefined)
})

test('two plain rooms in one film do not stand things in the same places', () => {
  const place = id => sceneIn({ width: 12, depth: 8 }, id).objects.map(object => `${object.x},${object.z}`).join(' ')
  assert.notEqual(place('s1'), place('s2'))
})
