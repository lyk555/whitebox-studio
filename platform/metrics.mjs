// The checks that decide whether a picture is good enough to build on. They read files and need no browser.
import { OBJECT_COLOURS } from '../runtime/objectColours.js'
import { readRaw } from './ffmpeg.mjs'

function edgeMap(pixels, width, height) {
  const gray = new Float32Array(width * height)
  for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * pixels[i * 4] + 0.587 * pixels[i * 4 + 1] + 0.114 * pixels[i * 4 + 2]
  const magnitude = new Float32Array(width * height)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      magnitude[i] = Math.hypot(gray[i + 1] - gray[i - 1], gray[i + width] - gray[i - width])
    }
  }
  const sorted = Float32Array.from(magnitude).sort()
  const threshold = Math.max(4, sorted[Math.floor(sorted.length * 0.9)])
  return magnitude.map(value => value >= threshold ? 1 : 0)
}

// Share of the whitebox's outlines that have an outline in the plate within 3px of 320×180.
export async function outlineAgreement(clayPath, platePath) {
  const width = 320
  const height = 180
  const a = edgeMap(await readRaw(clayPath, width, height), width, height)
  const b = edgeMap(await readRaw(platePath, width, height), width, height)
  const R = 3
  let matched = 0
  let total = 0
  for (let y = R; y < height - R; y++) {
    for (let x = R; x < width - R; x++) {
      if (!a[y * width + x]) continue
      total++
      search: for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          if (b[(y + dy) * width + x + dx]) { matched++; break search }
        }
      }
    }
  }
  return total ? matched / total : 0
}

const chromaOf = (r, g, b) => {
  const sum = r + g + b + 1
  return [r / sum, g / sum]
}
const gapBetween = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
const MIN_MATERIAL_GAP = 0.02
const FLOOR_PATCH = 8 // Pixels of the 320 wide comparison.

// Outlines only say that what the whitebox has was drawn, not that nothing was added. A wall invented on
// the right of the picture stands on what the whitebox calls floor, so it shows as floor taking the wall's
// colour. Returns the share of the floor at the right of the picture that does, or 0 when the wall and floor
// are too alike in colour to tell.
export async function floorTakenByWall(maskPath, platePath) {
  const width = 320
  const height = 180
  const mask = await readRaw(maskPath, width, height)
  const plate = await readRaw(platePath, width, height)
  const floor = [0, 0, 0, 0]
  const wall = [0, 0, 0, 0]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      // The guide's own colours: floor is mid grey, walls are black.
      const isFloor = mask[i] > 90 && mask[i] < 190
      const sum = isFloor && x > width * 0.25 && x < width * 0.7 ? floor : mask[i] < 40 ? wall : null
      if (!sum) continue
      sum[0] += plate[i]
      sum[1] += plate[i + 1]
      sum[2] += plate[i + 2]
      sum[3]++
    }
  }
  if (!floor[3] || !wall[3]) return 0
  const floorColour = chromaOf(floor[0] / floor[3], floor[1] / floor[3], floor[2] / floor[3])
  const wallColour = chromaOf(wall[0] / wall[3], wall[1] / wall[3], wall[2] / wall[3])
  if (gapBetween(floorColour, wallColour) < MIN_MATERIAL_GAP) return 0
  // A patch at a time: a single dark pixel of mortar says nothing, and a wall is a whole area.
  let seen = 0
  let taken = 0
  for (let top = 0; top + FLOOR_PATCH <= height; top += FLOOR_PATCH) {
    for (let left = Math.floor(width * 0.8); left + FLOOR_PATCH <= width; left += FLOOR_PATCH) {
      const sum = [0, 0, 0, 0]
      for (let y = top; y < top + FLOOR_PATCH; y++) {
        for (let x = left; x < left + FLOOR_PATCH; x++) {
          const i = (y * width + x) * 4
          if (mask[i] <= 90 || mask[i] >= 190) continue
          sum[0] += plate[i]
          sum[1] += plate[i + 1]
          sum[2] += plate[i + 2]
          sum[3]++
        }
      }
      if (sum[3] < FLOOR_PATCH * FLOOR_PATCH) continue
      const colour = chromaOf(sum[0] / sum[3], sum[1] / sum[3], sum[2] / sum[3])
      seen++
      if (gapBetween(colour, wallColour) < gapBetween(colour, floorColour)) taken++
    }
  }
  return seen ? taken / seen : 0
}

const FULL_WIDTH = 2560
const LEAST_PATCH = 20 // Pixels of the 320 wide comparison.

// What a thing painted too big costs is floor: wider than its block, or its foot nearer the camera. Taller costs nothing,
// and a thin thing is many times its block by a handful of pixels, so it has to be a lot of picture as well.
const MOST_OVERSIZED = 1.7
const LEAST_OVERRUN = 200 // Pixels of a full picture.

// Things painted where another thing belongs: a model can swap two things that overlap in the picture, and everything
// downstream would then be built on the wrong room. The biggest patch of each thing's colour should have its middle
// nearer that thing's place than any other's, and be about the size of its block. Says nothing about a thing it cannot
// find. bounds, by thing, is how many pixels of a full picture its block takes up.
export function misplacedThings(pixels, width, height, things, bounds = {}) {
  const scale = FULL_WIDTH / width
  const wrong = []
  for (const thing of things) {
    const colour = OBJECT_COLOURS[thing.index]?.rgb
    if (!colour) continue
    const isIt = at => {
      const away = rgb => Math.abs(pixels[at * 4] - rgb[0]) + Math.abs(pixels[at * 4 + 1] - rgb[1]) + Math.abs(pixels[at * 4 + 2] - rgb[2])
      return away(colour) < 120 && OBJECT_COLOURS.every(({ rgb }) => away(rgb) >= away(colour))
    }
    const seen = new Uint8Array(width * height)
    let best = null
    for (let start = 0; start < seen.length; start++) {
      if (seen[start] || !isIt(start)) continue
      const stack = [start]
      seen[start] = 1
      let count = 0
      let sumX = 0
      let sumY = 0
      let [left, right, top, bottom] = [width, 0, height, 0]
      while (stack.length) {
        const at = stack.pop()
        const x = at % width
        const y = (at - x) / width
        count++
        sumX += x
        sumY += y
        left = Math.min(left, x)
        right = Math.max(right, x)
        top = Math.min(top, y)
        bottom = Math.max(bottom, y)
        for (const next of [x > 0 ? at - 1 : -1, x < width - 1 ? at + 1 : -1, at >= width ? at - width : -1, at + width < seen.length ? at + width : -1]) {
          if (next >= 0 && !seen[next] && isIt(next)) {
            seen[next] = 1
            stack.push(next)
          }
        }
      }
      if (count >= LEAST_PATCH && count > (best?.count ?? 0)) best = { count, x: (sumX / count) * scale, y: (sumY / count) * scale, wide: (right - left + 1) * scale, bottom: (bottom + 1) * scale }
    }
    if (!best) continue
    const distanceTo = other => Math.hypot(best.x - other.x, best.y - other.y)
    const nearest = things.reduce((a, b) => (distanceTo(b) < distanceTo(a) ? b : a))
    if (nearest !== thing) wrong.push({ label: thing.label, standsAt: nearest.label })
    const size = bounds[thing.index]
    if (!size) continue
    const tooWide = best.wide > size.wide * MOST_OVERSIZED && best.wide - size.wide > LEAST_OVERRUN
    const tooNear = best.bottom - size.bottom > LEAST_OVERRUN
    if (tooWide || tooNear) wrong.push({ label: thing.label, oversized: Number((best.wide / size.wide).toFixed(1)) })
  }
  return wrong
}

export async function misplacedInPicture(mattePath, things, bounds) {
  const width = 320
  const height = 180
  return misplacedThings(await readRaw(mattePath, width, height), width, height, things, bounds)
}

// A picture painted loosely has outlines everywhere, so outlines cannot say whether its room is in the right place.
// This asks whether the whitebox's floor and walls still fall on the picture's floor and walls: each patch, away
// from the things in the room, should look more like the rest of its own side than the other. Measured on finished
// plates: right room 0.82 to 0.95, usually 0.64 to 0.79 for another room's picture. A rough check: it stops a room
// that has moved, and says nothing about whether the picture is any good.
export function roomSplitScore(mask, plate, width, height, patch = FLOOR_PATCH) {
  const cells = []
  for (let top = 0; top + patch <= height; top += patch) {
    for (let left = 0; left + patch <= width; left += patch) {
      let floor = 0
      let wall = 0
      const colour = [0, 0, 0]
      for (let y = top; y < top + patch; y++) {
        for (let x = left; x < left + patch; x++) {
          const i = (y * width + x) * 4
          if (mask[i] > 90 && mask[i] < 190) floor++
          else if (mask[i] < 40) wall++
          for (let channel = 0; channel < 3; channel++) colour[channel] += plate[i + channel]
        }
      }
      const whole = patch * patch
      if (floor === whole || wall === whole) cells.push({ isFloor: floor === whole, colour: colour.map(value => value / whole) })
    }
  }
  const floors = cells.filter(cell => cell.isFloor)
  const walls = cells.filter(cell => !cell.isFloor)
  if (!floors.length || !walls.length) return 1
  const meanOf = list => [0, 1, 2].map(channel => list.reduce((sum, cell) => sum + cell.colour[channel], 0) / list.length)
  const floorMean = meanOf(floors)
  const wallMean = meanOf(walls)
  const gap = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  const nearerOwn = (list, own, other) => list.filter(cell => gap(cell.colour, own) < gap(cell.colour, other)).length / list.length
  return (nearerOwn(floors, floorMean, wallMean) + nearerOwn(walls, wallMean, floorMean)) / 2
}

export async function roomAgreement(maskPath, platePath) {
  const width = 320
  const height = 180
  return roomSplitScore(await readRaw(maskPath, width, height), await readRaw(platePath, width, height), width, height)
}

// Mean absolute difference per channel on a 0–255 scale. Below about 8 is hard to see in a crossfade.
export async function meanDifference(pathA, pathB) {
  const width = 640
  const height = 360
  const a = await readRaw(pathA, width, height)
  const b = await readRaw(pathB, width, height)
  let total = 0
  for (let i = 0; i < a.length; i += 4) total += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
  return total / ((a.length / 4) * 3)
}
