import assert from 'node:assert/strict'
import test from 'node:test'
import { createStepCounter } from '../runtime/sound.js'

test('a footfall comes once per step, however the walking is divided up', () => {
  const steps = createStepCounter()
  let total = 0
  for (let i = 0; i < 300; i++) total += steps.advance(0.01, 0.6)
  assert.equal(total, 5)
})

test('one long stride can hold several footfalls, and the remainder carries over', () => {
  const steps = createStepCounter()
  assert.equal(steps.advance(1.3, 0.6), 2)
  assert.equal(steps.advance(0.5, 0.6), 1)
})

test('standing still makes no sound', () => {
  assert.equal(createStepCounter().advance(0, 0.6), 0)
})
