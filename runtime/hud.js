// Shows what the player is really doing: the keys held, and where the view and the character are
// pointing. Everything on it is read from the game, so it doubles as proof the picture is live.
const DEGREES = 180 / Math.PI
const MOUSE_DECAY = 8 // Per second: how fast the mouse dot drifts back to the middle.
const MOUSE_RANGE = 26 // Pixels from the middle of the dial.
const PITCH_PIXELS = 0.9 // Per degree, for the horizon line.
const PITCH_RANGE = 34
const clamp = (value, limit) => Math.max(-limit, Math.min(limit, value))

// Degrees clockwise from the room's north (-z).
export const headingOf = ({ position, target }) =>
  (Math.atan2(target[0] - position[0], position[2] - target[2]) * DEGREES + 360) % 360

// Degrees below level.
export const pitchOf = ({ position, target }) =>
  Math.atan2(position[1] - target[1], Math.hypot(target[0] - position[0], target[2] - position[2])) * DEGREES

export const facingOf = yaw => (Math.atan2(Math.sin(yaw), -Math.cos(yaw)) * DEGREES + 360) % 360

export const pressedDirections = held => ({
  up: held.has('ArrowUp') || held.has('KeyW'),
  down: held.has('ArrowDown') || held.has('KeyS'),
  left: held.has('ArrowLeft') || held.has('KeyA'),
  right: held.has('ArrowRight') || held.has('KeyD'),
})

const KEYS = [['up', '↑', 'W'], ['left', '←', 'A'], ['down', '↓', 'S'], ['right', '→', 'D']]
const TICKS = Array.from({ length: 24 }, (_, i) => i * 15)
  .map(angle => `<line x1="0" y1="-47" x2="0" y2="${angle % 90 === 0 ? -40 : -44}" transform="rotate(${angle})"/>`).join('')
const NORTH_LABELS = [['北', 0], ['东', 90], ['南', 180], ['西', 270]]
  .map(([label, angle]) => `<text transform="rotate(${angle}) translate(0 -29)" class="${label === '北' ? 'north' : ''}">${label}</text>`).join('')

export function createHud(root) {
  root.innerHTML = `
    <div class="hud-keys">${KEYS.map(([id, arrow, letter]) => `<div class="hud-key" data-key="${id}"><b>${arrow}</b><small>${letter}</small></div>`).join('')}</div>
    <svg class="hud-gyro" viewBox="-52 -52 104 104" aria-hidden="true">
      <defs><clipPath id="hud-dial"><circle r="39"/></clipPath></defs>
      <circle class="hud-face" r="50"/>
      <g clip-path="url(#hud-dial)">
        <g class="hud-horizon"><rect class="hud-sky" x="-60" y="-120" width="120" height="120"/><rect class="hud-ground" x="-60" y="0" width="120" height="120"/><line x1="-60" x2="60" y1="0" y2="0"/></g>
      </g>
      <g class="hud-ring">${TICKS}${NORTH_LABELS}</g>
      <path class="hud-facing" d="M0 -22 L7 -6 L0 -10 L-7 -6 Z"/>
      <circle class="hud-mouse" r="4"/>
      <path class="hud-view" d="M0 -52 L5 -44 L-5 -44 Z"/>
    </svg>`
  const keys = Object.fromEntries([...root.querySelectorAll('.hud-key')].map(key => [key.dataset.key, key]))
  const ring = root.querySelector('.hud-ring')
  const horizon = root.querySelector('.hud-horizon')
  const facing = root.querySelector('.hud-facing')
  const mouseDot = root.querySelector('.hud-mouse')
  let mouseX = 0
  let mouseY = 0
  return {
    nudge(dx, dy) {
      mouseX = clamp(mouseX + dx * 0.5, MOUSE_RANGE)
      mouseY = clamp(mouseY + dy * 0.5, MOUSE_RANGE)
    },
    update({ visible, held, pose, playerYaw, dt }) {
      root.hidden = !visible
      if (!visible) return
      const pressed = pressedDirections(held)
      for (const [id, key] of Object.entries(keys)) key.classList.toggle('on', pressed[id])
      const heading = headingOf(pose)
      // The dial turns under a fixed marker, so "up" on it is always where the view is looking.
      ring.setAttribute('transform', `rotate(${(-heading).toFixed(2)})`)
      facing.setAttribute('transform', `rotate(${(facingOf(playerYaw) - heading).toFixed(2)})`)
      horizon.setAttribute('transform', `translate(0 ${clamp(-pitchOf(pose) * PITCH_PIXELS, PITCH_RANGE).toFixed(2)})`)
      const decay = Math.exp(-MOUSE_DECAY * dt)
      mouseX *= decay
      mouseY *= decay
      mouseDot.setAttribute('transform', `translate(${mouseX.toFixed(2)} ${mouseY.toFixed(2)})`)
    },
  }
}
