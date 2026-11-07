// A whole room painted in one picture leaves each thing in it only a few hundred pixels. So the things that matter
// are cut out, painted again at full size, and laid back in. No files in here, so it can be checked without a model.
const WIDTH = 2560
const HEIGHT = 1440
const ASPECT = WIDTH / HEIGHT
const MARGIN = 1.35 // Room around the thing, so the seam lands on what is behind it.
const MIN_SIDE = 640
const MAX_SIDE = 1200
const MIN_SHARE_SEEN = 0.7
const MIN_PIXELS = 120 * 120
const FEATHER_SHARE = 0.08
const MIN_FEATHER = 24
const GAIN_RANGE = [0.8, 1.25]

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const normalize = a => {
  const length = Math.hypot(...a)
  return a.map(value => value / length)
}

// Where a world point lands in a plate's pixels. Null behind the camera.
function projector({ position, target, fov }) {
  const forward = normalize(target.map((value, i) => value - position[i]))
  const right = normalize(cross(forward, [0, 1, 0]))
  const up = cross(right, forward)
  const tanY = Math.tan((fov * Math.PI) / 360)
  return point => {
    const offset = point.map((value, i) => value - position[i])
    const depth = dot(offset, forward)
    if (depth <= 0) return null
    return {
      x: (dot(offset, right) / (depth * tanY * ASPECT) * 0.5 + 0.5) * WIDTH,
      y: (0.5 - dot(offset, up) / (depth * tanY) * 0.5) * HEIGHT,
    }
  }
}

function boundsOnPlate({ center, size }, project) {
  const corners = [-1, 1].flatMap(sx => [-1, 1].flatMap(sy => [-1, 1].map(sz => project([center[0] + (sx * size[0]) / 2, center[1] + (sy * size[1]) / 2, center[2] + (sz * size[2]) / 2]))))
  if (corners.some(corner => !corner)) return null
  const xs = corners.map(corner => corner.x)
  const ys = corners.map(corner => corner.y)
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

// Where a block lands in a camera's picture, in pixels of a plate. Null if any of it is behind the camera.
export const pictureBounds = (block, camera) => boundsOnPlate(block, projector(camera))

// Where the middle of each thing standing on the floor should land, for checking a painting against the layout.
export function thingCentres({ blocks, shell }, cameraId) {
  return blocks.flatMap((block, index) => {
    const bounds = block.onTop ? null : pictureBounds(block, shell.CAMERAS[cameraId])
    return bounds ? [{ index, label: block.label, x: (bounds.x0 + bounds.x1) / 2, y: (bounds.y0 + bounds.y1) / 2 }] : []
  })
}

// How many pixels of a plate each thing's block takes up, by its place in the stage's list.
export function thingSizes({ blocks, shell }, cameraId) {
  return Object.fromEntries(blocks.flatMap((block, index) => {
    const bounds = block.onTop ? null : pictureBounds(block, shell.CAMERAS[cameraId])
    return bounds ? [[index, { wide: bounds.x1 - bounds.x0, bottom: bounds.y1 }]] : []
  }))
}

const areaOf = ({ x0, y0, x1, y1 }) => Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
const clipped = ({ x0, y0, x1, y1 }) => ({ x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(WIDTH, x1), y1: Math.min(HEIGHT, y1) })
const touch = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1

// The parts of this camera's picture worth painting again, biggest first. A lamp on a table goes with its table.
// Something too big to fit, such as a pillar running out of the picture, is left as it was painted.
export function regionsFor(stage, cameraId, limit = 3) {
  const project = projector(stage.shell.CAMERAS[cameraId])
  const groups = []
  for (const block of stage.blocks) {
    const whole = boundsOnPlate(block, project)
    if (!whole) continue
    const seen = clipped(whole)
    if (areaOf(seen) < MIN_PIXELS || areaOf(seen) / areaOf(whole) < MIN_SHARE_SEEN) continue
    const group = { ...seen, labels: [block.label] }
    for (let i = groups.length - 1; i >= 0; i--) {
      if (!touch(group, groups[i])) continue
      const other = groups.splice(i, 1)[0]
      group.x0 = Math.min(group.x0, other.x0)
      group.y0 = Math.min(group.y0, other.y0)
      group.x1 = Math.max(group.x1, other.x1)
      group.y1 = Math.max(group.y1, other.y1)
      group.labels = [...other.labels, ...group.labels]
    }
    groups.push(group)
  }
  return groups
    .flatMap(group => {
      const longest = Math.max(group.x1 - group.x0, group.y1 - group.y0) * MARGIN
      if (longest > MAX_SIDE) return []
      const side = Math.round(Math.max(MIN_SIDE, longest))
      const x = Math.round(Math.min(WIDTH - side, Math.max(0, (group.x0 + group.x1 - side) / 2)))
      const y = Math.round(Math.min(HEIGHT - side, Math.max(0, (group.y0 + group.y1 - side) / 2)))
      return [{ x, y, side, labels: group.labels, area: areaOf(group) }]
    })
    .sort((a, b) => b.area - a.area)
    .slice(0, limit)
    .map(({ area, ...region }) => region)
}

const smooth = t => t * t * (3 - 2 * t)

const SOFT_EDGE_PX = 5

// How much of each pixel belongs to a thing, from a picture where nothing is pure green, softened a little so a
// repainted thing has no hard rim. Reads the picture only: which thing it is does not matter here.
export function objectShare(matte, width, height) {
  let share = new Float32Array(width * height)
  for (let i = 0; i < share.length; i++) {
    const greenness = matte[i * 4 + 1] - Math.max(matte[i * 4], matte[i * 4 + 2])
    share[i] = greenness >= 80 ? 0 : greenness <= 25 ? 1 : (80 - greenness) / 55
  }
  for (const [stepX, stepY] of [[1, 0], [0, 1]]) {
    const next = new Float32Array(share.length)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0
        let count = 0
        for (let d = -SOFT_EDGE_PX; d <= SOFT_EDGE_PX; d++) {
          const nx = x + d * stepX
          const ny = y + d * stepY
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          sum += share[ny * width + nx]
          count++
        }
        next[y * width + x] = sum / count
      }
    }
    share = next
  }
  return share
}

// Lays each repainted part back into the picture, and with keep, only the things in it: the floor and wall around
// them stay as first painted, since a second painting of them never quite matches the first. Its colour is matched
// to what it replaces, and it fades in, so the join does not show even if the model shifted the tone a little.
export function composeDetails({ base, width, height, regions, details, keep = null }) {
  const out = Uint8ClampedArray.from(base)
  regions.forEach(({ x, y, side }, index) => {
    const detail = details[index]
    const feather = Math.max(MIN_FEATHER, Math.round(side * FEATHER_SHARE))
    const edgeDistance = (px, py) => Math.min(px, py, side - 1 - px, side - 1 - py)
    const keptAt = (px, py) => (keep ? keep[(y + py) * width + x + px] : 1)
    const sums = { old: [0, 0, 0], fresh: [0, 0, 0] }
    for (let py = 0; py < side; py++) {
      for (let px = 0; px < side; px++) {
        if (keep ? keptAt(px, py) < 0.5 : edgeDistance(px, py) >= feather) continue
        const at = ((y + py) * width + x + px) * 4
        const from = (py * side + px) * 4
        for (let channel = 0; channel < 3; channel++) {
          sums.old[channel] += out[at + channel]
          sums.fresh[channel] += detail[from + channel]
        }
      }
    }
    const gains = sums.old.map((value, channel) => Math.min(GAIN_RANGE[1], Math.max(GAIN_RANGE[0], value / Math.max(1, sums.fresh[channel]))))
    for (let py = 0; py < side; py++) {
      for (let px = 0; px < side; px++) {
        const blend = smooth(Math.min(1, edgeDistance(px, py) / feather)) * keptAt(px, py)
        if (blend <= 0) continue
        const at = ((y + py) * width + x + px) * 4
        const from = (py * side + px) * 4
        for (let channel = 0; channel < 3; channel++) out[at + channel] += (detail[from + channel] * gains[channel] - out[at + channel]) * blend
      }
    }
  })
  return out
}
