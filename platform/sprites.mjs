// Turns a generated green-screen walk video into a sprite sheet the game can play.
// Everything here works on raw RGBA frames, so it can be tested without a model or ffmpeg.

const OPAQUE = 128
const STRAY_PIXELS = 3 // Rows or columns with fewer solid pixels than this are compression noise.

function median(values) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
}

// How much green has to lead the other two colours before a pixel counts as screen. Judging by that
// rather than by closeness to one green also catches the shadows the model casts on the screen,
// which are dark green, while a teal coat, where green does not lead, stays solid.
const GREEN_LEAD_SOLID = 18
const GREEN_LEAD_SCREEN = 45

export function keyFrame(rgba) {
  const out = new Uint8ClampedArray(rgba.length)
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i]
    const g = rgba[i + 1]
    const b = rgba[i + 2]
    const lead = g - Math.max(r, b)
    out[i] = r
    // Removes the green glow that the screen leaves on hair and edges.
    out[i + 1] = Math.min(g, Math.max(r, b))
    out[i + 2] = b
    out[i + 3] = lead <= GREEN_LEAD_SOLID ? 255 : lead >= GREEN_LEAD_SCREEN ? 0 : ((GREEN_LEAD_SCREEN - lead) / (GREEN_LEAD_SCREEN - GREEN_LEAD_SOLID)) * 255
  }
  return out
}

export function measure(frame, width, height) {
  const rows = new Uint32Array(height)
  const columns = new Uint32Array(width)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (frame[(y * width + x) * 4 + 3] >= OPAQUE) {
        rows[y]++
        columns[x]++
      }
    }
  }
  const first = counts => counts.findIndex(count => count >= STRAY_PIXELS)
  const last = counts => counts.length - 1 - [...counts].reverse().findIndex(count => count >= STRAY_PIXELS)
  const minY = first(rows)
  if (minY < 0) throw new Error('这一帧里没有抠出人物：绿幕可能不干净。')
  const minX = first(columns)
  let total = 0
  let weighted = 0
  for (let x = 0; x < width; x++) {
    total += columns[x]
    weighted += columns[x] * x
  }
  return { minX, maxX: last(columns), minY, maxY: last(rows), centerX: Math.round(weighted / total) }
}

// Compares bodies, not screen positions: sampled relative to the feet and the body's centre,
// so a character drifting across the frame still reads as the same pose.
export function poseSignature(frame, width, height, box = measure(frame, width, height)) {
  const GRID = 48
  const step = Math.max(1, Math.round((box.maxY - box.minY + 1) / GRID))
  const signature = new Float32Array(GRID * GRID)
  for (let j = 0; j < GRID; j++) {
    const y = box.maxY - j * step
    for (let i = 0; i < GRID; i++) {
      const x = box.centerX + (i - GRID / 2) * step
      if (x >= 0 && x < width && y >= 0) signature[j * GRID + i] = frame[(y * width + x) * 4 + 3] / 255
    }
  }
  return signature
}

function difference(a, b) {
  let total = 0
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i])
  return total / a.length
}

// How much worse than the best match a shorter repeat may be and still count. Two repeats of a walk
// always match a little better than one, and playing two as one would halve its pace.
const SHORTER_CYCLE_ALLOWANCE = 1.7

// Scores run over consecutive lengths; a repeat is a dip among them.
export function shortestRepeat(scores) {
  const best = Math.min(...scores.map(({ score }) => score))
  const repeats = scores.filter(({ score }, index) =>
    score <= best * SHORTER_CYCLE_ALLOWANCE
    && (index === 0 || score <= scores[index - 1].score)
    && (index === scores.length - 1 || score <= scores[index + 1].score))
  return repeats[0]?.length ?? 0
}

// Finds the one repeat of the walk that loops most cleanly. The ends of the video are skipped
// because that is where the model is settling into and out of the standing pose.
export function findCycle(signatures, { minLength = 16, maxLength = 60, margin = 4 } = {}) {
  const usable = signatures.length - margin * 2
  const scores = []
  for (let length = minLength; length <= Math.min(maxLength, usable - 1); length++) {
    let total = 0
    let count = 0
    for (let start = margin; start + length < signatures.length - margin; start++) {
      total += difference(signatures[start], signatures[start + length])
      count++
    }
    if (count) scores.push({ length, score: total / count })
  }
  const bestLength = shortestRepeat(scores)
  if (!bestLength) throw new Error('行走视频太短，找不到完整的步伐循环。')
  let bestStart = margin
  let bestSeam = Infinity
  for (let start = margin; start + bestLength < signatures.length - margin; start++) {
    const seam = difference(signatures[start], signatures[start + bestLength])
    if (seam < bestSeam) {
      bestSeam = seam
      bestStart = start
    }
  }
  return { start: bestStart, length: bestLength, seam: bestSeam }
}

// Places each frame in its cell by an anchor. The default pins it by its feet and its centre.
export function buildSheet(frames, width, height, { columns: maxColumns = 8, anchors } = {}) {
  const boxes = frames.map(frame => measure(frame, width, height))
  const pins = anchors ?? boxes.map(box => ({ x: box.centerX, y: box.maxY }))
  const halfWidth = Math.max(...boxes.map((box, index) => Math.max(pins[index].x - box.minX, box.maxX - pins[index].x))) + 1
  const cellWidth = halfWidth * 2
  const above = Math.max(...boxes.map((box, index) => pins[index].y - box.minY))
  const below = Math.max(...boxes.map((box, index) => box.maxY - pins[index].y), 0)
  const cellHeight = above + below + 2
  const columns = Math.min(maxColumns, frames.length)
  const rows = Math.ceil(frames.length / columns)
  const sheetWidth = columns * cellWidth
  const sheetHeight = rows * cellHeight
  const pixels = new Uint8ClampedArray(sheetWidth * sheetHeight * 4)
  frames.forEach((frame, index) => {
    const box = boxes[index]
    const cellX = (index % columns) * cellWidth
    const cellY = Math.floor(index / columns) * cellHeight
    for (let y = box.minY; y <= box.maxY; y++) {
      const targetY = cellY + above + (y - pins[index].y)
      for (let x = box.minX; x <= box.maxX; x++) {
        const targetX = cellX + halfWidth + (x - pins[index].x)
        if (targetX < cellX || targetX >= cellX + cellWidth) continue
        const from = (y * width + x) * 4
        const to = (targetY * sheetWidth + targetX) * 4
        pixels[to] = frame[from]
        pixels[to + 1] = frame[from + 1]
        pixels[to + 2] = frame[from + 2]
        pixels[to + 3] = frame[from + 3]
      }
    }
  })
  return {
    pixels, width: sheetWidth, height: sheetHeight, columns, rows, cellWidth, cellHeight,
    frameCount: frames.length,
    standingHeight: boxes[0].maxY - boxes[0].minY + 1,
  }
}

// Scales a whole frame about the character's feet, so they stay exactly where they were.
export function scaleAboutFeet(frame, width, height, box, scale) {
  const out = new Uint8ClampedArray(frame.length)
  const originX = box.centerX
  const originY = box.maxY
  for (let y = 0; y < height; y++) {
    const sourceY = originY + (y - originY) / scale
    const y0 = Math.floor(sourceY)
    if (y0 < 0 || y0 + 1 >= height) continue
    const fy = sourceY - y0
    for (let x = 0; x < width; x++) {
      const sourceX = originX + (x - originX) / scale
      const x0 = Math.floor(sourceX)
      if (x0 < 0 || x0 + 1 >= width) continue
      const fx = sourceX - x0
      const to = (y * width + x) * 4
      for (let channel = 0; channel < 4; channel++) {
        const a = frame[(y0 * width + x0) * 4 + channel]
        const b = frame[(y0 * width + x0 + 1) * 4 + channel]
        const c = frame[((y0 + 1) * width + x0) * 4 + channel]
        const d = frame[((y0 + 1) * width + x0 + 1) * 4 + channel]
        out[to + channel] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
      }
    }
  }
  return out
}

// Where the head and shoulders are across, which unlike the whole body does not swing with the legs.
function upperBodyX(frame, width, box) {
  const bottom = box.minY + (box.maxY - box.minY) * 0.45
  let total = 0
  let weighted = 0
  for (let y = box.minY; y < bottom; y++) {
    for (let x = box.minX; x <= box.maxX; x++) {
      if (frame[(y * width + x) * 4 + 3] >= OPAQUE) {
        total++
        weighted += x
      }
    }
  }
  return total ? weighted / total : box.centerX
}

const DRIFT_REACH = 4 // Frames either side of the start of the cycle to measure drift from.

// How far some measurement moved over one repeat. The same pose one repeat apart has the same rise
// and fall, so whatever differs between the two can only be drift. Fitting a line through the values
// instead is pulled off by the steps themselves, and then the loop does not close.
function driftOverCycle(values, start, length) {
  const differences = []
  for (let index = Math.max(0, start - DRIFT_REACH); index <= start + DRIFT_REACH; index++) {
    if (index + length < values.length) differences.push(values[index + length] - values[index])
  }
  return differences.length ? median(differences) : 0
}

// Where to pin each frame of one repeat of the walk, and how much to scale it, given the whole video.
// Pinning every frame to its lowest foot would make the body hop whenever that foot changes, so these
// follow only the drift: the character sliding in the frame and shrinking as it walks away from the
// camera. The body keeps the rise and fall it really has, and the end of the loop meets its start.
export function steadyAnchors(frames, boxes, width, { start, length }) {
  const across = frames.map((frame, index) => upperBodyX(frame, width, boxes[index]))
  const lowest = boxes.map(box => box.maxY)
  const tallest = boxes.map(box => box.maxY - box.minY + 1)
  const driftX = driftOverCycle(across, start, length)
  const driftTop = driftOverCycle(boxes.map(box => box.minY), start, length)
  const driftHeight = driftOverCycle(tallest, start, length)
  const driftY = driftTop + driftHeight
  const cycle = Array.from({ length }, (_, offset) => offset)
  const meanWithout = (values, drift) =>
    cycle.reduce((sum, offset) => sum + values[start + offset] - (drift * offset) / length, 0) / length
  const baseX = meanWithout(across, driftX)
  const baseY = meanWithout(lowest, driftY)
  const baseHeight = meanWithout(tallest, driftHeight)
  const middleHeight = baseHeight + driftHeight / 2
  return cycle.map(offset => ({
    x: Math.round(baseX + (driftX * offset) / length),
    y: Math.round(baseY + (driftY * offset) / length),
    scale: middleHeight / (baseHeight + (driftHeight * offset) / length),
  }))
}

const SCALE_WORTH_RESAMPLING = 0.002

// Scales a frame about the point it will be pinned by, so the pin stays true.
function scaleAboutAnchor(frame, width, height, { x, y, scale }) {
  if (Math.abs(scale - 1) < SCALE_WORTH_RESAMPLING) return frame
  return scaleAboutFeet(frame, width, height, { centerX: x, maxY: y }, scale)
}

// How wide the feet reach, read from the bottom of the body only.
function footSpan(frame, width, box) {
  const top = box.maxY - Math.round((box.maxY - box.minY + 1) * 0.12)
  let left = width
  let right = -1
  for (let y = top; y <= box.maxY; y++) {
    for (let x = 0; x < width; x++) {
      if (frame[(y * width + x) * 4 + 3] >= OPAQUE) {
        if (x < left) left = x
        if (x > right) right = x
      }
    }
  }
  return right - left + 1
}

// How far the legs are apart, averaged down the lower body. A stride seen from an angle hardly
// separates the feet sideways, but it does show all the way up the legs.
function legSpread(frame, width, box) {
  const top = box.maxY - Math.round((box.maxY - box.minY + 1) * 0.3)
  let total = 0
  for (let y = top; y <= box.maxY; y++) {
    let left = width
    let right = -1
    for (let x = 0; x < width; x++) {
      if (frame[(y * width + x) * 4 + 3] >= OPAQUE) {
        if (x < left) left = x
        if (x > right) right = x
      }
    }
    total += Math.max(0, right - left + 1)
  }
  return total / (box.maxY - top + 1)
}

export function sheetFromVideoFrames(rawFrames, width, height, { standing: rawStanding, ...options } = {}) {
  const keyed = rawFrames.map(keyFrame)
  // Without a screen, the whole frame would count as the character and still look like a result.
  const corners = [0, width - 1, (height - 1) * width, height * width - 1]
  if (corners.some(pixel => keyed[0][pixel * 4 + 3] > 0)) throw new Error('背景不是绿幕，抠不出人物：这段行走视频不能用，请删掉后重新生成。')
  const boxes = keyed.map(frame => measure(frame, width, height))
  const cycle = findCycle(keyed.map((frame, index) => poseSignature(frame, width, height, boxes[index])), options)
  const walkingAnchors = steadyAnchors(keyed, boxes, width, cycle)
  const walking = keyed.slice(cycle.start, cycle.start + cycle.length).map((frame, index) => scaleAboutAnchor(frame, width, height, walkingAnchors[index]))
  const walkingBoxes = walking.map(frame => measure(frame, width, height))
  const bodyHeight = median(walkingBoxes.map(box => box.maxY - box.minY + 1))
  const spreads = walking.map((frame, index) => legSpread(frame, width, walkingBoxes[index]))
  const spans = walking.map((frame, index) => footSpan(frame, width, walkingBoxes[index]))
  // Every direction starts its cycle on the legs passing, so turning does not jump to another step.
  const passing = spreads.indexOf(Math.min(...spreads))
  const fromPassing = list => [...list.slice(passing), ...list.slice(0, passing)]
  let standing = walking[passing]
  if (rawStanding) {
    const keyedStanding = keyFrame(rawStanding)
    const box = measure(keyedStanding, width, height)
    standing = scaleAboutFeet(keyedStanding, width, height, box, bodyHeight / (box.maxY - box.minY + 1))
  }
  const standingBox = measure(standing, width, height)
  const sheet = buildSheet([standing, ...fromPassing(walking)], width, height, {
    anchors: [{ x: Math.round(upperBodyX(standing, width, standingBox)), y: standingBox.maxY }, ...fromPassing(walkingAnchors)],
  })
  return { ...sheet, cycleFrames: cycle.length, loopSeam: cycle.seam, bodyHeight, stepPixels: Math.max(...spans) - Math.min(...spans) }
}
