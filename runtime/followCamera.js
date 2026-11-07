// A camera that follows the player but never shows anything the plates do not contain.
// No rendering in here, so the limits can be checked without a browser.
import { BLOCKS, CAMERAS } from './world.js'

const ASPECT = 16 / 9
const FOLLOW_DISTANCE = 7.5 // Metres. Much closer and the character outgrows its source video.
const FOLLOW_FOV = 36
const LOOK_HEIGHT = 1
const GLIDE_RATE = 4 // How quickly the view catches up, per second.
const REST_RATE = 5
const SWITCH_SECONDS = 1 // How long the view takes to move between the two plates.
const CAMERA_CLEARANCE = 0.4
const COARSE_STEPS = 12
const REFINE_STEPS = 6
const LOOK_SEARCH_STEPS = 8
const MIN_TRIPOD_FOV = 16 // Narrower only enlarges a smaller and smaller piece of the picture.
const MAX_LOOK_YAW = 0.6 // Radians. Two plates cannot hold up from further round the side than this.
const MIN_ELEVATION = 0.12 // Radians above the player. Lower and the camera nears the furniture.
const MAX_ELEVATION = 0.95

const lerp = (a, b, t) => a + (b - a) * t
const mix3 = (a, b, t) => a.map((value, i) => lerp(value, b[i], t))
const distance3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const normalize = a => {
  const length = Math.hypot(...a)
  return a.map(value => value / length)
}

export const mixPose = (a, b, t) => ({
  position: mix3(a.position, b.position, t),
  target: mix3(a.target, b.target, t),
  fov: lerp(a.fov, b.fov, t),
})

export const restPose = spec => ({ position: [...spec.position], target: [...spec.target], fov: spec.fov })

function frameAxes({ position, target, fov }) {
  const forward = normalize(target.map((value, i) => value - position[i]))
  const right = normalize(cross(forward, [0, 1, 0]))
  const up = cross(right, forward)
  return { forward, right, up, tanY: Math.tan((fov * Math.PI) / 360) }
}

// Where a ray from the camera meets the floor or a wall. Null if it escapes over the walls.
// The room comes with the camera, so a stage can be checked for a scene other than the one that is loaded.
function hitRoom(origin, direction, room) {
  let nearest = Infinity
  if (direction[1] < 0) nearest = Math.min(nearest, -origin[1] / direction[1])
  if (direction[0] < 0) nearest = Math.min(nearest, (room.west - origin[0]) / direction[0])
  if (direction[0] > 0) nearest = Math.min(nearest, (room.east - origin[0]) / direction[0])
  if (direction[2] < 0) nearest = Math.min(nearest, (room.north - origin[2]) / direction[2])
  if (!Number.isFinite(nearest)) return null
  const point = origin.map((value, i) => value + direction[i] * nearest)
  return point[1] > room.top ? null : point
}

function seenBy(axes, position, point) {
  const offset = point.map((value, i) => value - position[i])
  const depth = dot(offset, axes.forward)
  if (depth <= 0) return false
  const scale = depth * axes.tanY
  const TOLERANCE = 1.001
  return Math.abs(dot(offset, axes.up)) <= scale * TOLERANCE
    && Math.abs(dot(offset, axes.right)) <= scale * ASPECT * TOLERANCE
}

export const plateSees = (spec, point) => seenBy(frameAxes(spec), spec.position, point)

const BORDER = [-1, -0.5, 0, 0.5, 1]
const FRAME_POINTS = BORDER.flatMap(s => [[s, 1], [s, -1], [1, s], [-1, s]])

// True when everything along the edge of this frame was also seen by the plate's camera.
export function staysOnPlate(pose, spec) {
  const plate = frameAxes(spec)
  const frame = frameAxes(pose)
  return FRAME_POINTS.every(([sx, sy]) => {
    const direction = frame.forward.map((value, i) =>
      value + frame.right[i] * sx * frame.tanY * ASPECT + frame.up[i] * sy * frame.tanY)
    const point = hitRoom(pose.position, direction, spec.room)
    return point !== null && seenBy(plate, spec.position, point)
  })
}

export function cameraIsClear([x, y, z], blocks = BLOCKS) {
  return !blocks.some(({ center, size }) =>
    Math.abs(x - center[0]) < size[0] / 2 + CAMERA_CLEARANCE
    && Math.abs(y - center[1]) < size[1] / 2 + CAMERA_CLEARANCE
    && Math.abs(z - center[2]) < size[2] / 2 + CAMERA_CLEARANCE)
}

// From a tripod: the camera stays exactly where the picture was painted from, and only turns and zooms. Moving it
// shows what stood behind things, which no picture has, and that is where the blur and the smears come from. Turned
// and zoomed, the view is the painted picture itself, at full quality, whatever the player does. The frame is
// the one standing this far away would give.
function tripodPose(spec, look, distance) {
  const away = distance3(spec.position, look)
  const zoom = Math.min(1, distance / away)
  const fov = (2 * Math.atan(Math.tan((FOLLOW_FOV * Math.PI) / 360) * zoom) * 180) / Math.PI
  return { position: [...spec.position], target: look, fov: Math.max(MIN_TRIPOD_FOV, fov) }
}

// The camera moves along the line from the plate's camera to the player. Whatever hid the player
// from there is all that can hide them from here, and the plate has seen along that line.
function closePose(spec, look) {
  const distance = spec.followDistance ?? FOLLOW_DISTANCE
  if (spec.tripod) return tripodPose(spec, look, distance)
  const travel = Math.max(0, 1 - distance / distance3(spec.position, look))
  return { position: mix3(spec.position, look, travel), target: look, fov: FOLLOW_FOV }
}

// A close framing of someone standing on a mark, on the same line from the plate's camera, so it
// shows only what the plate saw. Performances start here, close enough to read what the hands do.
export function shotPose(spec, mark, distance) {
  if (spec.fixed) return restPose(spec)
  const look = [mark.x, LOOK_HEIGHT, mark.z]
  if (spec.tripod) return tripodPose(spec, look, distance)
  const travel = Math.max(0, 1 - distance / distance3(spec.position, look))
  return { position: mix3(spec.position, look, travel), target: look, fov: FOLLOW_FOV }
}

// Starts from a narrower frame at the plate's own view, which has room on every side, and goes
// toward the player until the frame reaches the plate's edge. That edge moves smoothly as the
// player does, so the camera does too.
export function solvePose(spec, player) {
  if (spec.fixed) return { ...restPose(spec), reach: 0 }
  const start = { ...restPose(spec), fov: FOLLOW_FOV }
  const close = closePose(spec, [player.x, LOOK_HEIGHT, player.z])
  const allowed = t => {
    const pose = mixPose(start, close, t)
    return cameraIsClear(pose.position) && staysOnPlate(pose, spec)
  }
  let reach = 0
  let beyond = 1 + 1 / COARSE_STEPS
  for (let step = 1; step <= COARSE_STEPS; step++) {
    if (!allowed(step / COARSE_STEPS)) {
      beyond = step / COARSE_STEPS
      break
    }
    reach = step / COARSE_STEPS
  }
  if (reach < 1) {
    for (let i = 0; i < REFINE_STEPS; i++) {
      const middle = (reach + beyond) / 2
      if (allowed(middle)) reach = middle
      else beyond = middle
    }
  }
  return { ...mixPose(start, close, reach), reach }
}

// Swings the view around the player. Mouse right turns the view right, mouse down looks further down.
export function orbitPose(pose, pivot, yaw, pitch) {
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  const turn = ([x, y, z]) => {
    const dx = x - pivot[0]
    const dz = z - pivot[2]
    return [pivot[0] + dx * cos - dz * sin, y, pivot[2] + dx * sin + dz * cos]
  }
  const moved = turn(pose.position)
  const offset = moved.map((value, i) => value - pivot[i])
  const flat = Math.hypot(offset[0], offset[2])
  const radius = Math.hypot(...offset)
  const elevation = Math.max(MIN_ELEVATION, Math.min(MAX_ELEVATION, Math.atan2(offset[1], flat) + pitch))
  const across = (Math.cos(elevation) * radius) / flat
  return {
    position: [pivot[0] + offset[0] * across, pivot[1] + Math.sin(elevation) * radius, pivot[2] + offset[2] * across],
    target: turn(pose.target),
    fov: pose.fov,
  }
}

// The mouse on a tripod: the view turns where it stands.
export function panPose(pose, pivot, yaw, pitch) {
  const [dx, dy, dz] = pose.target.map((value, i) => value - pose.position[i])
  const across = Math.hypot(dx, dz)
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  return {
    position: pose.position,
    target: [pose.position[0] + dx * cos - dz * sin, pose.position[1] + dy - pitch * across, pose.position[2] + dx * sin + dz * cos],
    fov: pose.fov,
  }
}

// How much of a move can be made before the frame leaves every plate. 0 is always assumed safe.
function reachable(allowed) {
  if (allowed(1)) return 1
  let reach = 0
  let beyond = 1
  for (let i = 0; i < LOOK_SEARCH_STEPS; i++) {
    const middle = (reach + beyond) / 2
    if (allowed(middle)) reach = middle
    else beyond = middle
  }
  return reach
}

// The mouse may use anything either plate saw. Movement may not, so walking keeps to one plate's look.
export function staysOnAnyPlate(pose, specs) {
  const plates = specs.map(spec => [frameAxes(spec), spec.position])
  const frame = frameAxes(pose)
  return FRAME_POINTS.every(([sx, sy]) => {
    const direction = frame.forward.map((value, i) =>
      value + frame.right[i] * sx * frame.tanY * ASPECT + frame.up[i] * sy * frame.tanY)
    const point = hitRoom(pose.position, direction, specs[0].room)
    return point !== null && plates.some(([axes, position]) => seenBy(axes, position, point))
  })
}

const smooth = t => t * t * (3 - 2 * t)

export function createFollowCamera(cameras = CAMERAS) {
  const specs = Object.values(cameras)
  const lookAround = cameras.a.tripod ? panPose : orbitPose
  let base = restPose(cameras.a) // Where following alone would put the view.
  let pose = base
  let pivot = [...cameras.a.target]
  let toB = 0 // 0 shows plate A, 1 shows plate B.
  let yaw = 0
  let pitch = 0
  return {
    get pose() { return pose },
    get plateMix() { return smooth(toB) },
    get look() { return { yaw, pitch } },
    turn(deltaYaw, deltaPitch) {
      if (cameras.a.fixed) return // The picture fills the frame exactly, so there is nothing to turn towards.
      yaw = Math.max(-MAX_LOOK_YAW, Math.min(MAX_LOOK_YAW, yaw + deltaYaw))
      pitch += deltaPitch
    },
    // With a held pose, the view settles there, which is the framing a performance starts from.
    update(player, activeId, dt, held = null) {
      if (cameras.a.fixed) return
      const step = dt / SWITCH_SECONDS
      toB = activeId === 'b' ? Math.min(1, toB + step) : Math.max(0, toB - step)
      const wanted = held ?? (toB === 0 ? solvePose(cameras.a, player)
        : toB === 1 ? solvePose(cameras.b, player)
        : mixPose(solvePose(cameras.a, player), solvePose(cameras.b, player), smooth(toB)))
      const glide = 1 - Math.exp(-(held ? REST_RATE : GLIDE_RATE) * dt)
      base = mixPose(base, wanted, glide)
      pivot = mix3(pivot, held ? held.target : [player.x, LOOK_HEIGHT, player.z], glide)
      if (held) {
        yaw = 0
        pitch = 0
      } else {
        // What the plates refuse is dropped, not stored, so turning back answers at once.
        const allowed = candidate => cameraIsClear(candidate.position) && staysOnAnyPlate(candidate, specs)
        const height = base.position[1] - pivot[1]
        const elevation = Math.atan2(height, Math.hypot(base.position[0] - pivot[0], base.position[2] - pivot[2]))
        pitch = Math.max(MIN_ELEVATION - elevation, Math.min(MAX_ELEVATION - elevation, pitch))
        yaw *= reachable(f => allowed(lookAround(base, pivot, yaw * f, 0)))
        pitch *= reachable(f => allowed(lookAround(base, pivot, yaw, pitch * f)))
      }
      // The mouse skips the glide: a view that lags behind the hand feels broken.
      pose = lookAround(base, pivot, yaw, pitch)
    },
    isAt(wanted, id) {
      return toB === (id === 'b' ? 1 : 0)
        && distance3(pose.position, wanted.position) < 0.003
        && distance3(pose.target, wanted.target) < 0.003
        && Math.abs(pose.fov - wanted.fov) < 0.003
    },
    snapTo(wanted, id) {
      base = { position: [...wanted.position], target: [...wanted.target], fov: wanted.fov }
      pose = base
      pivot = [...wanted.target]
      toB = id === 'b' ? 1 : 0
      yaw = 0
      pitch = 0
    },
  }
}
