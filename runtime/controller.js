// Movement rules with no rendering in them, so they can be tested without a browser.
import { isWalkable } from './world.js'

export const MAX_SPEED = 1.4 // The generated walk's own pace: a 0.73 m step, two steps in 1.04 s.
const ACCELERATION = 14
const BRAKING = 18
const TURN_RATE = 11
const SWING = 0.55 // Radians of hip swing at full speed.
export const LEG_LENGTH = 0.92

const angleDelta = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from))

export function createPlayer({ x, z, yaw }) {
  return { x, z, yaw, vx: 0, vz: 0, phase: 0, gait: 0 }
}

// How far the body travels during one footfall when the legs swing this much. Advancing
// the walk cycle by this distance is what keeps the planted foot from sliding.
export function stepLength(gait) {
  return Math.max(0.2, 2 * LEG_LENGTH * Math.sin(SWING * gait))
}

export const swingAngle = (gait, phase) => SWING * gait * Math.sin(phase)

export function stepPlayer(player, direction, dt, doorOpen, walkable = isWalkable) {
  const length = Math.hypot(direction.x, direction.z)
  const wantX = length ? (direction.x / length) * MAX_SPEED : 0
  const wantZ = length ? (direction.z / length) * MAX_SPEED : 0
  const rate = (length ? ACCELERATION : BRAKING) * dt
  const dvx = wantX - player.vx
  const dvz = wantZ - player.vz
  const change = Math.hypot(dvx, dvz)
  const fraction = change > rate ? rate / change : 1
  player.vx += dvx * fraction
  player.vz += dvz * fraction

  // Each axis moves on its own, which is what lets the player slide along a wall.
  const nextX = player.x + player.vx * dt
  if (walkable(nextX, player.z, doorOpen)) player.x = nextX
  else player.vx = 0
  const nextZ = player.z + player.vz * dt
  if (walkable(player.x, nextZ, doorOpen)) player.z = nextZ
  else player.vz = 0

  const speed = Math.hypot(player.vx, player.vz)
  player.gait = Math.min(1, speed / MAX_SPEED)
  if (speed > 0.02) {
    const heading = Math.atan2(player.vx, player.vz)
    player.yaw += angleDelta(player.yaw, heading) * Math.min(1, TURN_RATE * dt)
    player.phase += (Math.PI * speed * dt) / stepLength(player.gait)
  }
}

export function turnToward(player, yaw, dt) {
  player.yaw += angleDelta(player.yaw, yaw) * Math.min(1, TURN_RATE * dt)
  return Math.abs(angleDelta(player.yaw, yaw)) < 0.01
}

// Walks to a mark and turns to face its way. True once the player is standing exactly there.
export function stepToward(player, mark, dt, doorOpen, walkable = isWalkable) {
  const dx = mark.x - player.x
  const dz = mark.z - player.z
  const distance = Math.hypot(dx, dz)
  if (distance > 0.2) {
    stepPlayer(player, { x: dx, z: dz }, dt, doorOpen, walkable)
    return false
  }
  // Close in by easing rather than steering, which would overshoot and hunt around the mark.
  stepPlayer(player, { x: 0, z: 0 }, dt, doorOpen, walkable)
  const ease = Math.min(1, 12 * dt)
  player.x += dx * ease
  player.z += dz * ease
  const faced = turnToward(player, mark.yaw, dt)
  return faced && player.gait === 0 && distance < 0.01
}

const ROUTE_CELL = 0.1 // Metres.

const clearBetween = (a, b, walkable) => {
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (ROUTE_CELL / 2))
  for (let step = 1; step <= steps; step++) {
    if (!walkable(a.x + ((b.x - a.x) * step) / steps, a.z + ((b.z - a.z) * step) / steps)) return false
  }
  return true
}

// How to get somewhere round what stands in the way: a few straight legs, ending exactly there. Null if there is no
// way, in which case the caller goes straight at it.
export function findRoute(from, to, walkable) {
  if (clearBetween(from, to, walkable)) return [{ x: to.x, z: to.z }]
  const key = (i, j) => `${i},${j}`
  const pointAt = (i, j) => ({ x: from.x + i * ROUTE_CELL, z: from.z + j * ROUTE_CELL })
  const cameFrom = new Map([[key(0, 0), null]])
  const queue = [[0, 0]]
  for (let head = 0; head < queue.length; head++) {
    const [i, j] = queue[head]
    const here = pointAt(i, j)
    if (Math.hypot(here.x - to.x, here.z - to.z) <= ROUTE_CELL * 1.5 && clearBetween(here, to, walkable)) {
      const cells = [{ x: to.x, z: to.z }]
      for (let at = key(i, j); at; at = cameFrom.get(at)) {
        const [a, b] = at.split(',').map(Number)
        cells.unshift(pointAt(a, b))
      }
      // Pulled tight: from each point, straight on to the furthest that can be seen from it.
      const legs = []
      let last = 0
      while (last < cells.length - 1) {
        let next = cells.length - 1
        while (next > last + 1 && !clearBetween(cells[last], cells[next], walkable)) next--
        legs.push(cells[next])
        last = next
      }
      return legs
    }
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = key(i + di, j + dj)
      if (cameFrom.has(next)) continue
      const point = pointAt(i + di, j + dj)
      if (!walkable(point.x, point.z)) continue
      cameFrom.set(next, key(i, j))
      queue.push([i + di, j + dj])
    }
  }
  return null
}

// The ground-plane axes a camera defines: what "up" and "right" on screen mean in the room.
export function cameraBasis({ position, target }) {
  const fx = target[0] - position[0]
  const fz = target[2] - position[2]
  const length = Math.hypot(fx, fz)
  return { forwardX: fx / length, forwardZ: fz / length, rightX: -fz / length, rightZ: fx / length }
}

const SPRITE_SECTORS = ['n', 'ne', 'e', 'se', 's']
const SECTOR_HOLD = 0.2 // Of a sector, which is 45 degrees.

// Which drawn direction shows a character facing this way through this camera. Only the right
// side is drawn; facing left is the same picture mirrored.
export function spriteDirection(yaw, basis, previous = null) {
  const headingX = Math.sin(yaw)
  const headingZ = Math.cos(yaw)
  const away = headingX * basis.forwardX + headingZ * basis.forwardZ
  const right = headingX * basis.rightX + headingZ * basis.rightZ
  const position = Math.atan2(Math.abs(right), away) / (Math.PI / 4)
  const shown = previous ? SPRITE_SECTORS.indexOf(previous.id) : -1
  // Near the line between two directions, it keeps the one it has, or it would flicker between them.
  const sector = shown >= 0 && Math.abs(position - shown) < 0.5 + SECTOR_HOLD ? shown : Math.round(position)
  const id = SPRITE_SECTORS[sector]
  return { id, mirror: right < -1e-9 && id !== 'n' && id !== 's' }
}

const KEY_AXES = {
  ArrowUp: [0, 1], KeyW: [0, 1],
  ArrowDown: [0, -1], KeyS: [0, -1],
  ArrowLeft: [-1, 0], KeyA: [-1, 0],
  ArrowRight: [1, 0], KeyD: [1, 0],
}

export const isMoveKey = code => code in KEY_AXES

// Keys are read against the camera that was live when they were pressed. After a cut the
// held key keeps walking the same way through the room; a new key picks up the new camera.
export function createDirectionHold() {
  let signature = ''
  let basis = null
  return {
    // The player turned the view on purpose, so held keys should follow it.
    rebase() {
      basis = null
    },
    resolve(heldKeys, currentBasis) {
      const codes = [...heldKeys].filter(isMoveKey).sort()
      const next = codes.join()
      if (next !== signature || !basis) {
        signature = next
        basis = currentBasis
      }
      let right = 0
      let forward = 0
      for (const code of codes) {
        right += KEY_AXES[code][0]
        forward += KEY_AXES[code][1]
      }
      return {
        x: basis.rightX * right + basis.forwardX * forward,
        z: basis.rightZ * right + basis.forwardZ * forward,
      }
    },
  }
}
