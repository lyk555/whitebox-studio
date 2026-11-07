import assert from 'node:assert/strict'
import test from 'node:test'
import { cameraIsClear, createFollowCamera, orbitPose, plateSees, shotPose, solvePose, staysOnAnyPlate, staysOnPlate } from '../runtime/followCamera.js'
import { BLOCKS, CAMERAS, DOOR_ANCHOR, isWalkable, paintedBy } from '../runtime/world.js'

const DT = 1 / 60
const REACH = { a: { minX: -4.7, maxX: 1.6 }, b: { minX: 0.9, maxX: 6.7 } }

function eachStandingSpot(id, visit) {
  const { minX, maxX } = REACH[id]
  for (let z = -3.7; z <= 2.8; z += 0.25) {
    for (let x = minX; x <= maxX; x += 0.25) {
      if (isWalkable(x, z, false)) visit({ x, z })
    }
  }
}

for (const id of ['a', 'b']) {
  test(`camera ${id}: every frame stays on its plate and out of the furniture, wherever the player stands`, () => {
    eachStandingSpot(id, player => {
      const pose = solvePose(CAMERAS[id], player)
      assert.ok(staysOnPlate(pose, CAMERAS[id]), `off the plate at ${player.x},${player.z}`)
      assert.ok(cameraIsClear(pose.position), `in the furniture at ${player.x},${player.z}`)
    })
  })

  test(`camera ${id}: a small step never makes the view jump`, () => {
    const { minX, maxX } = REACH[id]
    for (let z = -3.7; z <= 2.8; z += 0.25) {
      let previous = null
      for (let x = minX; x <= maxX; x += 0.05) {
        if (!isWalkable(x, z, false)) {
          previous = null
          continue
        }
        const { position } = solvePose(CAMERAS[id], { x, z })
        if (previous) assert.ok(Math.hypot(...position.map((value, i) => value - previous[i])) < 0.35, `jump at ${x},${z}`)
        previous = position
      }
    }
  })
}

for (const block of BLOCKS) {
  test(`${block.name}: the one picture it is painted from sees all of it`, () => {
    const { center, size } = block
    for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) {
      const corner = [center[0] + x * size[0], Math.min(center[1] + y * size[1], 3), center[2] + z * size[2]]
      assert.ok(plateSees(CAMERAS[paintedBy(block)], corner), `corner ${corner} is out of frame`)
    }
  })
}

test('walking across the back of the room really moves the camera', () => {
  const left = solvePose(CAMERAS.a, { x: -3.5, z: -3 }).position
  const right = solvePose(CAMERAS.a, { x: -0.5, z: -3 }).position
  assert.ok(right[0] - left[0] > 0.5, `moved ${right[0] - left[0]} m`)
})

test('the view can settle on exactly the framing a performance starts from', () => {
  const follow = createFollowCamera()
  const player = { ...DOOR_ANCHOR }
  const framing = shotPose(CAMERAS.a, DOOR_ANCHOR, 4.6)
  for (let i = 0; i < 240; i++) follow.update(player, 'a', DT)
  assert.equal(follow.isAt(framing, 'a'), false)
  for (let i = 0; i < 180; i++) follow.update(player, 'a', DT, framing)
  assert.equal(follow.isAt(framing, 'a'), true)
})

test('a held framing also clears anything the mouse did', () => {
  const follow = createFollowCamera()
  const player = { x: -1.5, z: -2.5 }
  for (let i = 0; i < 120; i++) follow.update(player, 'a', DT)
  follow.turn(0.3, 0)
  follow.update(player, 'a', DT)
  assert.ok(follow.look.yaw > 0)
  follow.update(player, 'a', DT, shotPose(CAMERAS.a, player, 4.6))
  assert.equal(follow.look.yaw, 0)
})

test('moving between plates is gradual, not a cut', () => {
  const follow = createFollowCamera()
  const player = { x: 1.5, z: -2 }
  for (let i = 0; i < 120; i++) follow.update(player, 'a', DT)
  let previous = follow.pose.target
  for (let i = 0; i < 120; i++) {
    follow.update(player, 'b', DT)
    assert.ok(Math.hypot(...follow.pose.target.map((value, j) => value - previous[j])) < 0.2)
    previous = follow.pose.target
  }
  assert.equal(follow.plateMix, 1)
})

test('the mouse turns the view, and stops at what the plates saw instead of showing nothing', () => {
  const follow = createFollowCamera()
  const player = { x: -1.5, z: -2.5 }
  for (let i = 0; i < 240; i++) follow.update(player, 'a', DT)
  const before = [...follow.pose.position]
  for (let i = 0; i < 600; i++) {
    follow.turn(0.02, 0)
    follow.update(player, 'a', DT)
    assert.ok(staysOnAnyPlate(follow.pose, Object.values(CAMERAS)))
  }
  assert.ok(follow.look.yaw > 0.2, `turned ${follow.look.yaw}`)
  assert.ok(follow.look.yaw <= 0.6)
  assert.notDeepEqual(follow.pose.position, before)
  // Turning back answers at once: what the plates refused was not stored up.
  const atLimit = follow.look.yaw
  follow.turn(-0.1, 0)
  follow.update(player, 'a', DT)
  assert.ok(Math.abs(follow.look.yaw - (atLimit - 0.1)) < 1e-6)
})

test('mouse right turns the view right', () => {
  const pose = { position: [0, 3, 8], target: [0, 1, 0], fov: 36 }
  const turned = orbitPose(pose, [0, 1, 0], 0.3, 0)
  // Swinging around the player to look further right means the camera moves to the left of them.
  assert.ok(turned.position[0] < 0)
})
