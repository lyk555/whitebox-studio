// What the picture that tells things apart actually says. The model never paints the colours quite pure, keeps some
// of the real picture's colours (a lock stays pale, books stay yellow), and draws lines all over it. So a colour alone
// proves nothing: a patch counts as a thing only if it is near where that thing stands, and anything else inside a
// thing is that thing. No rendering in here, so it can be checked without a browser.
import { OBJECT_COLOURS } from './objectColours.js'
import { NORTH } from './shell.js'

const BACKGROUND = -1
const LINE = -2
const STRAY = -3

const DARK_AS_A_LINE = 70
const LEAST_NEAR_PIXELS = 12
const SAME_COLOUR = 75 // Summed across the channels. Measured: a table's top and legs are within 20, the shelf behind it 116 off.
const LINE_GROWTH = 3 // Pixels. Enough to take in an outline, and not enough to run along the lines drawn on a wall.
const ROUNDS = 4
const NEARLY_AS_MUCH = 0.8

const nearestColour = (red, green, blue, count) => {
  let best = STRAY
  let nearest = Infinity
  OBJECT_COLOURS.slice(0, count).forEach(({ rgb: [r, g, b] }, index) => {
    const away = Math.abs(red - r) + Math.abs(green - g) + Math.abs(blue - b)
    if (away < nearest) {
      nearest = away
      best = index
    }
  })
  return best
}

// Whether this really is a picture of flat colours, and not a plain cut-out that kept the painting's own.
export function isColourMap(pixels, leastShare = 0.5) {
  let solid = 0
  let flat = 0
  for (let at = 0; at < pixels.length; at += 4) {
    if (pixels[at + 3] < 128) continue
    solid++
    const nearest = Math.min(...OBJECT_COLOURS.map(({ rgb: [r, g, b] }) => Math.abs(pixels[at] - r) + Math.abs(pixels[at + 1] - g) + Math.abs(pixels[at + 2] - b)))
    if (nearest < 120) flat++
  }
  return solid > 0 && flat / solid >= leastShare
}

// Which thing each pixel is, or -1. pixels is RGBA with the green already keyed out of the alpha. isNear(thing, pixel
// index) says whether a pixel is close to where that thing's block stands. blockAt, if given, says for each pixel which
// thing's block it is inside, or -1, with the smallest winning where they overlap.
export function labelThings({ pixels, width, height, things, isNear, blockAt = null }) {
  const total = width * height
  const labels = new Int8Array(total)
  for (let i = 0; i < total; i++) {
    const at = i * 4
    if (pixels[at + 3] < 128) labels[i] = BACKGROUND
    else if (Math.max(pixels[at], pixels[at + 1], pixels[at + 2]) < DARK_AS_A_LINE) labels[i] = LINE
    else labels[i] = nearestColour(pixels[at], pixels[at + 1], pixels[at + 2], things)
  }

  const seen = new Uint8Array(total)
  const stack = new Int32Array(total)
  // Calls back with each connected patch of one value.
  const patches = (wanted, visit) => {
    seen.fill(0)
    for (let start = 0; start < total; start++) {
      if (seen[start] || !wanted(labels[start])) continue
      const value = labels[start]
      const members = []
      let size = 0
      stack[size++] = start
      seen[start] = 1
      while (size) {
        const at = stack[--size]
        members.push(at)
        const x = at % width
        if (x > 0 && !seen[at - 1] && labels[at - 1] === value) { seen[at - 1] = 1; stack[size++] = at - 1 }
        if (x < width - 1 && !seen[at + 1] && labels[at + 1] === value) { seen[at + 1] = 1; stack[size++] = at + 1 }
        if (at >= width && !seen[at - width] && labels[at - width] === value) { seen[at - width] = 1; stack[size++] = at - width }
        if (at < total - width && !seen[at + width] && labels[at + width] === value) { seen[at + width] = 1; stack[size++] = at + width }
      }
      visit(value, members)
    }
  }
  const around = (at, visit) => {
    const x = at % width
    if (x > 0) visit(labels[at - 1])
    if (x < width - 1) visit(labels[at + 1])
    if (at >= width) visit(labels[at - width])
    if (at < total - width) visit(labels[at + width])
  }

  const nearCount = (value, members) => {
    let near = 0
    for (const at of members) if (isNear(value, at)) near++
    return near
  }

  // A thing is painted one colour, so the biggest patch of it near its block says what colour that is. Near the table
  // and nearest to red is not enough: the dark red gaps between the books on the shelf behind it are both.
  const biggest = new Map()
  patches(value => value >= 0, (value, members) => {
    const near = nearCount(value, members)
    if (near < LEAST_NEAR_PIXELS || near <= (biggest.get(value)?.near ?? 0)) return
    biggest.set(value, { near, members })
  })
  const reference = new Map([...biggest].map(([value, { members }]) => {
    const sum = [0, 0, 0]
    for (const at of members) for (let channel = 0; channel < 3; channel++) sum[channel] += pixels[at * 4 + channel]
    return [value, sum.map(part => part / members.length)]
  }))
  const awayFrom = (colour, at) => Math.abs(pixels[at * 4] - colour[0]) + Math.abs(pixels[at * 4 + 1] - colour[1]) + Math.abs(pixels[at * 4 + 2] - colour[2])

  // Where each thing actually is. A model free to design a thing can paint it well away from its block, so the block
  // alone cannot say what is near it: the bookcase here stands a metre to the side of where it was blocked out.
  const raw = labels.slice()
  for (let at = 0; at < total; at++) {
    if (labels[at] < 0) continue
    const colour = reference.get(labels[at])
    if (!colour || awayFrom(colour, at) > SAME_COLOUR) labels[at] = STRAY
  }
  const solid = new Map()
  patches(value => value >= 0, (value, members) => {
    const near = nearCount(value, members)
    if (near < LEAST_NEAR_PIXELS || near <= (solid.get(value)?.near ?? 0)) return
    solid.set(value, { near, members })
  })
  const extent = new Map([...solid].map(([value, { members }]) => {
    let [left, right, top, bottom] = [width, -1, height, -1]
    for (const at of members) {
      const x = at % width
      const y = (at - x) / width
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
    }
    return [value, { left, right, top, bottom }]
  }))
  const within = (value, at) => {
    if (isNear(value, at)) return true
    const box = extent.get(value)
    if (!box) return false
    const x = at % width
    const y = (at - x) / width
    return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
  }

  // Each pixel goes to the thing whose own colour it is closest to, of those it could belong to. Not to the closest of
  // the colours asked for: a lamp's base came out pale blue, nearer the chest's cyan than the lamp's blue, and the chest
  // is across the room.
  const owners = [...reference.keys()]
  for (let at = 0; at < total; at++) {
    if (raw[at] === BACKGROUND || raw[at] === LINE) {
      labels[at] = raw[at]
      continue
    }
    let best = STRAY
    let nearest = SAME_COLOUR
    for (const value of owners) {
      const away = awayFrom(reference.get(value), at)
      if (away <= nearest && within(value, at)) {
        nearest = away
        best = value
      }
    }
    labels[at] = best
  }

  // Paint of no clear colour inside a thing's own block is that thing: a lamp's stem paler than its shade, the rim of
  // the shade, the lines drawn on it. Left to whatever it touches most, it went to the bookcase behind. Green is left
  // alone, since the gap between a table's legs is inside its block too. So is anything else painted across that block,
  // like a dark edge of the bookcase behind a lamp, so it has to be nearer this thing's colour than any other's here.
  if (blockAt) {
    for (let at = 0; at < total; at++) {
      const value = blockAt[at]
      if (labels[at] !== STRAY || value < 0 || !reference.has(value)) continue
      const own = awayFrom(reference.get(value), at)
      if (owners.every(other => other === value || !within(other, at) || awayFrom(reference.get(other), at) > own)) labels[at] = value
    }
  }

  const growOutlines = () => {
    for (let step = 0; step < LINE_GROWTH; step++) {
      const taken = []
      for (let at = 0; at < total; at++) {
        if (labels[at] !== LINE) continue
        const counts = new Map()
        around(at, value => { if (value >= 0) counts.set(value, (counts.get(value) ?? 0) + 1) })
        if (!counts.size) continue
        taken.push([at, [...counts].sort((a, b) => b[1] - a[1])[0][0]])
      }
      for (const [at, value] of taken) labels[at] = value
    }
  }

  // Inside a thing is that thing. Inside nothing is nothing, however bright: a window, a door handle.
  for (let round = 0; round < ROUNDS; round++) {
    growOutlines()
    let changed = false
    patches(value => value === STRAY || value === LINE, (value, members) => {
      const counts = new Map()
      let background = 0
      for (const at of members) {
        around(at, neighbour => {
          if (neighbour === BACKGROUND) background++
          else if (neighbour >= 0) counts.set(neighbour, (counts.get(neighbour) ?? 0) + 1)
        })
      }
      const ranked = [...counts].sort((a, b) => b[1] - a[1])
      if (!ranked.length || ranked[0][1] <= background) return
      // Where it touches two things about equally, it is the one whose colour it is nearer.
      const close = ranked.filter(([, count]) => count >= ranked[0][1] * NEARLY_AS_MUCH)
      const closeness = value => members.reduce((sum, at) => sum + awayFrom(reference.get(value), at), 0)
      const best = close.reduce((a, b) => (closeness(b[0]) < closeness(a[0]) ? b : a))
      for (const at of members) labels[at] = best[0]
      changed = true
    })
    if (!changed) break
  }
  for (let at = 0; at < total; at++) if (labels[at] < 0) labels[at] = BACKGROUND
  return labels
}

const SPIKE_SHARE = 0.03
const LEAST_COLUMNS = 8
const FLOOR_BELOW = 3 // Pixels. What is under a thing's lowest edge has to be floor, not another thing hiding it.

const WIDTH_FROM_LOWEST = 0.7 // Share of its height. Verticals lean in a picture looking down, and cornices overhang.
const LEAST_IN_A_COLUMN = 3

// How wide a thing is painted, in the columns of the picture, over its lower part. Its outline, not its foot: another
// thing standing in front can hide the foot and still leave the side in plain view.
function outlineColumns(labels, thing, width, height) {
  let top = height
  let bottom = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (labels[y * width + x] !== thing) continue
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
    }
  }
  if (bottom < 0) return null
  const from = Math.round(bottom - (bottom - top) * WIDTH_FROM_LOWEST)
  let left = width
  let right = -1
  for (let x = 0; x < width; x++) {
    let count = 0
    for (let y = from; y <= bottom; y++) if (labels[y * width + x] === thing) count++
    if (count < LEAST_IN_A_COLUMN) continue
    left = Math.min(left, x)
    right = Math.max(right, x)
  }
  return right < 0 ? null : { left, right, bottom }
}

// Where a thing stands, from its paint. The front edge is where the lowest edge has floor showing under it, carried
// onto the floor by toFloor(x, y); null if too little of it does. How wide comes from its outline, at the depth of that
// front edge, by atDepth(x, y, z), which says what room x a picture's pixel is at that depth. knownFrontZ is used when
// the foot cannot be seen. Null if the thing is not in the picture.
export function footprintOf(labels, thing, width, height, toFloor, atDepth, knownFrontZ) {
  const points = []
  for (let x = 0; x < width; x++) {
    let lowest = -1
    for (let y = height - 1; y >= 0; y--) {
      if (labels[y * width + x] === thing) {
        lowest = y
        break
      }
    }
    if (lowest < 0) continue
    let onFloor = true
    for (let below = 1; below <= FLOOR_BELOW && lowest + below < height; below++) {
      if (labels[(lowest + below) * width + x] !== BACKGROUND) onFloor = false
    }
    if (!onFloor) continue
    const point = toFloor(x, lowest)
    if (point) points.push(point)
  }
  const outline = outlineColumns(labels, thing, width, height)
  if (!outline) return null
  const quantile = (values, share) => [...values].sort((a, b) => a - b)[Math.round((values.length - 1) * share)]
  const seen = points.length >= LEAST_COLUMNS ? quantile(points.map(point => point.z), 1 - SPIKE_SHARE) : null
  const frontZ = seen ?? knownFrontZ
  return { minX: atDepth(outline.left, outline.bottom, frontZ), maxX: atDepth(outline.right, outline.bottom, frontZ), frontZ, footSeen: seen !== null }
}

const AGAINST_WALL = 0.5 // Metres from the back wall to the back of a thing. Too narrow for anyone to walk through.
const LARGEST_CORRECTION = 1.8 // Metres. Past this the paint and the block are not the same thing, and the block stands.

// The bounds a thing should collide with: at least as wide and as far forward as painted. Never narrower than the
// block: a thing half hidden behind another shows only part of its foot, which says nothing about the rest. A picture
// from the front says nothing about how deep a thing goes, so one painted further forward has simply moved forward and
// keeps its depth, or its old back edge would block the way behind it. One against the wall stays against it, or the
// player could walk round behind what looks solid.
export function boundsFromPaint({ center, size }, footprint) {
  const block = { minX: center[0] - size[0] / 2, maxX: center[0] + size[0] / 2, minZ: center[2] - size[2] / 2, maxZ: center[2] + size[2] / 2 }
  if (!footprint) return block
  const tooFar = Math.abs(footprint.minX - block.minX) > LARGEST_CORRECTION || Math.abs(footprint.maxX - block.maxX) > LARGEST_CORRECTION || Math.abs(footprint.frontZ - block.maxZ) > LARGEST_CORRECTION
  if (tooFar || footprint.maxX <= footprint.minX) return block
  const maxZ = Math.max(block.maxZ, footprint.frontZ)
  const againstWall = block.minZ - NORTH < AGAINST_WALL
  return { minX: Math.min(block.minX, footprint.minX), maxX: Math.max(block.maxX, footprint.maxX), minZ: againstWall ? block.minZ : block.minZ + (maxZ - block.maxZ), maxZ }
}

const FLOOD_STEP = 0.15

// Every place on the floor that can be walked to from here, as a test of a point.
export function reachableFrom(start, walkable) {
  const key = (i, j) => `${i},${j}`
  const found = new Set([key(0, 0)])
  const queue = [[0, 0]]
  while (queue.length) {
    const [i, j] = queue.pop()
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = key(i + di, j + dj)
      if (found.has(next) || !walkable(start.x + (i + di) * FLOOD_STEP, start.z + (j + dj) * FLOOD_STEP)) continue
      found.add(next)
      queue.push([i + di, j + dj])
    }
  }
  return ({ x, z }) => {
    const i = Math.round((x - start.x) / FLOOD_STEP)
    const j = Math.round((z - start.z) / FLOOD_STEP)
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (found.has(key(i + a, j + b))) return true
    return false
  }
}

// The nearest place to this one that can be stood on, or null.
export function nearestWalkable({ x, z }, walkable, reach = 3) {
  if (walkable(x, z)) return { x, z }
  for (let radius = 0.1; radius <= reach; radius += 0.1) {
    for (let turn = 0; turn < 24; turn++) {
      const angle = (turn / 24) * Math.PI * 2
      const spot = { x: x + radius * Math.cos(angle), z: z + radius * Math.sin(angle) }
      if (walkable(spot.x, spot.z)) return spot
    }
  }
  return null
}
