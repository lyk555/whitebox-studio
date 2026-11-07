import assert from 'node:assert/strict'
import test from 'node:test'
import { fitToWhitebox, silhouetteOverlap } from '../runtime/plateFit.js'

const WIDTH = 200
const HEIGHT = 100
const rects = (...list) => (x, y) => list.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1)
const uv = (x, y) => [x / WIDTH, 1 - y / HEIGHT]
const sampled = (fit, [u, v]) => [u * fit.uScale + fit.uOffset, v * fit.vScale + fit.vOffset]

function assertLandsOn(fit, from, to) {
  const [u, v] = sampled(fit, uv(...from))
  const [eu, ev] = uv(...to)
  assert.ok(Math.abs(u - eu) < 1e-9 && Math.abs(v - ev) < 1e-9, `${from} landed on ${u},${v}, wanted ${eu},${ev}`)
}

const fit = (whitebox, painted, isOther) => fitToWhitebox({ width: WIDTH, height: HEIGHT, inWhitebox: whitebox, isPainted: painted, isOther })

test('a corner of the whitebox samples the same corner of the painted object', () => {
  const result = fit(rects([40, 30, 80, 80]), rects([30, 20, 90, 70]))
  assertLandsOn(result, [40, 30], [30, 20])
  assertLandsOn(result, [80, 80], [90, 70])
})

test('an object painted exactly on its whitebox is left alone', () => {
  const box = rects([40, 30, 80, 80])
  const result = fit(box, box)
  assert.ok(Math.abs(result.uScale - 1) < 1e-9 && Math.abs(result.vScale - 1) < 1e-9)
  assert.ok(Math.abs(result.uOffset) < 1e-9 && Math.abs(result.vOffset) < 1e-9)
})

test('another object nearby does not count toward the outline', () => {
  const result = fit(rects([40, 30, 100, 80]), rects([40, 30, 80, 80], [120, 10, 180, 90]))
  assertLandsOn(result, [40, 30], [40, 30])
  assertLandsOn(result, [100, 80], [80, 80])
})

test("paint on another object's whitebox is that object's", () => {
  const lamp = rects([50, 5, 70, 29])
  const result = fit(rects([40, 30, 80, 80]), rects([40, 30, 80, 80], [50, 5, 70, 29]), lamp)
  assertLandsOn(result, [40, 30], [40, 30])
  assertLandsOn(result, [80, 80], [80, 80])
})

test('a skirting board running away from a column does not stretch it', () => {
  // A narrow column on a wider base. The skirting board meets the column up high and then runs off
  // down and to the left, past the bottom of the base, which is well inside the object's bounding box.
  const column = rects([80, 0, 100, 60], [70, 60, 110, 80])
  const skirting = [[60, 40, 80, 46], [40, 46, 60, 52], [20, 52, 40, 99]]
  const result = fit(column, rects([80, 0, 100, 60], [70, 60, 110, 80], ...skirting))
  assertLandsOn(result, [70, 0], [70, 0])
  assertLandsOn(result, [110, 80], [110, 80])
})

test("a table's thin legs still count toward its outline", () => {
  const table = rects([40, 20, 100, 40], [40, 40, 48, 80], [92, 40, 100, 80])
  const result = fit(table, table)
  assertLandsOn(result, [40, 20], [40, 20])
  assertLandsOn(result, [100, 80], [100, 80])
})

test('an object running off the frame is measured only where it is in the frame', () => {
  const result = fit(rects([0, 20, 50, 70]), rects([0, 20, 60, 70]))
  assertLandsOn(result, [0, 20], [0, 20])
  assertLandsOn(result, [50, 70], [60, 70])
})

test('nothing painted there leaves the plate as it is', () => {
  assert.deepEqual(fit(rects([40, 30, 80, 80]), () => false), { uScale: 1, vScale: 1, uOffset: 0, vOffset: 0 })
})

test('overlap reads 1 for a perfect match and falls as the paint drifts off', () => {
  const size = { width: WIDTH, height: HEIGHT, isOther: () => false }
  const whitebox = rects([40, 30, 80, 80])
  assert.equal(silhouetteOverlap({ ...size, inWhitebox: whitebox, isPainted: whitebox }), 1)
  const drifted = silhouetteOverlap({ ...size, inWhitebox: whitebox, isPainted: rects([50, 30, 90, 80]) })
  assert.ok(drifted > 0.5 && drifted < 0.8, `drifted ${drifted}`)
})

test("paint on another object's whitebox does not count against this one", () => {
  const overlap = silhouetteOverlap({
    width: WIDTH,
    height: HEIGHT,
    inWhitebox: rects([40, 30, 80, 80]),
    isPainted: rects([40, 10, 80, 80]),
    isOther: rects([40, 10, 80, 29]),
  })
  assert.equal(overlap, 1)
})
