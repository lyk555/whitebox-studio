import assert from 'node:assert/strict'
import test from 'node:test'
import { createPlayer, stepToward } from '../runtime/controller.js'
import { cameraIsClear, shotPose, staysOnPlate } from '../runtime/followCamera.js'
import { BEATS, createStory, ITEMS, LAST_SHOT, SHOT_DISTANCE } from '../runtime/story.js'
import { CAMERA_SWITCH, CAMERAS, isWalkable } from '../runtime/world.js'

const beat = id => BEATS.find(candidate => candidate.id === id)
const at = id => [beat(id).target.x, beat(id).target.z]
const performed = BEATS.filter(candidate => candidate.clip)

test('the story can only happen in order', () => {
  const story = createStory()
  assert.deepEqual(story.nearby(...at('door')), { beat: beat('door'), ready: false })
  assert.deepEqual(story.nearby(...at('chest')), { beat: beat('chest'), ready: false })
  assert.equal(story.nearby(...at('note')).ready, true)
  assert.throws(() => story.complete('door'))
  for (const { id } of BEATS) {
    assert.equal(story.nearby(...at(id)).ready, true, id)
    story.complete(id)
  }
})

test('a finished beat is not offered again', () => {
  const story = createStory()
  story.complete('note')
  assert.equal(story.nearby(...at('note')), null)
})

test('nothing can be acted on from the middle of nowhere', () => {
  assert.equal(createStory().nearby(6.5, 2.5), null)
})

test('every beat that cannot happen yet says why', () => {
  for (const { id, tooEarly } of BEATS.slice(1)) assert.ok(tooEarly, id)
})

test('props change hands as the story goes', () => {
  const story = createStory()
  assert.deepEqual(story.items, [])
  assert.equal(story.propOnStage, true)
  story.complete('note')
  assert.deepEqual(story.items, ['note'])
  assert.equal(story.propOnStage, false)
  story.complete('shelf')
  assert.deepEqual(story.items, ['note', 'key'])
  story.complete('chest')
  assert.deepEqual(story.items, ['note', 'photo'], 'the key is used up on the chest')
  story.complete('door')
  assert.deepEqual(story.items, ['note', 'photo'])
})

test('every prop the story hands out has a name', () => {
  for (const { gives } of BEATS) if (gives) assert.ok(ITEMS[gives], gives)
})

for (const { clip, anchor, camera } of [...performed, LAST_SHOT]) {
  test(`${clip}: the close framing shows only what the plate saw, from somewhere the camera fits`, () => {
    const pose = shotPose(CAMERAS[camera], anchor, SHOT_DISTANCE)
    assert.ok(staysOnPlate(pose, CAMERAS[camera]), 'frame leaves the plate')
    assert.ok(cameraIsClear(pose.position), 'camera is inside the furniture')
  })
}

test('the close framing is really close: the character fills about half the frame', () => {
  const fov = shotPose(CAMERAS.a, BEATS[1].anchor, SHOT_DISTANCE).fov
  const share = 1.78 / (2 * SHOT_DISTANCE * Math.tan((fov * Math.PI) / 360))
  assert.ok(share > 0.5 && share < 0.7, `share ${share}`)
})

for (const { id, anchor, camera } of performed) {
  test(`${id}: the performance mark is somewhere the player can stand, on its camera's side of the room`, () => {
    assert.ok(isWalkable(anchor.x, anchor.z, false))
    if (camera === 'a') assert.ok(anchor.x < CAMERA_SWITCH.toA)
    else assert.ok(anchor.x > CAMERA_SWITCH.toB)
  })
}

// The mark is reached by walking straight at it, so furniture in the way could strand the player
// there, with the performance never starting.
for (const { id, anchor, target } of performed) {
  test(`${id}: the mark can be reached from everywhere the prompt shows`, () => {
    const STEP = 0.1
    for (let x = target.x - target.radius; x <= target.x + target.radius; x += STEP) {
      for (let z = target.z - target.radius; z <= target.z + target.radius; z += STEP) {
        if (Math.hypot(x - target.x, z - target.z) > target.radius || !isWalkable(x, z, false)) continue
        const player = createPlayer({ x, z, yaw: 0 })
        let arrived = false
        for (let i = 0; i < 600 && !arrived; i++) arrived = stepToward(player, anchor, 1 / 60, false)
        assert.ok(arrived, `stuck from ${x.toFixed(1)},${z.toFixed(1)} at ${player.x.toFixed(2)},${player.z.toFixed(2)}`)
      }
    }
  })
}
