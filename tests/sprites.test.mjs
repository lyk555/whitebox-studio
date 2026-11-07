import assert from 'node:assert/strict'
import test from 'node:test'
import { cameraBasis, spriteDirection } from '../runtime/controller.js'
import { CAMERAS } from '../runtime/world.js'
import { buildSheet, findCycle, keyFrame, measure, poseSignature, scaleAboutFeet, sheetFromVideoFrames, shortestRepeat, steadyAnchors } from '../platform/sprites.mjs'

const SIZE = 128
const GREEN = [12, 240, 20] // Deliberately not the exact green that would have been asked for.

function paint(rectangles, width = SIZE, height = SIZE) {
  const frame = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < frame.length; i += 4) {
    frame[i] = GREEN[0]
    frame[i + 1] = GREEN[1]
    frame[i + 2] = GREEN[2]
    frame[i + 3] = 255
  }
  for (const { x, y, w, h, color = [40, 60, 80] } of rectangles) {
    for (let py = y; py < y + h; py++) {
      for (let px = x; px < x + w; px++) {
        const at = (py * width + px) * 4
        frame[at] = color[0]
        frame[at + 1] = color[1]
        frame[at + 2] = color[2]
      }
    }
  }
  return frame
}

// A body with one leg swinging on a known period, optionally drifting sideways in the frame.
function walker(index, period, drift = 0) {
  const offset = Math.round(drift * index)
  const leg = Math.round(12 * Math.sin((2 * Math.PI * index) / period))
  return paint([
    { x: 54 + offset, y: 20, w: 20, h: 60 },
    { x: 60 + leg + offset, y: 80, w: 8, h: 30 },
  ])
}

const keyed = keyFrame

test('keys out the screen, whatever green it turned out to be, and leaves the character solid', () => {
  const out = keyed(paint([{ x: 50, y: 50, w: 20, h: 20 }]))
  assert.equal(out[3], 0, 'screen is transparent')
  assert.equal(out[(60 * SIZE + 60) * 4 + 3], 255, 'character is solid')
})

test('a shadow cast on the screen goes with it, but a teal coat and black hair stay', () => {
  const out = keyed(paint([
    { x: 0, y: 0, w: 10, h: 10, color: [8, 80, 20] }, // Shadow on the screen.
    { x: 40, y: 40, w: 10, h: 10, color: [28, 62, 74] }, // Coat.
    { x: 60, y: 40, w: 10, h: 10, color: [10, 14, 10] }, // Hair.
  ]))
  assert.equal(out[(5 * SIZE + 5) * 4 + 3], 0)
  assert.equal(out[(45 * SIZE + 45) * 4 + 3], 255)
  assert.equal(out[(45 * SIZE + 65) * 4 + 3], 255)
})

test('a video whose backdrop is not a green screen is refused, not turned into a sheet', () => {
  const teal = paint([{ x: 0, y: 0, w: SIZE, h: SIZE, color: [60, 120, 115] }])
  assert.throws(() => sheetFromVideoFrames(Array.from({ length: 96 }, () => teal), SIZE, SIZE), /不是绿幕/)
})

test('removes green spill from what remains', () => {
  const out = keyFrame(paint([{ x: 50, y: 50, w: 20, h: 20, color: [90, 200, 80] }]))
  const at = (60 * SIZE + 60) * 4
  assert.equal(out[at + 1], 90)
})

test('ignores stray noise when measuring the character', () => {
  const frame = keyed(paint([{ x: 50, y: 40, w: 20, h: 50 }, { x: 2, y: 2, w: 1, h: 1, color: [255, 0, 0] }]))
  const box = measure(frame, SIZE, SIZE)
  assert.deepEqual([box.minX, box.maxX, box.minY, box.maxY], [50, 69, 40, 89])
})

test('says plainly when nothing was left after keying', () => {
  assert.throws(() => measure(keyed(paint([])), SIZE, SIZE), /没有抠出人物/)
})

test('finds the walk period, even when the character drifts across the frame', () => {
  for (const drift of [0, 0.15]) {
    const frames = Array.from({ length: 96 }, (_, index) => keyed(walker(index, 30, drift)))
    const cycle = findCycle(frames.map(frame => poseSignature(frame, SIZE, SIZE)))
    assert.equal(cycle.length, 30, `drift ${drift}`)
  }
})

// A dip at each given length, in a run of poor matches, as measured from real generated walks.
const dips = entries => {
  const scores = []
  for (let length = 10; length <= 60; length++) scores.push({ length, score: entries[length] ?? 0.1 })
  return scores
}

test('one repeat of the walk is chosen, even where two repeats match a little better', () => {
  assert.equal(shortestRepeat(dips({ 13: 0.0636, 25: 0.0221, 38: 0.0639, 51: 0.0143 })), 25)
})

test('a half-step that merely looks alike is not taken for a repeat', () => {
  assert.equal(shortestRepeat(dips({ 16: 0.0405, 32: 0.0142, 48: 0.0412 })), 32)
})

test('a walk that is simply slow keeps its one long repeat', () => {
  assert.equal(shortestRepeat(dips({ 50: 0.0281 })), 50)
})

test('pins every frame by its feet and centre so drift does not survive into the sheet', () => {
  const frames = [keyed(paint([{ x: 20, y: 10, w: 20, h: 60 }])), keyed(paint([{ x: 80, y: 40, w: 20, h: 60 }]))]
  const sheet = buildSheet(frames, SIZE, SIZE)
  const opaqueRow = cell => {
    for (let y = 0; y < sheet.cellHeight; y++) {
      if (sheet.pixels[(y * sheet.width + cell * sheet.cellWidth + sheet.cellWidth / 2) * 4 + 3] === 255) return y
    }
    return -1
  }
  assert.equal(opaqueRow(0), opaqueRow(1))
  assert.equal(sheet.standingHeight, 60)
})

test('a sheet holds the standing pose first, then exactly one cycle', () => {
  const raw = Array.from({ length: 96 }, (_, index) => walker(index, 24))
  const sheet = sheetFromVideoFrames(raw, SIZE, SIZE)
  assert.equal(sheet.cycleFrames, 24)
  assert.equal(sheet.frameCount, 25)
  assert.equal(sheet.columns, 8)
  assert.equal(sheet.rows, 4)
})

test('a foot lifting does not make the body hop', () => {
  // The body never moves, but the lowest point does, as it does when the weight changes feet.
  const frames = Array.from({ length: 24 }, (_, index) => keyed(paint([{ x: 54, y: 20, w: 20, h: 70 }, { x: 58, y: 90, w: 8, h: index % 2 ? 26 : 12 }])))
  const boxes = frames.map(frame => measure(frame, SIZE, SIZE))
  const heights = steadyAnchors(frames, boxes, SIZE, { start: 4, length: 12 }).map(({ y }) => y)
  // The lowest point jumps 14 pixels from frame to frame here. The anchor must not follow it.
  assert.ok(Math.max(...heights) - Math.min(...heights) <= 2, `the anchor moved: ${heights}`)
})

test('slow drift across the frame is still taken out', () => {
  const frames = Array.from({ length: 24 }, (_, index) => keyed(paint([{ x: 30 + index, y: 20, w: 20, h: 60 }])))
  const boxes = frames.map(frame => measure(frame, SIZE, SIZE))
  const anchors = steadyAnchors(frames, boxes, SIZE, { start: 4, length: 12 })
  anchors.forEach(({ x }, index) => assert.ok(Math.abs(x - (43.5 + index)) <= 1, `frame ${index} at ${x}`))
})

// The rows the character's head and feet reach in one cell of a sheet.
function reach(sheet, frame) {
  const left = (frame % sheet.columns) * sheet.cellWidth
  const top = Math.floor(frame / sheet.columns) * sheet.cellHeight
  let head = Infinity
  let feet = -1
  for (let y = 0; y < sheet.cellHeight; y++) {
    for (let x = 0; x < sheet.cellWidth; x++) {
      if (sheet.pixels[((top + y) * sheet.width + left + x) * 4 + 3] >= 128) {
        head = Math.min(head, y)
        feet = Math.max(feet, y)
      }
    }
  }
  return { head, feet }
}

test('the end of the loop meets its start, in a walk that rises unevenly and shrinks as it goes', () => {
  const PERIOD = 24
  const size = 256
  const raw = Array.from({ length: 96 }, (_, index) => {
    // A bob whose two steps differ, which is what pulls a fitted line off, plus real drift and shrink.
    const phase = (2 * Math.PI * index) / PERIOD
    const bob = Math.round(5 * Math.sin(2 * phase) + 3 * Math.sin(phase))
    const shrink = 1 - index * 0.0025
    const bodyHeight = Math.round(120 * shrink)
    const legHeight = Math.round(40 * shrink)
    const feet = Math.round(220 - index * 0.5 + bob)
    const leg = Math.round(14 * Math.sin(phase))
    return paint([
      { x: 108, y: feet - legHeight - bodyHeight, w: 40, h: bodyHeight },
      { x: 120 + leg, y: feet - legHeight, w: 12, h: legHeight },
      { x: 120 - leg, y: feet - legHeight, w: 12, h: legHeight },
    ], size, size)
  })
  const sheet = sheetFromVideoFrames(raw, size, size, { minLength: 20 })
  assert.equal(sheet.cycleFrames, PERIOD)
  const rows = Array.from({ length: PERIOD }, (_, index) => reach(sheet, index + 1))
  const heights = rows.map(({ head, feet }) => feet - head + 1)
  assert.ok(Math.max(...heights) - Math.min(...heights) <= 3, `the body changes size: ${heights}`)
  const steps = rows.map(({ head }, index) => Math.abs(head - rows[(index + 1) % PERIOD].head))
  // The steepest honest step of that bob is about 3.4 pixels, plus rounding. A line fitted through it
  // comes off by up to about 10 pixels over one repeat, and all of that would land on the seam.
  assert.ok(Math.max(...steps) <= 5, `the head jumps: ${steps}`)
})

test('a real standing picture is used for standing still, at the size of the walk', () => {
  const raw = Array.from({ length: 96 }, (_, index) => walker(index, 24))
  const standing = paint([{ x: 54, y: 65, w: 20, h: 45 }])
  const sheet = sheetFromVideoFrames(raw, SIZE, SIZE, { standing })
  assert.equal(sheet.frameCount, 25)
  assert.ok(Math.abs(sheet.standingHeight - sheet.bodyHeight) <= 2, `standing ${sheet.standingHeight}, walking ${sheet.bodyHeight}`)
})

test('scaling keeps the feet where they are', () => {
  const frame = keyed(paint([{ x: 54, y: 50, w: 20, h: 60 }]))
  const box = measure(frame, SIZE, SIZE)
  const scaled = measure(scaleAboutFeet(frame, SIZE, SIZE, box, 1.25), SIZE, SIZE)
  assert.ok(Math.abs(scaled.maxY - box.maxY) <= 1)
  assert.ok(Math.abs(scaled.maxY - scaled.minY + 1 - 75) <= 2)
})

test('standing still is the moment in the walk with the feet closest together', () => {
  // With no standing picture to use. Two legs swinging in opposite directions, together only at the
  // start of each half period.
  const raw = Array.from({ length: 96 }, (_, index) => {
    const leg = Math.round(12 * Math.sin((2 * Math.PI * index) / 24))
    return paint([{ x: 54, y: 20, w: 20, h: 60 }, { x: 60 + leg, y: 80, w: 8, h: 30 }, { x: 60 - leg, y: 80, w: 8, h: 30 }])
  })
  const sheet = sheetFromVideoFrames(raw, SIZE, SIZE, { minLength: 20 })
  let solid = 0
  const footRow = sheet.cellHeight - 8
  for (let x = 0; x < sheet.cellWidth; x++) if (sheet.pixels[(footRow * sheet.width + x) * 4 + 3] === 255) solid++
  assert.equal(solid, 8)
})

test('reads the step length from how far apart the feet get', () => {
  // Two legs swinging in opposite directions, level at index 0: 8px together, 32px at most.
  const raw = Array.from({ length: 96 }, (_, index) => {
    const leg = Math.round(12 * Math.sin((2 * Math.PI * index) / 24))
    return paint([{ x: 54, y: 20, w: 20, h: 60 }, { x: 60 + leg, y: 80, w: 8, h: 30 }, { x: 60 - leg, y: 80, w: 8, h: 30 }])
  })
  assert.equal(sheetFromVideoFrames(raw, SIZE, SIZE, { minLength: 20 }).stepPixels, 24)
})

test('walking along the line between two directions does not flicker between them', () => {
  const basis = cameraBasis(CAMERAS.a)
  const away = Math.atan2(basis.forwardX, basis.forwardZ)
  const justPast = Math.PI / 8 + 0.03 // Just past the middle of the way from "n" to "ne".
  const justShort = Math.PI / 8 - 0.03
  assert.equal(spriteDirection(away + justPast, basis).id, 'ne')
  assert.equal(spriteDirection(away + justShort, basis).id, 'n')
  assert.equal(spriteDirection(away + justShort, basis, { id: 'ne', mirror: false }).id, 'ne', 'stays while near the line')
  assert.equal(spriteDirection(away + 0.05, basis, { id: 'ne', mirror: false }).id, 'n', 'changes once clearly past it')
})

test('picks the sprite by where the character faces on screen, not in the room', () => {
  const a = cameraBasis(CAMERAS.a)
  const b = cameraBasis(CAMERAS.b)
  assert.deepEqual(spriteDirection(Math.PI, a), { id: 'n', mirror: false }) // Walking away from camera A.
  assert.deepEqual(spriteDirection(0, a), { id: 's', mirror: false })
  assert.deepEqual(spriteDirection(Math.PI / 2, a), { id: 'e', mirror: false })
  assert.deepEqual(spriteDirection(-Math.PI / 2, a), { id: 'e', mirror: true })
  assert.deepEqual(spriteDirection(Math.PI * 0.75, a), { id: 'ne', mirror: false })
  assert.deepEqual(spriteDirection(Math.PI * 0.25, a), { id: 'se', mirror: false })
  // Heading straight along camera B's own view is "away", though it is not north in the room.
  assert.equal(spriteDirection(Math.atan2(b.forwardX, b.forwardZ), b).id, 'n')
})
