// What makes a still picture feel like a place you are standing in: dust in the air, a lamp that is not quite
// steady, a figure that darkens as it leaves the light. None of it costs a model call, and none of it is in a
// frame a video starts from, so the cut into a video stays clean.
import * as THREE from 'three'

const DUST_COUNT = 140
const DUST_RISE = 0.03 // Metres per second.
const DUST_DRIFT = 0.05
const DUST_TOP = 3.4
const GLOW_OPACITY = 0.16 // A haze around the lamp. Any stronger and it washes out whoever stands behind it.

const clamp = (value, low, high) => Math.min(high, Math.max(low, value))

// Slow breathing with a small quick shiver on top. Never goes out, and never below the picture's own brightness by much.
export function flicker(seconds, seed = 0) {
  const slow = Math.sin(seconds * 1.7 + seed) * 0.5 + Math.sin(seconds * 2.9 + seed * 2) * 0.3
  const quick = Math.sin(seconds * 11.3 + seed * 3) * Math.sin(seconds * 7.1) * 0.2
  return clamp(1 + (slow + quick) * 0.16, 0.7, 1.3)
}

// How much light a figure standing here takes from the picture around it. A drawn figure already has its own
// light, so this is a tint: a dim room dims it a lot, and only part of the colour carries over.
export function figureTint([red, green, blue]) {
  const brightness = (0.299 * red + 0.587 * green + 0.114 * blue) / 255
  const level = clamp(0.36 + brightness * 1.5, 0.36, 1)
  const strongest = Math.max(red, green, blue, 1)
  return [red, green, blue].map(channel => level * (0.55 + 0.45 * (channel / strongest)))
}

// Where a light has to stand for the figure's shadow to fall away from the nearest lamp, and how dark that
// shadow is. Close to the lamp it is short and dark; far from it, nearly gone.
export function shadowFrom(glows, x, z) {
  let nearest = null
  let nearestAway = Infinity
  for (const glow of glows) {
    const away = Math.hypot(x - glow.position[0], z - glow.position[2])
    if (away < nearestAway) {
      nearest = glow
      nearestAway = away
    }
  }
  if (!nearest) return null
  const across = nearestAway > 0.001 ? [(nearest.position[0] - x) / nearestAway, (nearest.position[2] - z) / nearestAway] : [0, 1]
  return { offset: [across[0] * 4, 6, across[1] * 4], opacity: clamp(0.42 - nearestAway * 0.04, 0.12, 0.42) }
}

function softDot() {
  const paint = document.createElement('canvas')
  paint.width = 64
  paint.height = 64
  const ctx = paint.getContext('2d')
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.45, 'rgba(255,255,255,.28)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(paint)
}

export function createAtmosphere({ scene, room, glows }) {
  const dot = softDot()
  const lengths = { x: room.east - room.west, z: room.south - room.north }
  const positions = new Float32Array(DUST_COUNT * 3)
  const drift = new Float32Array(DUST_COUNT)
  for (let i = 0; i < DUST_COUNT; i++) {
    positions.set([room.west + Math.random() * lengths.x, Math.random() * DUST_TOP, room.north + Math.random() * lengths.z], i * 3)
    drift[i] = Math.random() * Math.PI * 2
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const warmest = glows[0]?.color ?? '#d8d4c8'
  const dust = new THREE.Points(geometry, new THREE.PointsMaterial({ map: dot, color: warmest, size: 0.045, sizeAttenuation: true, transparent: true, opacity: 0.5, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending }))
  dust.frustumCulled = false
  dust.renderOrder = 6
  dust.visible = false
  scene.add(dust)

  const lights = glows.map((glow, index) => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: dot, color: glow.color, transparent: true, opacity: GLOW_OPACITY, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending }))
    sprite.position.set(...glow.position)
    sprite.scale.setScalar(glow.radius * 2)
    sprite.renderOrder = 6
    sprite.visible = false
    scene.add(sprite)
    return { sprite, seed: index * 1.3 }
  })

  let clock = 0
  return {
    update(dt) {
      clock += dt
      for (let i = 0; i < DUST_COUNT; i++) {
        const at = i * 3
        positions[at] += Math.sin(clock * 0.3 + drift[i]) * DUST_DRIFT * dt
        positions[at + 1] += DUST_RISE * dt
        positions[at + 2] += Math.cos(clock * 0.23 + drift[i]) * DUST_DRIFT * dt
        if (positions[at + 1] > DUST_TOP) positions[at + 1] = 0
      }
      geometry.attributes.position.needsUpdate = true
      for (const { sprite, seed } of lights) sprite.material.opacity = GLOW_OPACITY * flicker(clock, seed)
    },
    // A frame a video starts from has no dust in it, and its lamp is steady, so it is the same picture every time.
    show({ live, plate }) {
      dust.visible = plate && live
      for (const { sprite } of lights) {
        sprite.visible = plate
        if (!live) sprite.material.opacity = GLOW_OPACITY
      }
    },
  }
}

// Laid over the picture and any video alike, and never part of a saved frame.
export function createFilmLook(stage) {
  const size = 160
  const paint = document.createElement('canvas')
  paint.width = size
  paint.height = size
  const ctx = paint.getContext('2d')
  const noise = ctx.createImageData(size, size)
  for (let i = 0; i < noise.data.length; i += 4) {
    const value = 90 + Math.random() * 76
    noise.data.set([value, value, value, 255], i)
  }
  ctx.putImageData(noise, 0, 0)
  const layer = (css) => {
    const el = document.createElement('div')
    el.style.cssText = `position:absolute;inset:0;pointer-events:none;z-index:1;${css}`
    stage.append(el)
    return el
  }
  layer('background:radial-gradient(ellipse at 50% 46%,rgba(0,0,0,0) 52%,rgba(0,0,0,.42) 100%)')
  const grain = layer(`background-image:url(${paint.toDataURL()});opacity:.09;mix-blend-mode:overlay`)
  setInterval(() => { grain.style.backgroundPosition = `${Math.floor(Math.random() * size)}px ${Math.floor(Math.random() * size)}px` }, 70)
}
