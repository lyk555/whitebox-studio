import assert from 'node:assert/strict'
import test from 'node:test'
import { findRoute } from '../runtime/controller.js'

test('a route goes round what is in the way, and straight when nothing is', () => {
  const inside = (x, z) => Math.abs(x) <= 5 && Math.abs(z) <= 5
  const wall = (x, z) => inside(x, z) && !(Math.abs(x) < 1 && z > -3)
  assert.deepEqual(findRoute({ x: -4, z: 0 }, { x: 4, z: 1 }, inside), [{ x: 4, z: 1 }])
  const legs = findRoute({ x: -4, z: 0 }, { x: 4, z: 1 }, wall)
  assert.ok(legs.length >= 2 && legs.length < 6, `${legs.length} legs`)
  assert.deepEqual(legs.at(-1), { x: 4, z: 1 })
  assert.ok(legs.some(leg => leg.z <= -3), 'it goes round the end of the wall')
  let from = { x: -4, z: 0 }
  for (const leg of legs) {
    for (let t = 0; t <= 1; t += 0.01) assert.ok(wall(from.x + (leg.x - from.x) * t, from.z + (leg.z - from.z) * t))
    from = leg
  }
  assert.equal(findRoute({ x: -4, z: 0 }, { x: 4, z: 1 }, (x, z) => inside(x, z) && Math.abs(x) >= 1), null, 'no way through')
})
import { cameraBasis, createDirectionHold, createPlayer, MAX_SPEED, stepLength, stepPlayer } from '../runtime/controller.js'
import { CAMERAS, DOOR_ANCHOR, EXIT_Z, isWalkable } from '../runtime/world.js'

const DT = 1 / 60
const run = (player, direction, seconds, doorOpen = false) => {
  for (let i = 0; i < Math.round(seconds / DT); i++) stepPlayer(player, direction, DT, doorOpen)
}

test('reaches full speed within a quarter second and stops as quickly', () => {
  const player = createPlayer({ x: 0.6, z: 1.9, yaw: 0 })
  run(player, { x: 1, z: 0 }, 0.25)
  assert.ok(Math.abs(player.vx - MAX_SPEED) < 1e-6)
  run(player, { x: 0, z: 0 }, 0.2)
  assert.equal(player.vx, 0)
})

test('diagonal input is not faster than straight input', () => {
  const player = createPlayer({ x: 0.6, z: 1.9, yaw: 0 })
  run(player, { x: 1, z: 1 }, 0.2)
  assert.ok(Math.hypot(player.vx, player.vz) <= MAX_SPEED + 1e-6)
})

test('slides along an obstacle instead of sticking to it', () => {
  // Walking north-east into the south face of the table: north is blocked, east still moves.
  const player = createPlayer({ x: -1.5, z: 1.5, yaw: 0 })
  const before = player.x
  run(player, { x: 1, z: -1 }, 0.8)
  assert.ok(isWalkable(player.x, player.z, false))
  assert.ok(player.z > 0.5 + 0.5, 'stayed south of the table')
  assert.ok(player.x > before + 0.7, `slid east, x=${player.x}`)
})

test('the closed door blocks the way and the open door lets the player leave', () => {
  const blocked = createPlayer(DOOR_ANCHOR)
  run(blocked, { x: 0, z: -1 }, 2, false)
  assert.ok(blocked.z >= -3.7 - 1e-9)
  const free = createPlayer(DOOR_ANCHOR)
  run(free, { x: 0, z: -1 }, 2, true)
  assert.ok(free.z < EXIT_Z, `z=${free.z}`)
})

test('the walk cycle advances one step per step length, so the planted foot does not slide', () => {
  const player = createPlayer({ x: -4, z: 2.5, yaw: 0 })
  run(player, { x: 1, z: 0 }, 0.3)
  const startX = player.x
  const startPhase = player.phase
  run(player, { x: 1, z: 0 }, 1)
  const expected = (Math.PI * (player.x - startX)) / stepLength(1)
  assert.ok(Math.abs(player.phase - startPhase - expected) < 1e-6)
})

test('a held key keeps its world direction across a camera cut; a new key uses the new camera', () => {
  const a = cameraBasis(CAMERAS.a)
  const b = cameraBasis(CAMERAS.b)
  const hold = createDirectionHold()
  const held = new Set(['ArrowRight'])
  const before = hold.resolve(held, a)
  assert.deepEqual(hold.resolve(held, b), before)
  held.delete('ArrowRight')
  held.add('ArrowUp')
  const after = hold.resolve(held, b)
  assert.ok(Math.abs(after.x - b.forwardX) < 1e-9 && Math.abs(after.z - b.forwardZ) < 1e-9)
})
