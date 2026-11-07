import assert from 'node:assert/strict'
import test from 'node:test'
import { facingOf, headingOf, pitchOf, pressedDirections } from '../runtime/hud.js'

const pose = (position, target) => ({ position, target })
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`)

test('heading reads clockwise from north', () => {
  near(headingOf(pose([0, 2, 0], [0, 1, -5])), 0)
  near(headingOf(pose([0, 2, 0], [5, 1, 0])), 90)
  near(headingOf(pose([0, 2, 0], [0, 1, 5])), 180)
  near(headingOf(pose([0, 2, 0], [-5, 1, 0])), 270)
})

test('pitch is how far below level the view looks', () => {
  near(pitchOf(pose([0, 2, 0], [0, 1, -1])), 45)
  near(pitchOf(pose([0, 1, 0], [0, 1, -3])), 0)
  assert.ok(pitchOf(pose([0, 1, 0], [0, 2, -1])) < 0)
})

test('the character facing north reads the same as a view looking north', () => {
  // A yaw of π is what the game uses for walking north, away from the camera.
  near(facingOf(Math.PI), 0)
  near(facingOf(Math.PI / 2), 90)
  near(facingOf(0), 180)
})

test('arrow keys and WASD light the same directions', () => {
  assert.deepEqual(pressedDirections(new Set(['KeyW', 'ArrowRight'])), { up: true, down: false, left: false, right: true })
  assert.deepEqual(pressedDirections(new Set(['ArrowDown', 'KeyA'])), { up: false, down: true, left: true, right: false })
  assert.deepEqual(pressedDirections(new Set()), { up: false, down: false, left: false, right: false })
})
