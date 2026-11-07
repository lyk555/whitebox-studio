import assert from 'node:assert/strict'
import test from 'node:test'
import { ARCHETYPES, buildStage, placeObjects, SLOT_ORDER, slotPosition } from '../platform/stage.mjs'

const scene = (objects, beats = [], extra = {}) => ({ id: 's1', title: '测试', objects, beats, props: [], exit: {}, ...extra })
const standAlone = (archetype, slot, id = archetype) => {
  const { x, z } = slotPosition(slot, archetype)
  return { id, name: id, archetype, x, z }
}

test('a slot built from the tuned scene paints from the same camera that scene did', () => {
  const { blocks } = buildStage(scene([standAlone('table', 'center'), standAlone('shelf', 'back_center'), standAlone('chest', 'right'), standAlone('cabinet', 'right_wall'), standAlone('couch', 'front_right')]))
  const painted = Object.fromEntries(blocks.map(block => [block.name, block.paintedBy ?? 'a']))
  assert.deepEqual(painted, { table: 'a', shelf: 'a', chest: 'a', cabinet: 'b', couch: 'b' })
})

for (const slot of SLOT_ORDER) {
  test(`${slot}: an ordinary object standing here can be painted`, () => {
    const { issues } = buildStage(scene([standAlone('crate', slot)]))
    assert.deepEqual(issues, [])
  })
}

test('every performance slot leaves somewhere to stand for every full-size kind', () => {
  for (const slot of SLOT_ORDER.slice(0, 5)) {
    for (const [archetype, kind] of Object.entries(ARCHETYPES)) {
      if (kind.onTop || kind.size[1] > 3) continue
      const { issues } = buildStage(scene([standAlone(archetype, slot, 'thing')], [{ id: 'b1', objective: '查看', object: 'thing', performed: true }]))
      assert.deepEqual(issues.map(issue => issue.message), [], `${archetype} at ${slot}`)
    }
  }
})

test('a performance beat gets a mark with the performer\'s back to the camera', () => {
  const { data } = buildStage(scene([standAlone('shelf', 'back_center')], [{ id: 'b1', objective: '找', object: 'shelf', performed: true }]))
  const beat = data.story.beats[0]
  assert.equal(beat.clip, 'b1')
  assert.ok(Math.abs(Math.atan2(Math.sin(beat.anchor.yaw - Math.PI), Math.cos(beat.anchor.yaw - Math.PI))) < 1.3)
})

test('a door is always the last thing that happens', () => {
  const { data } = buildStage(scene([standAlone('table', 'center')]))
  assert.equal(data.story.beats.at(-1).id, 'door')
  assert.equal(data.story.lastShot.clip, 'ending')
})

test('furniture standing in front of the door is reported, not discovered later', () => {
  const blocked = { id: 'wall', name: '大柜', archetype: 'counter', x: -3, z: -3.2 }
  const { ok, issues } = buildStage(scene([blocked]))
  assert.equal(ok, false)
  assert.ok(issues.some(issue => issue.message.includes('出口')))
})

test('two objects on the same spot are reported', () => {
  const { issues } = buildStage(scene([standAlone('table', 'center', 'one'), standAlone('crate', 'center', 'two')]))
  assert.ok(issues.some(issue => issue.message.includes('叠在一起')))
})

test('a beat cannot use up a prop nobody has been given', () => {
  const { issues } = buildStage(scene([standAlone('table', 'center')], [{ id: 'b1', objective: '开', object: 'table', takes: 'key' }], { props: [{ id: 'key', name: '钥匙' }] }))
  assert.ok(issues.some(issue => issue.message.includes('还没拿到')))
})

test('placing objects moves whatever would collide, and keeps performed objects where they can be filmed', () => {
  const placed = placeObjects([
    { id: 'a', name: 'A', archetype: 'crate', slot: 'front_right' },
    { id: 'b', name: 'B', archetype: 'chest', slot: 'center' },
    { id: 'c', name: 'C', archetype: 'table', slot: 'center' },
    { id: 'lamp', name: '灯', archetype: 'lamp', on: 'c' },
  ], new Set(['a', 'b']))
  assert.equal(placed.length, 4)
  const { issues } = buildStage(scene(placed, [{ id: 'b1', objective: '查', object: 'a', performed: true }, { id: 'b2', objective: '查', object: 'b', performed: true }]))
  assert.deepEqual(issues.map(issue => issue.message), [])
})

test('whatever kind is asked for in whatever slot, what gets placed fits the room and leaves the door clear', () => {
  for (const slot of SLOT_ORDER) {
    for (const [archetype, kind] of Object.entries(ARCHETYPES)) {
      if (kind.onTop) continue
      const placed = placeObjects([{ id: 'thing', name: 'thing', archetype, slot }])
      assert.equal(placed.length, 1, `${archetype} at ${slot} was dropped`)
      assert.deepEqual(buildStage(scene(placed)).issues.map(issue => issue.message), [], `${archetype} at ${slot}`)
    }
  }
})

test('a full room still leaves every performed object somewhere it can be filmed', () => {
  const kinds = ['shelf', 'counter', 'table', 'chest', 'cabinet', 'couch', 'bed', 'statue']
  const objects = kinds.map((archetype, index) => ({ id: `o${index}`, name: archetype, archetype, slot: 'left' }))
  const placed = placeObjects(objects, new Set(['o0', 'o1', 'o2']))
  const beats = ['o0', 'o1', 'o2'].map((object, index) => ({ id: `b${index}`, objective: '查', object, performed: true }))
  assert.deepEqual(['o0', 'o1', 'o2'].filter(id => !placed.some(object => object.id === id)), [])
  assert.deepEqual(buildStage(scene(placed, beats)).issues.filter(issue => issue.beat).map(issue => issue.message), [])
})

test('the first beat that picks something up leaves it lying on its object until then', () => {
  const { data } = buildStage(scene([standAlone('table', 'center')], [{ id: 'b1', objective: '拿', object: 'table', gives: 'note' }], { props: [{ id: 'note', name: '便条' }] }))
  assert.equal(data.story.stageProp.item, 'note')
  assert.ok(Math.abs(data.story.stageProp.position[1] - 0.854) < 0.01)
})
