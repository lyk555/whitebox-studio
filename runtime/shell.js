// The space a scene happens in, worked out from a short description of it: how big, indoors or out, where the
// way out is and what kind it is. Everything that used to be one fixed room comes from here, and the renderer,
// the collision and the stage checks all read the same numbers. No description gives the room the first film
// was tuned on, to the centimetre, so nothing made before this existed changes.
//
// Units are metres. +x is east, -z is north, y is up. The north-west corner of the floor never moves.
export const WEST = -5
export const NORTH = -4

const TUNED = { width: 12, depth: 7.4 }
export const LIMITS = { width: [5, 18], depth: [4, 12], doorAt: [0.08, 0.5] }
export const DEFAULT_DOOR_AT = 1 / 6
// Any smaller and there is no room for a row along the back wall, a row out in the room and a way past each: a
// model given a shallower room went round in circles between one gap and the next.
export const CLOSE_LIMITS = { width: [10, 14], depthShare: [0.47, 0.49] }
const WALL_MARGIN = 1.1 // A door needs its frame, and the player needs room to come at it, between it and a wall.
const MIN_WALL_HEIGHT = 5
const LOWEST_CAMERA = 2.6
const LOW_CAMERA = 2.1
const LOW_CAMERA_SHARE = 0.72
const LOW_LOOK_HEIGHT = 1.15
const FIXED_WALL_MARGIN = 0.4 // With one camera a door can stand nearer the corner: nothing has to be filmed from beside it.
const NOWHERE = { minX: 1, maxX: 0, minZ: 1, maxZ: 0 }
export const EXIT_REACH = 1.4 // How close to a way out with nothing to open the story ends.
// A place on the map has one way out per place it joins, all along the far edge, which is the only edge the picture shows.
export const MOST_WAYS = 3
const WAY_LIMITS = [0.12, 0.88]
const WAY_GAP = 0.24 // Of the width. Less and the two stand in each other's way, on the wall and on the floor in front of it.

const clamp = (value, low, high) => Math.min(high, Math.max(low, value))

function normalizeWays(raw) {
  if (!Array.isArray(raw) || !raw.length) return null
  const list = raw.slice(0, MOST_WAYS)
  const even = index => Number(((index + 1) / (list.length + 1)).toFixed(3))
  const ways = list.map((way, index) => ({
    id: String(way.id ?? `x${index + 1}`),
    kind: way.kind === 'door' ? 'door' : 'opening',
    at: Number(clamp(Number.isFinite(Number(way.at)) && way.at !== null && way.at !== '' ? Number(way.at) : even(index), ...WAY_LIMITS).toFixed(3)),
  }))
  // Two written on top of each other are spread out evenly, keeping which is left of which.
  const order = [...ways].sort((one, other) => one.at - other.at)
  if (order.some((way, index) => index > 0 && way.at - order[index - 1].at < WAY_GAP)) order.forEach((way, index) => { way.at = even(index) })
  return ways
}

// How a new scene is seen: one fixed camera, close to, with the whole room in the picture.
export const closeStage = raw => normalizeStage({ ...raw, lens: 'fixed', framing: 'close' })

// A description as the model or a person wrote it, made into one that can be built. Null is the tuned room.
export function normalizeStage(raw) {
  if (!raw) return null
  const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback)
  // Seen from close to, how wide a room is sets how big a person looks in it, and how deep it can be before its near
  // edge is out of the picture.
  const close = raw.lens === 'fixed' && raw.framing === 'close'
  const width = Number(clamp(number(raw.width, TUNED.width), ...(close ? CLOSE_LIMITS.width : LIMITS.width)).toFixed(1))
  const depthLimits = close ? [width * CLOSE_LIMITS.depthShare[0], width * CLOSE_LIMITS.depthShare[1]] : LIMITS.depth
  // Ways out that lead to other places are never opened on screen: the picture stays as it was painted, and going through
  // one is a cut. So the room itself is built like one with nothing to open, however each way out is painted.
  const ways = normalizeWays(raw.ways)
  return {
    kind: raw.kind === 'outdoor' ? 'outdoor' : 'indoor',
    exit: ways || raw.exit === 'opening' ? 'opening' : 'door',
    width,
    depth: Number(clamp(number(raw.depth, close ? width : TUNED.depth), ...depthLimits).toFixed(1)),
    doorAt: ways ? ways[0].at : Number(clamp(number(raw.doorAt ?? raw.door_at, DEFAULT_DOOR_AT), ...LIMITS.doorAt).toFixed(3)),
    ...(raw.lens === 'low' || raw.lens === 'fixed' ? { lens: raw.lens } : {}),
    ...(raw.lens === 'fixed' && raw.framing === 'close' ? { framing: 'close' } : {}),
    ...(ways ? { ways } : {}),
  }
}

// How much of the view the tallest thing has to fill: the back wall has to reach past the top of the picture.
function wallReaching({ position, target, fov }, backZ) {
  const reach = Math.hypot(target[0] - position[0], target[2] - position[2])
  const pitch = Math.atan2(position[1] - target[1], reach)
  const topOfFrame = (fov * Math.PI) / 360 - pitch
  return position[1] + (position[2] - backZ) * Math.tan(topOfFrame)
}

const FRAME_MARGIN = 0.35 // Metres from the feet to the edge of the picture, so the whole of a person stays in it.

// Whether someone standing here is in the picture, side to side.
function framedFloor({ position, target, fov }) {
  const along = target.map((value, i) => value - position[i])
  const length = Math.hypot(...along)
  const forward = along.map(value => value / length)
  const sideways = Math.tan((fov * Math.PI) / 360) * (16 / 9)
  return (x, z) => {
    const away = (x - position[0]) * forward[0] - position[1] * forward[1] + (z - position[2]) * forward[2]
    return Math.abs(x - position[0]) <= away * sideways - FRAME_MARGIN
  }
}

export function shellFrom(description) {
  const stage = normalizeStage(description) ?? { kind: 'indoor', exit: 'door', width: TUNED.width, depth: TUNED.depth, doorAt: DEFAULT_DOOR_AT }
  const { width, depth, doorAt, kind, exit } = stage
  const east = Number((WEST + width).toFixed(3))
  const south = Number((NORTH + depth).toFixed(3))
  const scaleX = width / TUNED.width
  const scaleZ = depth / TUNED.depth
  const lift = Math.max(scaleX, scaleZ)
  // A wide shallow space still needs the camera far enough back to take in its width.
  const standBack = Math.max(scaleZ, 0.8 * scaleX, 0.7)

  const fixed = stage.lens === 'fixed'
  // The way out is filmed from the first camera, so it has to stay clear of the line where the second takes over.
  const wallMargin = fixed ? FIXED_WALL_MARGIN : WALL_MARGIN
  const lastDoorX = Math.min(east - wallMargin - 0.6, WEST + width * (5.9 / 12) - 0.3)
  const wayX = at => Number((WEST + width * at).toFixed(3))
  const doorX = stage.ways ? wayX(stage.ways[0].at) : Number(clamp(WEST + width * doorAt, Math.min(WEST + wallMargin + 0.6, lastDoorX), lastDoorX).toFixed(3))
  const DOOR = { x: doorX, z: NORTH, width: 1.2, height: 2.2 }
  const wayOut = (id, wayKind, x) => ({ id, kind: wayKind, x, z: NORTH, width: DOOR.width, height: DOOR.height, anchor: { x, z: NORTH + 0.9, yaw: Math.PI }, approach: { center: [x, 0, NORTH + 0.8], size: [1.7, 0, 1.6] } })
  // Every way out of here. A scene from before places were joined up has the one.
  const EXITS = stage.ways ? stage.ways.map(way => wayOut(way.id, way.kind, wayX(way.at))) : [wayOut('out', exit, doorX)]

  const backOfShot = NORTH + 3 * scaleZ
  // Nearer eye level: less floor in the picture, more of the room around it. Only a scene that asks for it.
  const low = stage.lens === 'low'
  const eye = height => (low ? Math.max(LOW_CAMERA, height * LOW_CAMERA_SHARE) : Math.max(LOWEST_CAMERA, height))
  const lookHeight = low ? LOW_LOOK_HEIGHT : 0.8
  // One camera that never moves: square on to the back wall, a little above eye level, with the whole room in the
  // picture. Sized from the room it was first seen working in, ten metres by 7.6.
  const fixedFit = Math.max(width / 10, depth / 7.6)
  const middle = Number(((WEST + east) / 2).toFixed(3))
  // Close: the back wall nearly fills the width of the picture and the bottom of the picture is the near edge of the
  // floor, so nothing is spent on empty floor, and people and things come out big. The room narrows towards the
  // camera, so what can be walked on narrows with it. See inFrame.
  const closeFit = width / 10
  const closeZ = NORTH + 9 * closeFit
  const fixedCamera = stage.framing === 'close'
    ? { position: [middle, 2.7 * closeFit, closeZ], target: [middle, 0.95, closeZ - 7.9 * closeFit], fov: 39, fixed: true }
    : { position: [middle, 3.3 * fixedFit, south + 5.9 * fixedFit], target: [middle, 0.95, NORTH + 2.5 * fixedFit], fov: 39, fixed: true }
  const CAMERAS = fixed ? { a: fixedCamera, b: { ...fixedCamera } } : {
    a: { position: [WEST + 3.5 * scaleX, eye(3.2 * lift), south + 4.1 * standBack], target: [WEST + 3.5 * scaleX, lookHeight, backOfShot], fov: 45 },
    b: { position: [WEST + 7 * scaleX, eye(3 * lift), south + 3.6 * standBack], target: [WEST + 9.5 * scaleX, lookHeight, backOfShot], fov: 45 },
  }
  const WALL_HEIGHT = Math.ceil(Math.max(MIN_WALL_HEIGHT, ...Object.values(CAMERAS).map(camera => wallReaching(camera, NORTH) + 0.3)))
  const room = { west: WEST, east, north: NORTH, south, top: WALL_HEIGHT }
  for (const camera of Object.values(CAMERAS)) {
    camera.room = room
    camera.followDistance = 7.5 * Math.max(1, lift)
    // A described stage is shot from a tripod. See followCamera.js. The tuned room keeps the camera it was made with.
    camera.tripod = Boolean(description)
  }

  const sideLength = Math.max(14.2, depth + 6.8, Math.max(...Object.values(CAMERAS).map(camera => camera.position[2])) - NORTH + 2)
  const sideCenter = NORTH - 0.1 + sideLength / 2
  const leftOfDoor = doorX - DOOR.width / 2
  const rightOfDoor = doorX + DOOR.width / 2
  const corridorX = doorX + 0.15
  const isDoor = exit === 'door'
  // A door opens onto a passage of its own. A way out with nothing to open is painted into the picture, on an
  // unbroken wall: a hole in a backdrop shows as a window hanging in the sky.
  const backOfRoom = isDoor ? [
    { name: 'wall-north-left', center: [(WEST + leftOfDoor) / 2, WALL_HEIGHT / 2, NORTH - 0.1], size: [leftOfDoor - WEST, WALL_HEIGHT, 0.2] },
    { name: 'wall-north-right', center: [(rightOfDoor + east) / 2, WALL_HEIGHT / 2, NORTH - 0.1], size: [east - rightOfDoor, WALL_HEIGHT, 0.2] },
    // Set back a hair and a little wider than the opening, so no crack shows where it meets the wall either side.
    { name: 'wall-north-lintel', center: [doorX, (WALL_HEIGHT + DOOR.height) / 2, NORTH - 0.095], size: [DOOR.width + 0.04, WALL_HEIGHT - DOOR.height, 0.18] },
    { name: 'corridor-west', center: [doorX - 0.8, WALL_HEIGHT / 2, NORTH - 1.3], size: [0.2, WALL_HEIGHT, 2.4] },
    { name: 'corridor-east', center: [doorX + 1.1, WALL_HEIGHT / 2, NORTH - 1.3], size: [0.2, WALL_HEIGHT, 2.4] },
    { name: 'corridor-end', center: [corridorX, WALL_HEIGHT / 2, NORTH - 2.5], size: [2.1, WALL_HEIGHT, 0.2] },
  ] : [
    { name: 'wall-north', center: [(WEST + east) / 2, WALL_HEIGHT / 2, NORTH - 0.1], size: [width, WALL_HEIGHT, 0.2] },
  ]
  const SHELLS = [
    { name: 'wall-west', center: [WEST - 0.1, WALL_HEIGHT / 2, sideCenter], size: [0.2, WALL_HEIGHT, sideLength] },
    { name: 'wall-east', center: [east + 0.1, WALL_HEIGHT / 2, sideCenter], size: [0.2, WALL_HEIGHT, sideLength] },
    ...backOfRoom,
  ]

  return {
    stage,
    kind,
    exit,
    inFrame: stage.framing === 'close' ? framedFloor(fixedCamera) : () => true,
    room,
    WALL_HEIGHT,
    DOOR,
    EXITS,
    SHELLS,
    CAMERAS,
    // A gap between the two thresholds stops the view flipping while someone stands on the line.
    CAMERA_SWITCH: fixed ? { toB: Infinity, toA: Infinity } : { toB: Number((WEST + width * (6.6 / 12)).toFixed(3)), toA: Number((WEST + width * (5.9 / 12)).toFixed(3)) },
    CORRIDOR_CAMERA: { position: [corridorX, 1.6, NORTH + 2.1], target: [corridorX, 1, NORTH - 2.4], fov: 60 },
    DOOR_ANCHOR: { x: doorX, z: NORTH + 0.9, yaw: Math.PI },
    ENDING_MARK: isDoor ? { x: corridorX, z: NORTH - 1.5, yaw: Math.PI } : { x: doorX, z: NORTH + 0.9, yaw: Math.PI },
    EXIT_Z: NORTH - 1.4,
    ROOM_WALK: { minX: WEST + 0.3, maxX: Number((east - 0.3).toFixed(3)), minZ: NORTH + 0.3, maxZ: Number((south - 0.6).toFixed(3)) },
    DOORWAY: isDoor ? { minX: doorX - 0.35, maxX: doorX + 0.35, minZ: NORTH - 0.4, maxZ: NORTH + 0.4 } : NOWHERE,
    CORRIDOR: isDoor ? { minX: doorX - 0.35, maxX: doorX + 0.85, minZ: NORTH - 2.2, maxZ: NORTH - 0.3 } : NOWHERE,
    // Nothing is ever placed where the player has to stand to reach the way out.
    DOOR_APPROACH: EXITS[0].approach,
    APPROACHES: EXITS.map(way => way.approach),
    SPAWN_WANTED: { x: Number((WEST + width * (5.6 / 12)).toFixed(3)), z: Number((NORTH + depth * (5.9 / 7.4)).toFixed(3)) },
    // In a big space the plate covers more ground per pixel, so the view stays further back to keep it sharp.
    followDistance: 7.5 * Math.max(1, lift),
    // Where something stands, as a share of the tuned room, in this one.
    scaleX,
    scaleZ,
  }
}

export const PLAYER_RADIUS = 0.25

const inside = (rect, x, z) => x >= rect.minX && x <= rect.maxX && z >= rect.minZ && z <= rect.maxZ

const hitsBlock = (blocks, x, z) => blocks.some(({ center, size }) =>
  Math.abs(x - center[0]) < size[0] / 2 + PLAYER_RADIUS && Math.abs(z - center[2]) < size[2] / 2 + PLAYER_RADIUS)

// The walk rule for any set of blocks in any shell, so a scene can be checked before it is ever on the stage.
export function walkableIn(shell, blocks) {
  return (x, z, doorOpen) => {
    if (inside(shell.ROOM_WALK, x, z) && !hitsBlock(blocks, x, z) && (shell.inFrame?.(x, z) ?? true)) return true
    return doorOpen && (inside(shell.DOORWAY, x, z) || inside(shell.CORRIDOR, x, z))
  }
}
