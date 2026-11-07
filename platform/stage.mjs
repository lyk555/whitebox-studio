// Turns a scene into what stands on the stage, and says what is wrong with it before anything is paid for.
// The model describes what stands where; whether it can stand there, be walked to and be filmed is decided here.
import { ACTION_BEFORE_FACE, speechTiming } from './speech.mjs'
import { createPlayer, stepToward } from '../runtime/controller.js'
import { cameraIsClear, plateSees, shotPose, staysOnPlate } from '../runtime/followCamera.js'
import { SHOT_DISTANCE } from '../runtime/story.js'
import { PLAYER_RADIUS, shellFrom, walkableIn } from '../runtime/shell.js'
import { pictureBounds } from './detail.mjs'
import { INTERACT_RADIUS } from '../runtime/world.js'

const box = (x, y, z, w, h, d) => ({ shape: 'box', at: [x, y, z], size: [w, h, d] })
const round = (x, y, z, radiusTop, radiusBottom, height) => ({ shape: 'round', at: [x, y, z], radiusTop, radiusBottom, height })
const dome = (x, y, z, radius, length) => ({ shape: 'dome', at: [x, y, z], radius, length })

const legs = (w, d, h, thick = 0.12) => [[-1, -1], [1, -1], [-1, 1], [1, 1]]
  .map(([sx, sz]) => box(sx * (w / 2 - thick / 2), h / 2, sz * (d / 2 - thick / 2), thick, h, thick))

// Rough shapes only, standing on y = 0 around x = z = 0. The bounds are what people and cameras collide with.
export const ARCHETYPES = {
  table: { label: '长桌', size: [2, 0.85, 1], parts: [box(0, 0.79, 0, 2, 0.12, 1), ...legs(2, 1, 0.73, 0.14)] },
  desk: { label: '书桌', size: [1.5, 0.8, 0.75], parts: [box(0, 0.75, 0, 1.5, 0.1, 0.75), box(-0.55, 0.35, 0, 0.4, 0.7, 0.65), box(0.68, 0.35, 0, 0.1, 0.7, 0.65)] },
  chair: { label: '椅子', size: [0.55, 1, 0.55], parts: [box(0, 0.47, 0, 0.55, 0.08, 0.55), box(0, 0.75, -0.23, 0.55, 0.5, 0.08), ...legs(0.55, 0.55, 0.43, 0.07)] },
  couch: { label: '沙发', size: [2.1, 0.9, 0.85], parts: [box(0, 0.25, 0.075, 1.7, 0.5, 0.7), box(0, 0.45, -0.325, 2.1, 0.9, 0.2), box(-0.95, 0.325, 0.075, 0.2, 0.65, 0.7), box(0.95, 0.325, 0.075, 0.2, 0.65, 0.7)] },
  bed: { label: '床', size: [2.1, 0.8, 1.3], parts: [box(0, 0.25, 0, 2.1, 0.5, 1.3), box(-1, 0.55, 0, 0.1, 0.5, 1.3), box(-0.65, 0.56, 0, 0.5, 0.12, 0.9)] },
  shelf: { label: '书架', size: [2.5, 2, 0.5], parts: [box(0, 0.95, -0.02, 2.4, 1.9, 0.46), box(0, 1.95, 0, 2.5, 0.1, 0.5)] },
  cabinet: { label: '高柜', size: [1, 1.8, 1], parts: [box(0, 0.1, 0, 0.8, 0.2, 0.8), box(0, 0.95, 0, 0.9, 1.5, 0.9), box(0, 1.75, 0, 1, 0.1, 1)] },
  chest: { label: '箱子', size: [1.3, 1.1, 0.9], parts: [box(0, 0.325, 0, 1.3, 0.65, 0.9), dome(0, 0.65, 0, 0.45, 1.3)] },
  crate: { label: '木箱堆', size: [1, 1, 1], parts: [box(0, 0.5, 0, 1, 1, 1)] },
  barrel: { label: '圆桶', size: [0.8, 1.1, 0.8], parts: [round(0, 0.55, 0, 0.36, 0.36, 1.1)] },
  pillar: { label: '柱子', size: [0.8, 5, 0.8], parts: [box(0, 0.2, 0, 0.8, 0.4, 0.8), round(0, 2.7, 0, 0.28, 0.28, 4.6)] },
  statue: { label: '雕像', size: [0.9, 2.3, 0.9], parts: [box(0, 0.4, 0, 0.9, 0.8, 0.9), round(0, 1.55, 0, 0.2, 0.32, 1.5)] },
  counter: { label: '柜台', size: [2.6, 1.05, 0.7], parts: [box(0, 0.5, 0, 2.5, 1, 0.65), box(0, 1.02, 0, 2.6, 0.06, 0.7)] },
  stove: { label: '炉灶', size: [1, 1.2, 0.8], parts: [box(0, 0.45, 0, 1, 0.9, 0.8), round(0, 1.05, 0, 0.14, 0.14, 0.3)] },
  altar: { label: '祭台', size: [1.8, 1.1, 0.9], parts: [box(0, 0.1, 0, 1.8, 0.2, 0.9), box(0, 0.6, 0, 1.5, 0.8, 0.7), box(0, 1.05, 0, 1.7, 0.1, 0.85)] },
  rock: { label: '巨石', size: [1.5, 0.75, 1.2], parts: [dome(0, 0, 0, 0.6, 1.5)] },
  tree: { label: '树', size: [1.3, 3.4, 1.3], parts: [round(0, 1, 0, 0.16, 0.22, 2), round(0, 2.6, 0, 0.3, 0.65, 1.6)] },
  floor_lamp: { label: '落地灯', size: [0.45, 1.7, 0.45], parts: [round(0, 0.72, 0, 0.03, 0.14, 1.44), round(0, 1.56, 0, 0.1, 0.22, 0.28)] },
  // These go on top of something, named by the object's "on".
  lamp: { label: '台灯', size: [0.4, 0.6, 0.4], onTop: true, parts: [round(0, 0.46, 0, 0.1, 0.2, 0.28), round(0, 0.16, 0, 0.035, 0.07, 0.32)] },
  box_small: { label: '小盒子', size: [0.4, 0.25, 0.3], onTop: true, parts: [box(0, 0.125, 0, 0.4, 0.25, 0.3)] },
  vase: { label: '花瓶', size: [0.3, 0.45, 0.3], onTop: true, parts: [round(0, 0.225, 0, 0.09, 0.14, 0.45)] },
}

// The ways out of a place come from the map, so there is only one thing to change when the map does.
export const shellFor = scene => shellFrom(scene.exits ? { ...scene.stage, ways: scene.exits } : scene.stage)
const TUNED_SHELL = shellFrom()

// Where things can stand when nothing asked for a place. Each spot was seen working in the tuned room from the
// camera that paints it, and in another room it keeps its share of the floor.
export const SLOTS = {
  center: { label: '房间中央', x: -1, z: 0.5, performs: true },
  back_center: { label: '后墙中段', x: 0.5, back: true, performs: true },
  right: { label: '右侧', x: 4.2, z: -1.5, performs: true },
  center_right: { label: '中央偏右', x: 1.9, z: -1, performs: true },
  back_right: { label: '后墙右段', x: 4.6, back: true, performs: true },
  left: { label: '左侧', x: -3.9, z: 1 },
  front_right: { label: '前景右侧', x: 3, z: 2.28 },
  right_wall: { label: '右墙边', x: 5.8, z: 1.5 },
  left_back: { label: '门旁', x: -4.4, z: -1.6 },
}

export const SLOT_ORDER = Object.keys(SLOTS)

function slotAt(slot, depth, shell) {
  const spot = SLOTS[slot]
  const x = shell.room.west + (spot.x - TUNED_SHELL.room.west) * shell.scaleX
  const z = spot.back ? shell.ROOM_WALK.minZ - 0.25 + depth / 2 : shell.room.north + (spot.z - TUNED_SHELL.room.north) * shell.scaleZ
  return { x: Number(x.toFixed(2)), z: Number(z.toFixed(2)) }
}

export const slotPosition = (slot, archetype, shell = TUNED_SHELL) => slotAt(slot, ARCHETYPES[archetype].size[2], shell)

// A rough model made for this object, or one of the stock ones.
export const shapeOf = object => object.shape ?? ARCHETYPES[object.archetype]

const angleDelta = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from))

// A video pinned to the game's picture must not show a face, so whoever performs has their back to the camera.
const MAX_TURN_FROM_BACK = 1.2

function buildBlocks(objects) {
  const placed = new Map()
  const issues = []
  for (const object of objects) {
    const kind = shapeOf(object)
    if (!kind) {
      issues.push({ level: 'error', message: `“${object.name}”的种类 ${object.archetype} 不存在。` })
      continue
    }
    if (kind.onTop && !object.on) {
      issues.push({ level: 'error', message: `“${object.name}”要放在别的东西上面，但没有说放在哪。` })
      continue
    }
    const host = object.on ? placed.get(object.on) : null
    if (object.on && !host) {
      issues.push({ level: 'error', message: `“${object.name}”放在 ${object.on} 上，但那件东西不在场景里。` })
      continue
    }
    const base = host ? host.center[1] + host.size[1] / 2 : 0
    const x = host ? host.center[0] + (object.dx ?? 0) : object.x
    const z = host ? host.center[2] + (object.dz ?? 0) : object.z
    const [w, h, d] = kind.size
    const parts = kind.parts.map(({ at, ...rest }) => ({ ...rest, center: [x + at[0], base + at[1], z + at[2]] }))
    placed.set(object.id, { name: object.id, label: object.name, look: object.look ?? '', archetype: object.archetype, center: [x, base + h / 2, z], size: [w, h, d], parts, onTop: Boolean(host), onLabel: host?.label })
  }
  return { blocks: [...placed.values()], issues }
}

// Each object has one picture, from the first camera that can see it whole. Height is not counted
// past what any camera frames: a pillar running up out of the picture is still seen.
const CHECK_HEIGHT = 2.2

function cameraSeeing({ center, size }, { CAMERAS }) {
  const [w, h, d] = size
  const top = Math.min(center[1] + h / 2, CHECK_HEIGHT)
  const low = center[1] - h / 2
  const corners = [low, top].flatMap(y => [-1, 1].flatMap(sx => [-1, 1].map(sz => [center[0] + (sx * w) / 2, y, center[2] + (sz * d) / 2])))
  if (corners.every(point => plateSees(CAMERAS.a, point))) return 'a'
  if (corners.every(point => plateSees(CAMERAS.b, point))) return 'b'
  return null
}

const overlaps = (a, b) =>
  Math.abs(a.center[0] - b.center[0]) < (a.size[0] + b.size[0]) / 2
  && Math.abs(a.center[2] - b.center[2]) < (a.size[2] + b.size[2]) / 2

const fitsRoom = ({ center: [x, , z], size: [w, , d] }, { room }) => x - w / 2 >= room.west && x + w / 2 <= room.east && z - d / 2 >= room.north && z + d / 2 <= room.south

// The mark is reached by walking straight at it, so something in the way would strand the player
// there, and the performance would never start.
function reachableFromPrompt(mark, target, walkable) {
  const STEP = 0.3
  for (let x = target.x - target.radius; x <= target.x + target.radius; x += STEP) {
    for (let z = target.z - target.radius; z <= target.z + target.radius; z += STEP) {
      if (Math.hypot(x - target.x, z - target.z) > target.radius || !walkable(x, z, false)) continue
      const player = createPlayer({ x, z, yaw: 0 })
      let arrived = false
      for (let i = 0; i < 500 && !arrived; i++) arrived = stepToward(player, mark, 1 / 30, false, walkable)
      if (!arrived) return false
    }
  }
  return true
}

// Somewhere to stand for a performance: back to the camera, on one camera's side of the room, framed
// by what that camera's plate saw, and reachable. Off to one side comes first, so whoever performs does
// not stand in front of what they are doing. A big object cannot be walked through from behind, so if
// no mark works from all around it, the prompt only shows on the side the mark is on.
function findMark(block, wide, blocks, walkable, { CAMERAS, CAMERA_SWITCH }) {
  const [cx, , cz] = block.center
  const [w, , d] = block.size
  const candidates = []
  for (const gap of [0.45, 0.7, 1]) {
    for (const across of [-0.5, 0.5, 0, 1, -1]) {
      const x = cx + across * (w / 2 + gap * Math.abs(across))
      const z = cz + d / 2 + gap * (1 - Math.abs(across) / 2)
      candidates.push({ x, z })
    }
  }
  const framed = candidates.flatMap(({ x, z }) => {
    if (!walkable(x, z, false)) return []
    const camera = x < CAMERA_SWITCH.toA ? 'a' : x > CAMERA_SWITCH.toB ? 'b' : null
    if (!camera) return []
    const yaw = Math.atan2(cx - x, cz - z)
    if (Math.abs(angleDelta(yaw, Math.PI)) > MAX_TURN_FROM_BACK) return []
    const mark = { x: Number(x.toFixed(2)), z: Number(z.toFixed(2)), yaw: Number(yaw.toFixed(4)) }
    if (CAMERAS.a.fixed) return [{ mark, camera }]
    const shot = shotPose(CAMERAS[camera], mark, SHOT_DISTANCE)
    if (!staysOnPlate(shot, CAMERAS[camera]) || !cameraIsClear(shot.position, blocks)) return []
    return [{ mark, camera }]
  })
  // One camera frames every mark the same, and the player is walked round what stands in the way, so a mark has
  // only to be somewhere to stand. Whether it can be got to is checked with everything else.
  if (CAMERAS.a.fixed) return framed.length ? { ...framed[0], target: wide } : null
  const fromAround = framed.find(({ mark }) => reachableFromPrompt(mark, wide, walkable))
  if (fromAround) return { ...fromAround, target: wide }
  for (const { mark, camera } of framed) {
    const onItsSide = { x: mark.x, z: mark.z, radius: Math.min(wide.radius, Math.max(0.9, d / 2 + 0.6)) }
    if (reachableFromPrompt(mark, onItsSide, walkable)) return { mark, camera, target: onItsSide }
  }
  return null
}

function floodFrom(start, walkable) {
  const STEP = 0.15
  const key = (i, j) => `${i},${j}`
  const seen = new Set([key(0, 0)])
  const queue = [[0, 0]]
  while (queue.length) {
    const [i, j] = queue.pop()
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di
      const nj = j + dj
      if (seen.has(key(ni, nj)) || !walkable(start.x + ni * STEP, start.z + nj * STEP, false)) continue
      seen.add(key(ni, nj))
      queue.push([ni, nj])
    }
  }
  return ({ x, z }) => {
    const i = Math.round((x - start.x) / STEP)
    const j = Math.round((z - start.z) / STEP)
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) if (seen.has(key(i + a, j + b))) return true
    return false
  }
}

function findSpawn(walkable, { SPAWN_WANTED: wanted }) {
  for (let radius = 0; radius < 4; radius += 0.25) {
    for (let turn = 0; turn < 16; turn++) {
      const x = wanted.x + radius * Math.cos((turn * Math.PI) / 8)
      const z = wanted.z + radius * Math.sin((turn * Math.PI) / 8)
      if (walkable(x, z, false)) return { x: Number(x.toFixed(2)), z: Number(z.toFixed(2)), yaw: Math.PI }
    }
  }
  return { ...wanted, yaw: Math.PI }
}

const idsOf = value => [value].flat().filter(Boolean)

const TALL_THING = 1.6 // Metres. Taller than this and a person cannot be seen past it.
const TALL_STAYS_BEHIND = 0.45 // Share of the way from the back of the room to the near edge.
const MOST_HIDDEN = 0.25 // Of a thing the story uses. Also what makes a model take two things for each other.

// How much of a thing's place in the picture is covered by things standing in front of it.
export function hiddenShare(block, standing, camera) {
  const own = pictureBounds(block, camera)
  if (!own) return 0
  const area = (own.x1 - own.x0) * (own.y1 - own.y0)
  const front = thing => thing.center[2] + thing.size[2] / 2
  let covered = 0
  for (const other of standing) {
    if (other === block || front(other) <= front(block)) continue
    const theirs = pictureBounds(other, camera)
    if (!theirs) continue
    covered += Math.max(0, Math.min(own.x1, theirs.x1) - Math.max(own.x0, theirs.x0)) * Math.max(0, Math.min(own.y1, theirs.y1) - Math.max(own.y0, theirs.y0))
  }
  return Math.min(1, covered / area)
}

const FLOOR_CELL = 0.1 // Metres.
export const MIN_PASSAGE = 1.1 // Metres. A person walks through this without looking squeezed. Less should be no way through at all.
const SHORTEST_SQUEEZE = 0.5 // Metres long. Less is only the rounding of a corner. By length, not area: the tighter a gap, the less room a person's centre has in it, so the worst ones have the smallest area.

// Places a person fits but only just: a gap between two things, or a thing and the edge of the picture, too narrow to
// look like a way through. Decided here, on the whitebox, because a room that is too tight is a fault of its layout,
// and nothing done to the picture afterwards can make it roomier.
export function narrowPassages(shell, standing) {
  const { ROOM_WALK: walk } = shell
  const rimmed = { minX: walk.minX - PLAYER_RADIUS, maxX: walk.maxX + PLAYER_RADIUS, minZ: walk.minZ - PLAYER_RADIUS, maxZ: walk.maxZ + PLAYER_RADIUS }
  const columns = Math.round((rimmed.maxX - rimmed.minX) / FLOOR_CELL) + 1
  const rows = Math.round((rimmed.maxZ - rimmed.minZ) / FLOOR_CELL) + 1
  const xOf = i => rimmed.minX + i * FLOOR_CELL
  const zOf = j => rimmed.minZ + j * FLOOR_CELL
  const open = new Uint8Array(columns * rows)
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const x = xOf(i)
      const z = zOf(j)
      const onSomething = standing.some(({ center, size }) => Math.abs(x - center[0]) < size[0] / 2 && Math.abs(z - center[2]) < size[2] / 2)
      open[j * columns + i] = !onSomething && (shell.inFrame?.(x, z) ?? true) ? 1 : 0
    }
  }
  const reach = Math.floor(MIN_PASSAGE / 2 / FLOOR_CELL) // Across a disc is one cell more than twice this.
  const disc = []
  for (let b = -reach; b <= reach; b++) for (let a = -reach; a <= reach; a++) if (a * a + b * b <= reach * reach) disc.push([a, b])
  // Everywhere a circle as wide as the passage can reach, rolling around on open floor.
  const roomy = new Uint8Array(columns * rows)
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const fits = disc.every(([a, b]) => {
        const c = i + a
        const d = j + b
        return c >= 0 && d >= 0 && c < columns && d < rows && open[d * columns + c]
      })
      if (!fits) continue
      for (const [a, b] of disc) roomy[(j + b) * columns + i + a] = 1
    }
  }
  const walkable = walkableIn(shell, standing)
  const squeezed = new Uint8Array(columns * rows)
  // A cell's grace around what is roomy, or the stair-steps along a slanted edge of the picture read as a long thin gap.
  const graced = Uint8Array.from(roomy)
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      if (!roomy[j * columns + i]) continue
      for (let b = -1; b <= 1; b++) {
        for (let a = -1; a <= 1; a++) {
          if (i + a >= 0 && j + b >= 0 && i + a < columns && j + b < rows) graced[(j + b) * columns + i + a] = 1
        }
      }
    }
  }
  // Looked for between the cells as well: where a person only just fits, the room for them can be narrower than a cell.
  const half = FLOOR_CELL / 2
  const canStand = (x, z) => [[0, 0], [half, 0], [-half, 0], [0, half], [0, -half]].some(([a, b]) => walkable(x + a, z + b, false))
  for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) if (!graced[j * columns + i] && canStand(xOf(i), zOf(j))) squeezed[j * columns + i] = 1
  const found = []
  for (let start = 0; start < squeezed.length; start++) {
    if (!squeezed[start]) continue
    const cells = []
    const stack = [start]
    squeezed[start] = 0
    while (stack.length) {
      const at = stack.pop()
      cells.push(at)
      const i = at % columns
      for (const next of [i > 0 ? at - 1 : -1, i < columns - 1 ? at + 1 : -1, at - columns, at + columns]) {
        if (next >= 0 && next < squeezed.length && squeezed[next]) {
          squeezed[next] = 0
          stack.push(next)
        }
      }
    }
    const spans = [cells.map(at => at % columns), cells.map(at => Math.floor(at / columns))].map(line => Math.max(...line) - Math.min(...line) + 1)
    if (Math.max(...spans) * FLOOR_CELL < SHORTEST_SQUEEZE) continue
    const x = cells.reduce((sum, at) => sum + xOf(at % columns), 0) / cells.length
    const z = cells.reduce((sum, at) => sum + zOf(Math.floor(at / columns)), 0) / cells.length
    const away = ({ center, size }) => Math.hypot(Math.max(0, Math.abs(x - center[0]) - size[0] / 2), Math.max(0, Math.abs(z - center[2]) - size[2] / 2))
    const nearest = [...standing].sort((a, b) => away(a) - away(b)).slice(0, 2)
    found.push({ x: Number(x.toFixed(1)), z: Number(z.toFixed(1)), nearest })
  }
  return found
}

// Everything the game reads for this scene, and every reason it could not be played or painted.
export function buildStage(scene) {
  const shell = shellFor(scene)
  const { blocks, issues } = buildBlocks(scene.objects ?? [])
  const walkable = walkableIn(shell, blocks)
  if (!blocks.length) issues.push({ level: 'error', message: '场景里还没有任何物件。' })

  for (const block of blocks) {
    const seenBy = cameraSeeing(block, shell)
    if (seenBy === 'b') block.paintedBy = 'b'
    if (!seenBy) issues.push({ level: 'error', message: `“${block.label}”从两个机位都看不全，画不出来，请挪动它。`, object: block.name })
    if (!fitsRoom(block, shell)) issues.push({ level: 'error', message: `“${block.label}”超出了房间。`, object: block.name })
  }
  const standing = blocks.filter(block => !block.onTop)
  for (let i = 0; i < standing.length; i++) {
    for (let j = i + 1; j < standing.length; j++) {
      if (overlaps(standing[i], standing[j])) issues.push({ level: 'error', message: `“${standing[i].label}”和“${standing[j].label}”叠在一起了。`, object: standing[i].name })
    }
  }

  const spawn = findSpawn(walkable, shell)
  const reachable = floodFrom(spawn, walkable)
  const exitName = way => scene.exits?.find(exit => exit.id === way.id)?.name
  for (const way of shell.EXITS) {
    if (!reachable(way.anchor)) issues.push({ level: 'error', message: exitName(way) ? `从出生点走不到“${exitName(way)}”，路被东西挡住了。` : '从出生点走不到出口，路被东西挡住了。' })
  }

  // With one camera the whole room is in view at once, so a tight spot shows the whole time.
  if (shell.stage.framing === 'close') {
    for (const { nearest } of narrowPassages(shell, standing)) {
      issues.push({ level: 'error', message: `${nearest.map(block => `“${block.label}”`).join('和')}旁边的过道太窄，人只能挤过去。要么留出至少 ${MIN_PASSAGE} 米，要么把它们靠在一起，不留缝。`, object: nearest[0]?.name })
    }
    for (const { object } of scene.beats ?? []) {
      const block = blocks.find(candidate => candidate.name === object)
      const hidden = block && hiddenShare(block, standing, shell.CAMERAS.a)
      if (hidden > MOST_HIDDEN) issues.push({ level: 'error', message: `“${block.label}”要用来互动，但有 ${Math.round(hidden * 100)}% 被前面的东西挡住了，玩家看不清。请把它挪到能看全的地方。`, object: block.name })
    }
    // Something tall out in the room stands like a wall across a picture that has only the one view.
    const backOfRoom = shell.room.north + (shell.room.south - shell.room.north) * TALL_STAYS_BEHIND
    for (const block of standing) {
      if (block.size[1] > TALL_THING && block.center[2] > backOfRoom) {
        issues.push({ level: 'error', message: `“${block.label}”有 ${block.size[1]} 米高，放在房间中间会像一堵墙。请靠${shell.kind === 'outdoor' ? '远端' : '后墙'}放，中心的 z 不要超过 ${Number(backOfRoom.toFixed(1))}。`, object: block.name })
      }
    }
    // Nor can the way out be hidden, or the player cannot see where to go. What is in front of it is what moves.
    const { CAMERAS } = shell
    for (const exit of shell.EXITS) {
      const way = { center: [exit.x, exit.height / 2, exit.z], size: [exit.width, exit.height, 0.1] }
      if (hiddenShare(way, standing, CAMERAS.a) > MOST_HIDDEN) {
        const inFront = standing.map(block => ({ block, hides: hiddenShare(way, [block], CAMERAS.a) })).sort((a, b) => b.hides - a.hides)[0].block
        issues.push({ level: 'error', message: `“${inFront.label}”挡住了${exitName(exit) ? `“${exitName(exit)}”` : shell.exit === 'door' ? '门' : '出口'}，玩家看不出该往哪走。请把它挪开。`, object: inFront.name })
      }
    }
  }

  const carried = scene.carried ?? []
  const items = Object.fromEntries([...carried, ...(scene.props ?? [])].map(prop => [prop.id, prop.name]))
  const byId = new Map(blocks.map(block => [block.name, block]))
  const held = new Set(carried.map(prop => prop.id))
  const beats = []

  for (const beat of scene.beats ?? []) {
    const block = byId.get(beat.object)
    if (!block) {
      issues.push({ level: 'error', message: `第 ${beats.length + 1} 步“${beat.objective}”要用的物件“${beat.object}”不在场景里。`, beat: beat.id })
      continue
    }
    const takes = idsOf(beat.takes)
    const gives = idsOf(beat.gives)
    for (const id of takes) {
      if (!held.has(id)) issues.push({ level: 'error', message: `“${beat.objective}”要用掉 ${items[id] ?? id}，但这时玩家还没拿到。`, beat: beat.id })
      held.delete(id)
    }
    for (const id of gives) {
      if (!items[id]) issues.push({ level: 'error', message: `“${beat.objective}”给的道具 ${id} 没有定义。`, beat: beat.id })
      held.add(id)
    }
    const target = { x: block.center[0], z: block.center[2], radius: Number((Math.max(block.size[0], block.size[2]) / 2 + 1.1).toFixed(2)) }
    const entry = { id: beat.id, objective: beat.objective, target, prompt: beat.prompt || '按 E 查看', tooEarly: beat.tooEarly || '还不到时候。', gives: gives.length ? gives : undefined, takes: takes.length ? takes : undefined, during: beat.during || undefined, after: beat.after || undefined, ...(beat.lines?.length && beat.face ? { speech: speechTiming(beat.lines, ACTION_BEFORE_FACE) } : {}), ...(beat.endsChapter ? { isEnding: true } : {}) }
    if (beat.performed) {
      const found = findMark(block, target, blocks, walkable, shell)
      if (!found) {
        // Said in numbers where there is one camera, since it is always the same thing that is wrong: no room in front.
        const hint = shell.CAMERAS.a.fixed
          ? `“${block.label}”朝镜头的一侧站不下人。它的前沿（z 加上一半的深度）不能超过 ${Number((shell.ROOM_WALK.maxZ - 0.7).toFixed(1))}，请往${shell.kind === 'outdoor' ? '远端' : '后墙'}方向挪，或者做小一点。`
          : `“${block.label}”周围没有能拍这段表演的站位（要背对镜头、不被挡、镜头放得下），请把它往房间里挪。`
        issues.push({ level: 'error', message: hint, object: block.name, beat: beat.id })
      } else {
        entry.clip = beat.id
        entry.camera = found.camera
        entry.anchor = found.mark
        // A shot framed on a mark can only start from that side of a thing. One fixed camera has no side to keep to,
        // so a thing can be used from anywhere around it.
        if (!shell.CAMERAS.a.fixed) entry.target = found.target
        if (!reachable(found.mark)) issues.push({ level: 'error', message: `走不到“${beat.objective}”的站位。`, object: block.name, beat: beat.id })
      }
    } else {
      const near = [[0, 1], [1, 0], [-1, 0], [0, -1]].some(([sx, sz]) =>
        reachable({ x: target.x + sx * (target.radius - 0.2), z: target.z + sz * (target.radius - 0.2) }))
      if (!near) issues.push({ level: 'error', message: `走不到“${block.label}”旁边。`, object: block.name, beat: beat.id })
    }
    beats.push(entry)
  }

  const exit = scene.exit ?? {}
  // A way out with nothing to open needs no step of its own: it is simply there once the story is done.
  if (shell.exit === 'door') {
    beats.push({
      id: 'door', objective: exit.objective || '推开那扇门',
      target: { x: shell.DOOR_ANCHOR.x, z: shell.DOOR_ANCHOR.z, radius: INTERACT_RADIUS },
      prompt: exit.prompt || '按 E 推门', tooEarly: exit.tooEarly || '还不到时候。',
      clip: 'door', camera: 'a', anchor: shell.DOOR_ANCHOR, opensDoor: true, during: exit.during || undefined,
    })
  }

  // The first beat picks up a prop lying out on its object, when it is low enough to be seen lying there.
  const first = (scene.beats ?? [])[0]
  const firstBlock = first && byId.get(first.object)
  const lowEnough = firstBlock && firstBlock.center[1] + firstBlock.size[1] / 2 < 1.3
  const firstGives = idsOf(first?.gives)
  // Where places are joined up the first step here may not be the first one played, so nothing lies out waiting for it.
  const stageProp = !scene.exits && firstGives.length === 1 && lowEnough ? {
    item: firstGives[0],
    position: [firstBlock.center[0] + 0.2, firstBlock.center[1] + firstBlock.size[1] / 2 + 0.004, firstBlock.center[2] + 0.12],
    turn: 0.3, size: 0.3,
  } : null

  // The film opens long-lens on the first thing the first camera can see.
  const openingBlock = (scene.beats ?? []).map(beat => byId.get(beat.object)).find(block => block && !block.paintedBy) ?? blocks.find(block => !block.paintedBy)
  const openingTarget = openingBlock
    ? [openingBlock.center[0], Math.min(openingBlock.center[1] + openingBlock.size[1] / 2, 1.5), openingBlock.center[2]]
    : [...shell.CAMERAS.a.target]

  // Whatever gives off light in the picture, so the game's own light and dust can agree with it.
  const glows = (scene.objects ?? []).flatMap(object => {
    const block = byId.get(object.id)
    return object.glow && block ? [{ position: [block.center[0], block.center[1] + block.size[1] * 0.2, block.center[2]], color: object.glow.color, radius: object.glow.radius }] : []
  })

  return {
    data: {
      stage: scene.stage ? shell.stage : undefined,
      ...(scene.paint === 'relaxed' ? { relaxed: true, glows } : {}),
      blocks: blocks.map(({ onTop, onLabel, look, label, archetype, ...block }) => block),
      spawn,
      story: {
        title: scene.title,
        opening: scene.openingLine || '',
        ending: scene.endingLine || '',
        lastObjective: exit.lastObjective || (shell.exit === 'door' ? '走进门后的走廊' : `走向${exit.name || '出口'}`),
        items,
        carried: carried.length ? carried.map(prop => prop.id) : undefined,
        stageProp,
        openingShot: { target: openingTarget, fov: 14 },
        beats,
        ...(scene.exits ? {
          sceneId: scene.id,
          exits: shell.EXITS.flatMap(way => {
            const exit = scene.exits.find(candidate => candidate.id === way.id)
            return exit ? [{ id: exit.id, to: exit.to, name: exit.name, prompt: exit.prompt || `按 E 走${exit.name}`, tooEarly: exit.locked || '这条路现在还走不通。', ...(exit.opensAfter ? { opensAfter: exit.opensAfter } : {}), target: { x: way.anchor.x, z: way.anchor.z, radius: INTERACT_RADIUS }, anchor: { x: way.anchor.x, z: way.anchor.z, yaw: 0 }, x: way.x, kind: way.kind }] : []
          }),
        } : { lastShot: { clip: 'ending', camera: 'a', anchor: shell.ENDING_MARK, isEnding: true, ...(scene.film?.ending?.lines?.length ? { speech: speechTiming(scene.film.ending.lines, ACTION_BEFORE_FACE) } : {}) } }),
      },
    },
    blocks,
    issues,
    shell,
    ok: !issues.some(issue => issue.level === 'error'),
  }
}

// Which of the side walls the first camera has in its picture, so what it is told to paint matches what it is shown.
export function wallsFirstCameraSees({ CAMERAS, room }) {
  // From a little way along: the far corner alone landing on the edge of the frame is not seeing the wall.
  const along = Array.from({ length: 9 }, (_, index) => room.north + 0.6 + (index / 8) * (room.south - room.north - 0.6))
  const sees = x => along.some(z => plateSees(CAMERAS.a, [x, 0.3, z]))
  return { west: sees(room.west), east: sees(room.east) }
}

const footprintAt = (x, z, size) => ({ center: [x, size[1] / 2, z], size })
const isFree = (x, z, size, taken, shell) => {
  const footprint = footprintAt(x, z, size)
  return fitsRoom(footprint, shell) && Boolean(cameraSeeing(footprint, shell)) && !taken.some(other => overlaps(footprint, other))
}

// Outward from where something was asked to stand, so it ends up as close to that as it can be.
function* spotsAround(x, z, shell) {
  yield { x, z }
  const furthest = Math.hypot(shell.room.east - shell.room.west, shell.room.south - shell.room.north) / 2
  for (let radius = 0.25; radius <= Math.max(5, furthest); radius += 0.25) {
    const steps = Math.max(8, Math.round(radius * 8))
    for (let turn = 0; turn < steps; turn++) {
      const angle = (turn / steps) * 2 * Math.PI
      yield { x: Number((x + radius * Math.cos(angle)).toFixed(2)), z: Number((z + radius * Math.sin(angle)).toFixed(2)) }
    }
  }
}

const hasPosition = object => Number.isFinite(object.x) && Number.isFinite(object.z)

// The nearest place to the one asked for where this fits, is seen by a camera, and stands on nothing else.
export function nearestFreeSpot(object, others, shell = TUNED_SHELL) {
  const { size } = shapeOf(object)
  const taken = [...shell.APPROACHES, ...others.filter(other => !shapeOf(other)?.onTop && hasPosition(other)).map(other => footprintAt(other.x, other.z, shapeOf(other).size))]
  for (const spot of spotsAround(object.x, object.z, shell)) if (isFree(spot.x, spot.z, size, taken, shell)) return spot
  return null
}

// Puts everything on the floor plan: where the model asked if it can, and failing that as near as it fits.
// An object that came with no position takes the first of the proven slots, moving on if something is there.
export function placeObjects(objects, performedIds = new Set(), shell = TUNED_SHELL) {
  const placed = []
  const standing = objects.filter(object => !shapeOf(object)?.onTop)
  // What has to be performed at goes first, since less of the room can frame a performance.
  const ordered = [...standing].sort((a, b) => Number(performedIds.has(b.id)) - Number(performedIds.has(a.id)))
  for (const object of ordered) {
    if (hasPosition(object)) {
      const spot = nearestFreeSpot(object, placed, shell)
      if (spot) placed.push({ ...object, ...spot })
      continue
    }
    const mustPerform = performedIds.has(object.id)
    const allowed = SLOT_ORDER.filter(id => !mustPerform || SLOTS[id].performs)
    const wanted = allowed.includes(object.slot) ? [object.slot, ...allowed] : allowed
    const { size } = shapeOf(object)
    const taken = [...shell.APPROACHES, ...placed.map(other => footprintAt(other.x, other.z, shapeOf(other).size))]
    const free = id => {
      const { x, z } = slotAt(id, size[2], shell)
      return isFree(x, z, size, taken, shell)
    }
    const slot = wanted.find(free)
    // No room left: the object is dropped, and a beat that needed it is reported.
    if (slot) placed.push({ ...object, slot, ...slotAt(slot, size[2], shell) })
  }
  // Small things share out the top of what they stand on, instead of all landing on one spot.
  const hosted = new Map()
  for (const object of objects) {
    if (!shapeOf(object)?.onTop) continue
    const surface = other => shapeOf(other).size[1] < 1.3 && shapeOf(other).size[0] >= 0.7
    const host = placed.find(other => other.id === object.on) ?? placed.find(surface)
    if (!host) continue
    const turn = hosted.get(host.id) ?? 0
    hosted.set(host.id, turn + 1)
    const [width] = shapeOf(host).size
    const spread = [-0.3, 0.3, 0][turn % 3] * width
    placed.push({ ...object, on: host.id, dx: Number(spread.toFixed(2)), dz: -0.05 })
  }
  return placed
}

const errorsIn = (scene, objects) => buildStage({ ...scene, objects }).issues.filter(issue => issue.level === 'error')
const TRIES_TO_SETTLE = 40

// A place can be free and still have nowhere to stand and film. Objects that have that problem are moved,
// nearest first, for as long as moving them helps. Whatever is left is for the model to hear about.
export function settleForFilming(scene, objects) {
  const shell = shellFor(scene)
  let current = objects
  let errors = errorsIn(scene, current)
  let tries = TRIES_TO_SETTLE
  const stuck = new Set()
  while (errors.length && tries > 0) {
    const issue = errors.find(({ object }) => object && !stuck.has(object) && !shapeOf(current.find(other => other.id === object))?.onTop)
    if (!issue) break
    const object = current.find(other => other.id === issue.object)
    const others = current.filter(other => other !== object)
    const taken = [...shell.APPROACHES, ...others.filter(other => !shapeOf(other)?.onTop).map(other => footprintAt(other.x, other.z, shapeOf(other).size))]
    let improved = false
    let looked = 0
    for (const spot of spotsAround(object.x, object.z, shell)) {
      if (tries <= 0) break
      // Walking the room out is slow, so only every so often around the ring, and never where it cannot stand.
      if (looked++ % 3 || !isFree(spot.x, spot.z, shapeOf(object).size, taken, shell)) continue
      tries--
      const moved = current.map(other => (other === object ? { ...other, ...spot } : other))
      const after = errorsIn(scene, moved)
      if (after.length < errors.length) {
        current = moved
        errors = after
        improved = true
        break
      }
    }
    if (!improved) stuck.add(object.id)
  }
  return current
}

const FRONT_ROW_SHARE = 0.6 // Of the way from the back of the room to the near edge.
const TALL = 1.4 // Metres. A thing this tall in the middle of the room hides what is behind it.

// Where things stand when nothing better was asked for, seen from close to: spread across the width so that none
// stands behind another, with what is tall along the back wall and the rest out in the room.
export function closeSpots(sizes, shell) {
  const { room } = shell
  const span = room.east - room.west
  const free = span - sizes.reduce((sum, [width]) => sum + width, 0)
  const gap = free / (sizes.length + 1)
  let x = room.west + gap
  return sizes.map(([width, height, depth]) => {
    const spot = {
      x: Number((x + width / 2).toFixed(2)),
      z: Number((height > TALL ? room.north + depth / 2 + 0.05 : room.north + (room.south - room.north) * FRONT_ROW_SHARE).toFixed(2)),
    }
    x += width + gap
    return spot
  })
}

const ALIKE_WITHIN = 0.9 // Metres.
const ALIKE_SHARE = 0.6

// The scene this set most repeats, if it repeats one. Two rooms are the same room when most of what stands in
// one stands in nearly the same spot in the other, whatever it is called.
export function repeatedLayout(objects, otherScenes) {
  const standing = list => list.filter(object => !shapeOf(object)?.onTop && hasPosition(object))
  const here = standing(objects)
  if (here.length < 2) return null
  for (const scene of otherScenes) {
    const there = standing(scene.objects ?? [])
    if (there.length < 2) continue
    const same = here.filter(object => there.some(other => Math.hypot(object.x - other.x, object.z - other.z) < ALIKE_WITHIN)).length
    if (same / Math.max(here.length, there.length) >= ALIKE_SHARE) return scene
  }
  return null
}
