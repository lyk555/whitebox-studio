// Seats a painted fill into the picture it fills. A model asked to continue a surface still picks its own
// brightness and colour, and repaints what it was told to keep. Both are settled here, by numbers: what was
// already there stays exactly as it was, and each surface of the fill takes the colour of what it joins.
import { readRaw, writePng } from './ffmpeg.mjs'

const WORK_WIDTH = 640
const WORK_HEIGHT = 360
const BAND = 16 // Working pixels each side of the join that decide its colour.
const FRINGE = 2 // Working pixels at the edge of the hole where its colour is mixed into the picture.
const FEATHER = 10 // Working pixels over which the fill fades out into what was kept.
const MIN_BAND_PIXELS = 150
const GAIN_RANGE = [0.35, 2.5]
const FLOOR_LEVEL = 205 // In the whitebox, the floor is the only surface this bright.

const isHole = (pixels, i) => pixels[i] > 180 && pixels[i + 1] < 90 && pixels[i + 2] > 180
const holeTinted = (pixels, i) => pixels[i] > 110 && pixels[i + 2] > 110 && pixels[i + 1] < 0.55 * Math.min(pixels[i], pixels[i + 2])

// How many pixels each pixel is from the nearest one failing the test, up to limit.
function distanceFrom(inside, width, height, limit) {
  const distance = new Uint16Array(width * height).fill(limit)
  let frontier = []
  for (let i = 0; i < inside.length; i++) if (!inside[i]) { distance[i] = 0; frontier.push(i) }
  for (let step = 1; step < limit && frontier.length; step++) {
    const next = []
    for (const i of frontier) {
      const x = i % width
      for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width]) {
        if (j >= 0 && j < distance.length && distance[j] > step) { distance[j] = step; next.push(j) }
      }
    }
    frontier = next
  }
  return distance
}

const clampGain = value => Math.min(GAIN_RANGE[1], Math.max(GAIN_RANGE[0], value))

// Pure, so it can be checked without any pictures. All three are RGBA at width × height.
export function seatFill({ painted, guide, clay, width, height, holes = null }) {
  const count = width * height
  const hole = holes ?? new Uint8Array(count)
  const floor = new Uint8Array(count)
  for (let n = 0; n < count; n++) {
    if (!holes) hole[n] = isHole(guide, n * 4) ? 1 : 0
    floor[n] = clay[n * 4] >= FLOOR_LEVEL ? 1 : 0
  }
  const reach = Math.max(BAND, FEATHER + FRINGE) + 1
  const intoHole = distanceFrom(hole, width, height, reach)
  const intoKept = distanceFrom(hole.map(value => 1 - value), width, height, reach)

  // Measured right at the join, on each side of it: this is the step the eye would see.
  const gains = [floor, floor.map(value => 1 - value)].map(surface => {
    const kept = [0, 0, 0, 0]
    const fill = [0, 0, 0, 0]
    for (let n = 0; n < count; n++) {
      if (!surface[n]) continue
      const depth = hole[n] ? intoHole[n] : intoKept[n]
      if (depth <= FRINGE || depth > BAND) continue
      const sum = hole[n] ? fill : kept
      const source = hole[n] ? painted : guide
      sum[0] += source[n * 4]
      sum[1] += source[n * 4 + 1]
      sum[2] += source[n * 4 + 2]
      sum[3]++
    }
    if (kept[3] < MIN_BAND_PIXELS || fill[3] < MIN_BAND_PIXELS) return null
    return [0, 1, 2].map(c => clampGain((kept[c] / kept[3] + 1) / (fill[c] / fill[3] + 1)))
  })
  // A surface that never meets the kept part borrows the other's correction.
  const gainFor = [gains[0] ?? gains[1] ?? [1, 1, 1], gains[1] ?? gains[0] ?? [1, 1, 1]]

  const weight = new Float32Array(count)
  const gainField = new Float32Array(count * 3)
  for (let n = 0; n < count; n++) {
    // The fill comes over the edge a little, far enough to cover what scaling smeared, then fades out.
    weight[n] = hole[n] ? 1 : Math.max(0, Math.min(1, 1 - (intoKept[n] - FRINGE) / FEATHER))
    gainField.set(gainFor[floor[n] ? 0 : 1], n * 3)
  }
  return { weight, gainField, gains: gainFor, width, height }
}

const smooth = (at, x, y, width, height) => {
  const left = Math.floor(x)
  const top = Math.floor(y)
  const right = Math.min(width - 1, left + 1)
  const bottom = Math.min(height - 1, top + 1)
  const fx = x - left
  const fy = y - top
  return (at(left, top) * (1 - fx) + at(right, top) * fx) * (1 - fy) + (at(left, bottom) * (1 - fx) + at(right, bottom) * fx) * fy
}

// Blurs across the line between two surfaces, which is hidden under the skirting anyway.
function softened(field, width, height, channels, radius) {
  const out = new Float32Array(field.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) {
        let sum = 0
        let n = 0
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const px = x + dx
            const py = y + dy
            if (px < 0 || py < 0 || px >= width || py >= height) continue
            sum += field[(py * width + px) * channels + c]
            n++
          }
        }
        out[(y * width + x) * channels + c] = sum / n
      }
    }
  }
  return out
}

export async function seatFillFile({ paintedPath, guidePath, clayPath, width, height }) {
  const seat = seatFill({
    painted: await readRaw(paintedPath, WORK_WIDTH, WORK_HEIGHT),
    guide: await readRaw(guidePath, WORK_WIDTH, WORK_HEIGHT),
    clay: await readRaw(clayPath, WORK_WIDTH, WORK_HEIGHT),
    width: WORK_WIDTH,
    height: WORK_HEIGHT,
  })
  return compose(seat, { paintedPath, guidePath, width, height, holeInGuide: true })
}

const OUTLINE_MARGIN = 4 // Working pixels. Always taken, since edges are never exact.
const OVERSHOOT_MARGIN = 14 // How far past the outline something the model really did paint as furniture is still taken.
const LOCAL_REACHES = [10, 20, 40, 80, 160, 320]
const LOCAL_ENOUGH = 40 // Kept pixels a colour match needs before it can be trusted.

// How the fill has to change to match what surrounds it, worked out separately for each place. The model
// repaints the kept part too, so comparing its version with the original there says exactly how it has drifted
// nearby: sky one way, stone another. That makes the join seamless wherever it runs.
function localGains({ painted, guide, holes, weight, width, height }) {
  const stride = width + 1
  const integral = () => new Float64Array(stride * (height + 1))
  const count = integral()
  const fromGuide = [integral(), integral(), integral()]
  const fromPainted = [integral(), integral(), integral()]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const n = y * width + x
      const at = (y + 1) * stride + x + 1
      const grow = (table, value) => { table[at] = value + table[at - 1] + table[at - stride] - table[at - stride - 1] }
      const kept = holes[n] ? 0 : 1
      grow(count, kept)
      for (let c = 0; c < 3; c++) {
        grow(fromGuide[c], kept * guide[n * 4 + c])
        grow(fromPainted[c], kept * painted[n * 4 + c])
      }
    }
  }
  const field = new Float32Array(width * height * 3).fill(1)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const n = y * width + x
      if (weight[n] <= 0) continue
      for (const reach of LOCAL_REACHES) {
        const left = Math.max(0, x - reach)
        const right = Math.min(width, x + reach + 1)
        const top = Math.max(0, y - reach)
        const bottom = Math.min(height, y + reach + 1)
        const sum = table => table[bottom * stride + right] - table[top * stride + right] - table[bottom * stride + left] + table[top * stride + left]
        if (sum(count) < LOCAL_ENOUGH) continue
        for (let c = 0; c < 3; c++) field[n * 3 + c] = clampGain((sum(fromGuide[c]) + 1) / (sum(fromPainted[c]) + 1))
        break
      }
    }
  }
  return field
}

// The emptied room is only ever needed where the furniture hid it. A model asked to take things away repaints the
// whole picture, and it comes back greyer and softer with a different view behind, so everything the finished
// picture can show is taken from the finished picture, shadows included, since the things casting them stay put.
export async function keepFinishedFile({ paintedPath, finishedPath, maskPath, mattePath, clayPath, width, height }) {
  const mask = await readRaw(maskPath, WORK_WIDTH, WORK_HEIGHT)
  const matte = mattePath ? await readRaw(mattePath, WORK_WIDTH, WORK_HEIGHT) : null
  const open = new Uint8Array(WORK_WIDTH * WORK_HEIGHT)
  for (let n = 0; n < open.length; n++) open[n] = mask[n * 4] > 200 ? 0 : 1
  const fromFurniture = distanceFrom(open, WORK_WIDTH, WORK_HEIGHT, OVERSHOOT_MARGIN + 1)
  const paintedAsFurniture = n => Boolean(matte) && matte[n * 4 + 1] - Math.max(matte[n * 4], matte[n * 4 + 2]) < 40
  const holes = Uint8Array.from(fromFurniture, (distance, n) => (distance <= OUTLINE_MARGIN || (distance <= OVERSHOOT_MARGIN && paintedAsFurniture(n)) ? 1 : 0))
  const painted = await readRaw(paintedPath, WORK_WIDTH, WORK_HEIGHT)
  const guide = await readRaw(finishedPath, WORK_WIDTH, WORK_HEIGHT)
  const seat = seatFill({
    painted,
    guide,
    clay: await readRaw(clayPath, WORK_WIDTH, WORK_HEIGHT),
    width: WORK_WIDTH,
    height: WORK_HEIGHT,
    holes,
  })
  seat.gainField = localGains({ painted, guide, holes, weight: seat.weight, width: WORK_WIDTH, height: WORK_HEIGHT })
  return compose(seat, { paintedPath, guidePath: finishedPath, width, height, holeInGuide: false })
}

async function compose(seat, { paintedPath, guidePath, width, height, holeInGuide }) {
  const gainField = softened(seat.gainField, WORK_WIDTH, WORK_HEIGHT, 3, 2)
  const painted = await readRaw(paintedPath, width, height)
  const guide = await readRaw(guidePath, width, height)
  const out = Buffer.alloc(width * height * 4)
  const scaleX = (WORK_WIDTH - 1) / Math.max(1, width - 1)
  const scaleY = (WORK_HEIGHT - 1) / Math.max(1, height - 1)
  for (let y = 0; y < height; y++) {
    const workY = y * scaleY
    for (let x = 0; x < width; x++) {
      const workX = x * scaleX
      const i = (y * width + x) * 4
      // Checked here at full size too: a sliver of hole can be too thin to survive the working size.
      const w = holeInGuide && holeTinted(guide, i) ? 1 : smooth((px, py) => seat.weight[py * WORK_WIDTH + px], workX, workY, WORK_WIDTH, WORK_HEIGHT)
      for (let c = 0; c < 3; c++) {
        const gain = smooth((px, py) => gainField[(py * WORK_WIDTH + px) * 3 + c], workX, workY, WORK_WIDTH, WORK_HEIGHT)
        const fill = Math.min(255, painted[i + c] * gain)
        out[i + c] = Math.round(guide[i + c] * (1 - w) + fill * w)
      }
      out[i + 3] = 255
    }
  }
  await writePng(paintedPath, out, width, height)
  return { gains: seat.gains }
}
