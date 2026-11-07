// The engine owns where everything is. Generated pictures only decide how it looks.
import * as THREE from 'three'
import { cameraBasis, createDirectionHold, createPlayer, findRoute, isMoveKey, LEG_LENGTH, spriteDirection, stepLength, stepPlayer, stepToward, swingAngle } from './controller.js'
import { createAtmosphere, createFilmLook, figureTint, shadowFrom } from './atmosphere.js'
import { fillSmallHoles } from './draftHoles.js'
import { createFollowCamera, shotPose, solvePose } from './followCamera.js'
import { boundsFromPaint, footprintOf, isColourMap, labelThings, nearestWalkable, reachableFrom } from './paintedThings.js'
import { fitToWhitebox, silhouetteOverlap } from './plateFit.js'
import { createHud } from './hud.js'
import { createSound, createStepCounter } from './sound.js'
import { BEATS, createStory, EXITS, ITEMS, JOURNEY, LAST_OBJECTIVE, LAST_SHOT, OPENING, OPENING_SHOT, rehearsalProgress, SCENE_ID, SHOT_DISTANCE, STAGE_PROP, TITLE } from './story.js'
import { BLOCKS, CAMERA_SWITCH, CAMERAS, DOOR, DOOR_ANCHOR, EXIT_KIND, EXIT_REACH, EXIT_Z, CORRIDOR_CAMERA, GLOWS, isWalkable, paintedBy, RELAXED, ROOM, ROOM_KIND, SHELLS, SPAWN, WAYS_OUT } from './world.js'

const WIDTH = 1280
const HEIGHT = 720
const CROSSFADE_MS = 300
const ENDING_FADE_MS = 1500
const MOUSE_RADIANS_PER_PIXEL = 0.0025
const DOOR_OPEN_ANGLE = EXIT_KIND === 'door' ? 1.75 : 0
const NEAR = 0.1
const FAR = Math.max(60, CAMERAS.a.position[2] - ROOM.north + 12)

const canvas = document.getElementById('view')
const stage = document.getElementById('stage')
const storyEl = document.getElementById('story')
const objectiveEl = document.getElementById('objective')
const itemsEl = document.getElementById('items')
const startEl = document.getElementById('start')
const hud = createHud(document.getElementById('hud'))
const sound = createSound()
const footfalls = createStepCounter()
const promptEl = document.getElementById('prompt')
const logEl = document.getElementById('log')

function log(message) {
  logEl.textContent += `${new Date().toLocaleTimeString()}  ${message}\n`
  logEl.scrollTop = logEl.scrollHeight
}

// ---------------------------------------------------------------- scene
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(1)
renderer.setSize(WIDTH, HEIGHT, false)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap

const scene = new THREE.Scene()
const clayBackground = new THREE.Color(0x101114)

const cameras = Object.fromEntries(Object.entries(CAMERAS).map(([id, spec]) => {
  const camera = new THREE.PerspectiveCamera(spec.fov, WIDTH / HEIGHT, NEAR, FAR)
  camera.position.set(...spec.position)
  camera.lookAt(...spec.target)
  camera.updateMatrixWorld()
  return [id, camera]
}))
const bases = Object.fromEntries(Object.entries(CAMERAS).map(([id, spec]) => [id, cameraBasis(spec)]))

const corridorCamera = new THREE.PerspectiveCamera(CORRIDOR_CAMERA.fov, WIDTH / HEIGHT, NEAR, FAR)
corridorCamera.position.set(...CORRIDOR_CAMERA.position)
corridorCamera.lookAt(...CORRIDOR_CAMERA.target)
corridorCamera.updateMatrixWorld()

// The view the player sees. The fixed cameras above are where the plates were painted from.
const follow = createFollowCamera()
const viewCamera = new THREE.PerspectiveCamera(CAMERAS.a.fov, WIDTH / HEIGHT, NEAR, FAR)

// A video frame is captured from a set framing, whatever the player's view is doing at the time.
let framing = null // { pose, plateMix }
const viewPose = () => framing?.pose ?? follow.pose
const viewPlateMix = () => framing?.plateMix ?? follow.plateMix

const SWAY = 0.0022 // Of the distance looked over. Far too little to notice as movement, enough that the picture is not dead still.
function aimViewCamera() {
  const { position, target, fov } = viewPose()
  viewCamera.position.set(...position)
  // Only while the player is walking around: a video has to start from a picture that is exactly its first frame.
  // Nor with one fixed camera, whose picture exactly fills the frame: any turn would show past its edge.
  if (RELAXED && !CAMERAS.a.fixed && !framing && phase === 'explore' && viewMode === 'plate') {
    const seconds = performance.now() / 1000
    const reach = Math.hypot(target[0] - position[0], target[2] - position[2]) * SWAY
    viewCamera.lookAt(target[0] + Math.sin(seconds * 0.43) * reach, target[1] + Math.sin(seconds * 0.31 + 1) * reach, target[2])
  } else {
    viewCamera.lookAt(...target)
  }
  viewCamera.fov = fov
  viewCamera.updateProjectionMatrix()
  viewCamera.updateMatrixWorld()
}

const hemisphere = new THREE.HemisphereLight(0xffffff, 0x8a8478, 1.5)
const sun = new THREE.DirectionalLight(0xffffff, 2.2)
sun.position.set(-4, 7, 5) // Matches the "window light from upper left" asked of the image model.
sun.castShadow = true
sun.shadow.mapSize.set(2048, 2048)
const shadowReach = Math.max(11, ROOM.east + 4, ROOM.south + 4)
Object.assign(sun.shadow.camera, { left: -shadowReach, right: shadowReach, top: shadowReach, bottom: -shadowReach, near: 0.5, far: shadowReach * 3 })
sun.shadow.bias = -0.0006
scene.add(hemisphere, sun, sun.target)
const atmosphere = RELAXED ? createAtmosphere({ scene, room: ROOM, glows: GLOWS }) : null

const clayMaterial = new THREE.MeshStandardMaterial({ color: 0xd8d5ce, roughness: 0.95 })
const clayDoorMaterial = new THREE.MeshStandardMaterial({ color: 0xa79f92, roughness: 0.9 })
const maskBlack = new THREE.MeshBasicMaterial({ color: 0x000000 })
const maskWhite = new THREE.MeshBasicMaterial({ color: 0xffffff })
const guideFloor = new THREE.MeshBasicMaterial({ color: 0x777777 })
const guideDoor = new THREE.MeshBasicMaterial({ color: 0x3a3a3a })

const solids = []
function addBox({ center, size }, material = clayMaterial) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material)
  mesh.position.set(...center)
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.userData.clay = material
  scene.add(mesh)
  solids.push(mesh)
  return mesh
}

const PART_FOLDS = 0 // Flat sides: a side the plate could not see borrows the front.
const PART_ROUND = 1 // Stands upright and round: the far side borrows the near side.
const PART_KEEPS = 2 // Only ever seen from where the plate saw it.

function partGeometry(part) {
  if (part.shape === 'box') return new THREE.BoxGeometry(...part.size)
  if (part.shape === 'round') return new THREE.CylinderGeometry(part.radiusTop, part.radiusBottom, part.height, 24)
  return new THREE.CylinderGeometry(part.radius, part.radius, part.length, 24, 1, false, 0, Math.PI).rotateZ(Math.PI / 2)
}

function addPart(part, objectIndex, homePlate) {
  const geometry = partGeometry(part)
  geometry.computeBoundingBox()
  const low = geometry.boundingBox.min.clone().add(new THREE.Vector3(...part.center))
  const high = geometry.boundingBox.max.clone().add(new THREE.Vector3(...part.center))
  const kind = part.shape === 'box' ? PART_FOLDS : part.shape === 'round' ? PART_ROUND : PART_KEEPS
  const vertices = geometry.attributes.position.count
  const constant = (values) => new THREE.BufferAttribute(new Float32Array(Array.from({ length: vertices }, () => values).flat()), values.length)
  geometry.setAttribute('partLow', constant(low.toArray()))
  geometry.setAttribute('partHigh', constant(high.toArray()))
  geometry.setAttribute('objectIndex', constant([objectIndex]))
  geometry.setAttribute('partKind', constant([kind]))
  geometry.setAttribute('homePlate', constant([homePlate]))
  const mesh = new THREE.Mesh(geometry, clayMaterial)
  mesh.position.set(...part.center)
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.renderOrder = 1.5 // Before the character, which is tested against this depth.
  mesh.userData.clay = clayMaterial
  mesh.userData.castsInClay = true
  scene.add(mesh)
  solids.push(mesh)
  return mesh
}

const objectMeshes = BLOCKS.map((block, index) => block.parts.map(part => addPart(part, index, paintedBy(block) === 'b' ? 1 : 0)))
const blockMeshes = objectMeshes.flat()
const corridorMeshes = SHELLS.map(shell => [shell, addBox(shell)])
  .filter(([shell]) => shell.name.startsWith('corridor'))
  .map(([, mesh]) => mesh)

const floor = new THREE.Mesh(new THREE.PlaneGeometry(FAR * 2, FAR * 2), clayMaterial)
floor.rotation.x = -Math.PI / 2
floor.receiveShadow = true
floor.userData.clay = clayMaterial
scene.add(floor)
solids.push(floor)

// Drawn over the painted plate: only the player's shadow shows, the rest stays transparent.
const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(FAR * 2, FAR * 2), new THREE.ShadowMaterial({ opacity: 0.38 }))
shadowCatcher.rotation.x = -Math.PI / 2
shadowCatcher.position.y = 0.003
shadowCatcher.receiveShadow = true
shadowCatcher.visible = false
scene.add(shadowCatcher)

const doorPivot = new THREE.Group()
doorPivot.position.set(DOOR.x - DOOR.width / 2, 0, DOOR.z - 0.05)
const doorLeaf = new THREE.Mesh(new THREE.BoxGeometry(DOOR.width, DOOR.height, 0.08), clayDoorMaterial)
doorLeaf.position.set(DOOR.width / 2, DOOR.height / 2, 0)
doorLeaf.castShadow = true
doorLeaf.receiveShadow = true
doorLeaf.userData.clay = clayDoorMaterial
doorPivot.add(doorLeaf)
scene.add(doorPivot)
solids.push(doorLeaf)
// A way out with nothing to open is painted on the wall. The leaf stays as a thin marker on it, so the guides
// show the image model where it goes, and everything that handles the door still can.
if (EXIT_KIND !== 'door') {
  doorLeaf.scale.z = 0.1
  doorPivot.position.z = DOOR.z + 0.006
  // Outdoors a marker the height of a door gets painted as something standing there. A low strip gets a path.
  // A real door is the one thing that stays door height out there.
  if (ROOM_KIND === 'outdoor' && WAYS_OUT[0].kind !== 'door') {
    doorLeaf.scale.y = 0.1
    doorLeaf.position.y = (DOOR.height * 0.1) / 2
  }
}
// A place on the map that nothing leads out of, like the bottom of a well, has nothing to mark.
if (JOURNEY && !EXITS.length) doorLeaf.visible = false
// Every other way out of a place on the map gets a marker of its own.
for (const way of WAYS_OUT.slice(1)) {
  const low = ROOM_KIND === 'outdoor' && way.kind !== 'door'
  const marker = new THREE.Mesh(new THREE.BoxGeometry(way.width, way.height * (low ? 0.1 : 1), 0.008), clayDoorMaterial)
  marker.position.set(way.x, (way.height * (low ? 0.1 : 1)) / 2, way.z + 0.006)
  marker.receiveShadow = true
  marker.userData.clay = clayDoorMaterial
  scene.add(marker)
  solids.push(marker)
}

// Only ever seen in the door-mask pass.
const doorOpeningMask = new THREE.Mesh(new THREE.PlaneGeometry(DOOR.width, DOOR.height), maskWhite)
doorOpeningMask.position.set(DOOR.x, DOOR.height / 2, DOOR.z + 0.001)
doorOpeningMask.visible = false
scene.add(doorOpeningMask)

// ---------------------------------------------------------------- player figure
function createFigure() {
  const skin = new THREE.MeshStandardMaterial({ color: 0xe0b596, roughness: 0.7 })
  const coat = new THREE.MeshStandardMaterial({ color: 0x27424f, roughness: 0.8 })
  const trousers = new THREE.MeshStandardMaterial({ color: 0x23242b, roughness: 0.85 })
  const scarf = new THREE.MeshStandardMaterial({ color: 0xb23a2e, roughness: 0.8 })
  const hair = new THREE.MeshStandardMaterial({ color: 0x2c1f18, roughness: 0.9 })
  const root = new THREE.Group()
  const body = new THREE.Group()
  root.add(body)

  const add = (parent, geometry, material, x, y, z) => {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(x, y, z)
    mesh.castShadow = true
    parent.add(mesh)
    return mesh
  }
  add(body, new THREE.CapsuleGeometry(0.17, 0.42, 6, 14), coat, 0, 1.17, 0)
  add(body, new THREE.CylinderGeometry(0.095, 0.12, 0.09, 14), scarf, 0, 1.47, 0)
  add(body, new THREE.SphereGeometry(0.125, 18, 14), skin, 0, 1.61, 0)
  add(body, new THREE.SphereGeometry(0.132, 18, 14, 0, Math.PI * 2, 0, Math.PI * 0.55), hair, 0, 1.625, -0.012)

  const limb = (x, upperMaterial, lowerMaterial, hipY, upper, lower, radius, foot) => {
    const hip = new THREE.Group()
    hip.position.set(x, hipY, 0)
    body.add(hip)
    add(hip, new THREE.CapsuleGeometry(radius, upper - radius * 2, 4, 10), upperMaterial, 0, -upper / 2, 0)
    const knee = new THREE.Group()
    knee.position.y = -upper
    hip.add(knee)
    add(knee, new THREE.CapsuleGeometry(radius * 0.85, lower - radius * 1.7, 4, 10), lowerMaterial, 0, -lower / 2, 0)
    if (foot) add(knee, new THREE.BoxGeometry(0.1, 0.05, 0.22), trousers, 0, -lower + 0.015, 0.05)
    return { hip, knee }
  }
  const half = LEG_LENGTH / 2
  const legL = limb(-0.085, trousers, trousers, LEG_LENGTH, half, half, 0.07, true)
  const legR = limb(0.085, trousers, trousers, LEG_LENGTH, half, half, 0.07, true)
  const armL = limb(-0.215, coat, skin, 1.4, 0.3, 0.29, 0.05, false)
  const armR = limb(0.215, coat, skin, 1.4, 0.3, 0.29, 0.05, false)
  return { root, body, legL, legR, armL, armR }
}

const figure = createFigure()
scene.add(figure.root)

const contactTexture = (() => {
  const paint = document.createElement('canvas')
  paint.width = paint.height = 128
  const ctx = paint.getContext('2d')
  const gradient = ctx.createRadialGradient(64, 64, 4, 64, 64, 64)
  gradient.addColorStop(0, 'rgba(0,0,0,.6)')
  gradient.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 128, 128)
  return new THREE.CanvasTexture(paint)
})()
const contact = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.85), new THREE.MeshBasicMaterial({ map: contactTexture, transparent: true, depthWrite: false }))
contact.rotation.x = -Math.PI / 2
contact.position.y = 0.006
scene.add(contact)

// The rendered character: a picture standing upright at the player's feet and turned to the
// camera. It sits in the 3D scene, so walls and furniture still hide it by real depth.
// A high cut-off: close up, the half-transparent rim left over from the green screen shows green.
const spriteMaterial = new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.6, depthWrite: false, side: THREE.DoubleSide })
const spriteMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), spriteMaterial)
// The picture being left behind, fading out, so a change of pose or direction is not a sudden swap.
const outgoingMaterial = new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.02, depthWrite: false, side: THREE.DoubleSide })
const outgoingMesh = new THREE.Mesh(spriteMesh.geometry, outgoingMaterial)
outgoingMesh.renderOrder = 3
outgoingMesh.visible = false
scene.add(outgoingMesh)
const POSE_FADE_SECONDS = 0.12
let shownPose = null // What is on screen: which sheet, frame and direction.
let outgoing = null
let outgoingLeft = 0

function forgetPose() {
  shownPose = null
  outgoing = null
  outgoingLeft = 0
  outgoingMesh.visible = false
}

function showFrame(texture, sheet, frame, mirror) {
  const column = frame % sheet.columns
  const row = Math.floor(frame / sheet.columns)
  texture.repeat.set((mirror ? -1 : 1) / sheet.columns, 1 / sheet.rows)
  texture.offset.set((column + (mirror ? 1 : 0)) / sheet.columns, 1 - (row + 1) / sheet.rows)
}
spriteMesh.castShadow = true
spriteMesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, alphaTest: 0.5 })
spriteMesh.renderOrder = 2
spriteMesh.visible = false
scene.add(spriteMesh)
contact.renderOrder = 1

const sprites = {} // direction → { texture, frameCount, cycleFrames, ... }
const hasSprites = () => Object.keys(sprites).length > 0
let actorVisible = true

// The rendered character belongs to the rendered room. The whitebox view stays all whitebox, and
// is also what shows until the rendered character exists.
const showsRenderedCharacter = () => viewMode === 'plate' && hasSprites()

// A prop lying out in the room is a real thing in the scene, so taking it away needs no new plate.
const propMaterial = new THREE.MeshBasicMaterial({ color: 0xfff0d8, transparent: true, alphaTest: 0.3 })
const stageProp = new THREE.Mesh(new THREE.PlaneGeometry(STAGE_PROP?.size ?? 0.3, STAGE_PROP?.size ?? 0.3), propMaterial)
stageProp.rotation.set(-Math.PI / 2, 0, STAGE_PROP?.turn ?? 0)
if (STAGE_PROP) stageProp.position.set(...STAGE_PROP.position)
stageProp.renderOrder = 1.6 // After the table it lies on.
stageProp.visible = false
scene.add(stageProp)
let propOnStage = Boolean(STAGE_PROP)

// See "painted loosely" below. A full-screen triangle, so it covers the view wherever the camera has turned.
const occluderGeometry = new THREE.BufferGeometry()
occluderGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
const occluderMesh = new THREE.Mesh(occluderGeometry)
occluderMesh.frustumCulled = false
occluderMesh.renderOrder = 4 // Over the character, and under the dust.
occluderMesh.visible = false
scene.add(occluderMesh)
let occludersBuilt = false
const occludersInUse = () => occludersBuilt && viewMode === 'plate' && platesReady()

function setActorVisible(visible) {
  actorVisible = visible
  contact.visible = visible
  stageProp.visible = visible && propOnStage
  occluderMesh.visible = visible && occludersInUse()
  figure.root.visible = visible && !showsRenderedCharacter()
  spriteMesh.visible = visible && showsRenderedCharacter()
  if (!spriteMesh.visible) outgoingMesh.visible = false
}

async function loadSprites() {
  if (!(await assetExists('sprites.json'))) return
  const manifest = await (await fetch(`assets/sprites.json?t=${Date.now()}`)).json()
  for (const [direction, entry] of Object.entries(manifest)) {
    const texture = new THREE.Texture(await loadImage(`assets/${entry.file}`))
    texture.colorSpace = THREE.SRGBColorSpace
    // Without mipmaps, a frame cannot pick up colour from its neighbours in the sheet.
    texture.generateMipmaps = false
    texture.minFilter = THREE.LinearFilter
    texture.needsUpdate = true
    sprites[direction]?.texture.dispose()
    sprites[direction] = { ...entry, texture, outgoingTexture: texture.clone(), feetRaised: RELAXED ? blankBelowFeet(texture.image, entry) : 0 }
  }
  setActorVisible(actorVisible)
}

// Share of a frame's height left empty under the feet. Seen from near eye level, that much makes a figure float.
function blankBelowFeet(sheet, { columns, rows }) {
  const width = Math.round(sheet.naturalWidth / columns)
  const height = Math.round(sheet.naturalHeight / rows)
  const reader = document.createElement('canvas')
  reader.width = width
  reader.height = height
  const ctx = reader.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(sheet, 0, 0, width, height, 0, 0, width, height)
  const { data } = ctx.getImageData(0, 0, width, height)
  for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 153) return (height - 1 - y) / height // The same cut-off the figure is drawn with.
    }
  }
  return 0
}

function poseSprite(player, viewer, basis) {
  // A frame for a video has to be the same picture every time, whatever was on screen before it.
  const live = !framing
  const direction = spriteDirection(player.yaw, basis, live ? shownPose : null)
  const { id, mirror } = direction
  const sheet = sprites[id]
  // Frame 0 is the standing pose. Walking frames follow the distance covered, not the clock.
  // Only the side view shows the true step length, so every direction shares its measurement.
  const cycles = (player.phase / (Math.PI * 2)) * (stepLength(1) / sprites.e.stepMeters)
  const frame = player.gait < 0.05 ? 0
    : 1 + Math.floor(cycles * sheet.cycleFrames) % sheet.cycleFrames
  const walking = frame !== 0
  if (live && shownPose && (shownPose.id !== id || shownPose.mirror !== mirror || shownPose.walking !== walking)) {
    outgoing = shownPose
    outgoingLeft = POSE_FADE_SECONDS
  }
  if (live) shownPose = { id, mirror, walking, frame }
  const { texture } = sheet
  showFrame(texture, sheet, frame, mirror)
  spriteMaterial.map = texture
  spriteMesh.customDepthMaterial.map = texture
  spriteMesh.scale.set(sheet.widthMeters, sheet.heightMeters, 1)
  spriteMesh.position.set(player.x, sheet.heightMeters * (0.5 - sheet.feetRaised), player.z)
  spriteMesh.rotation.y = Math.atan2(viewer.position.x - player.x, viewer.position.z - player.z)
  outgoingMesh.visible = live && outgoingLeft > 0 && spriteMesh.visible
  if (outgoingMesh.visible) {
    const old = sprites[outgoing.id]
    showFrame(old.outgoingTexture, old, outgoing.frame, outgoing.mirror)
    outgoingMaterial.map = old.outgoingTexture
    outgoingMaterial.opacity = outgoingLeft / POSE_FADE_SECONDS
    outgoingMesh.scale.set(old.widthMeters, old.heightMeters, 1)
    outgoingMesh.position.set(player.x, old.heightMeters * (0.5 - old.feetRaised), player.z)
    outgoingMesh.rotation.y = spriteMesh.rotation.y
  }
  contact.position.x = player.x
  contact.position.z = player.z
}

function poseFigure(player) {
  const swing = swingAngle(player.gait, player.phase)
  const opposite = -swing
  // The knee only bends while that leg is swinging forward, so the stance leg stays straight.
  const kneeFor = phase => 0.95 * player.gait * Math.max(0, Math.cos(phase))
  figure.legL.hip.rotation.x = swing
  figure.legL.knee.rotation.x = kneeFor(player.phase)
  figure.legR.hip.rotation.x = opposite
  figure.legR.knee.rotation.x = kneeFor(player.phase + Math.PI)
  figure.armL.hip.rotation.x = opposite * 0.75
  figure.armR.hip.rotation.x = swing * 0.75
  figure.armL.knee.rotation.x = figure.armR.knee.rotation.x = -0.25 * player.gait
  // The hips drop as the legs spread, which keeps the planted foot on the floor.
  figure.body.position.y = LEG_LENGTH * (Math.cos(swing) - 1)
  figure.root.position.set(player.x, 0, player.z)
  figure.root.rotation.y = player.yaw
  contact.position.x = player.x
  contact.position.z = player.z
}

// ---------------------------------------------------------------- plates
const plates = {} // id → { texture, luminance }
const mattes = {} // camera id → { texture whose alpha is 1 on furniture, canvas, isObject }
const furniturePaint = {} // camera id → the finished plate with furniture colour spread past its outline
const IDENTITY_FIT = { uScale: 1, vScale: 1, uOffset: 0, vOffset: 0 }
const asFitVector = ({ uScale, vScale, uOffset, vOffset }) => new THREE.Vector4(uScale, vScale, uOffset, vOffset)
const furnitureFits = { a: BLOCKS.map(() => asFitVector(IDENTITY_FIT)), b: BLOCKS.map(() => asFitVector(IDENTITY_FIT)) }
let viewMode = 'clay'
let doorOpen = false
let activeCameraId = 'a'
let player = createPlayer(SPAWN)

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`无法加载 ${url}`))
    image.src = `${url}?t=${Date.now()}`
  })
}

async function loadPlates() {
  for (const id of ['a_closed', 'a_open', 'b', 'a_empty', 'b_empty', 'corridor']) {
    if (!(await assetExists(`plate_${id}.png`))) continue
    const image = await loadImage(`assets/plate_${id}.png`)
    const texture = new THREE.Texture(image)
    texture.colorSpace = THREE.SRGBColorSpace
    // Floors are seen at a slant, and without this they smear along the direction of view.
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy()
    texture.needsUpdate = true
    const small = document.createElement('canvas')
    small.width = 64
    small.height = 36
    const ctx = small.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(image, 0, 0, 64, 36)
    plates[id]?.texture.dispose()
    plates[id] = { texture, pixels: ctx.getImageData(0, 0, 64, 36).data }
  }
  for (const [id, plateId] of [['a', 'a_closed'], ['b', 'b']]) {
    if (!plates[plateId] || !(await assetExists(`plate_${id}_matte.png`))) continue
    mattes[id]?.texture.dispose()
    mattes[id] = await loadMatte(`assets/plate_${id}_matte.png`)
    if (RELAXED) {
      if (id === 'b' && CAMERAS.a.fixed && occluders.a) {
        occluders.b = occluders.a
        occludersBuilt = TRIPOD
      } else {
        buildOccluder(id)
      }
      continue
    }
    furniturePaint[id]?.dispose()
    furniturePaint[id] = spreadFurnitureColour(plates[plateId].texture.image, mattes[id].canvas)
    furnitureFits[id] = measureFits(id)
  }
  if (plates.a_closed && plates.a_empty && mattes.a) {
    roomMaterial.uniforms.roomLight.value?.dispose()
    roomMaterial.uniforms.roomLight.value = measureRoomLight(plates.a_closed.texture.image, plates.a_empty.texture.image, mattes.a.canvas)
  }
}

// How much brighter or darker the finished room is than the emptied one, as a soft map. Furniture is left
// out: a dark sofa is not a shadow on the wall behind it, and from the second camera that wall is in plain
// view. What the furniture covered takes its light from around it.
const ROOM_LIGHT_SCALE = 2.0 // A stored 1 means this much light. A byte of 0–1 has to reach the brightest.
const ROOM_LIGHT_RANGE = [0.35, 1.5]
function measureRoomLight(closed, empty, matte) {
  const cellWidth = 64
  const cellHeight = 36
  const sample = 4 // Pixels per cell each way.
  const width = cellWidth * sample
  const height = cellHeight * sample
  const pixelsOf = image => {
    const small = document.createElement('canvas')
    small.width = width
    small.height = height
    const ctx = small.getContext('2d', { willReadFrequently: true })
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(image, 0, 0, width, height)
    return ctx.getImageData(0, 0, width, height).data
  }
  const finished = pixelsOf(closed)
  const emptied = pixelsOf(empty)
  const furniture = pixelsOf(matte)
  const linear = value => (value / 255) ** 2.2
  const luminance = (data, i) => 0.2126 * linear(data[i]) + 0.7152 * linear(data[i + 1]) + 0.0722 * linear(data[i + 2])
  let ratio = new Float32Array(cellWidth * cellHeight).fill(-1)
  for (let cy = 0; cy < cellHeight; cy++) {
    for (let cx = 0; cx < cellWidth; cx++) {
      let lit = 0
      let bare = 0
      let open = 0
      for (let y = cy * sample; y < (cy + 1) * sample; y++) {
        for (let x = cx * sample; x < (cx + 1) * sample; x++) {
          const i = (y * width + x) * 4
          if (furniture[i + 3] > 40) continue
          lit += luminance(finished, i)
          bare += luminance(emptied, i)
          open++
        }
      }
      if (open >= sample * sample / 2) ratio[cy * cellWidth + cx] = THREE.MathUtils.clamp(lit / Math.max(bare, 0.0001), ...ROOM_LIGHT_RANGE)
    }
  }
  const around = (field, x, y, accept) => {
    let sum = 0
    let count = 0
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const px = x + dx
        const py = y + dy
        if (px < 0 || py < 0 || px >= cellWidth || py >= cellHeight) continue
        const value = field[py * cellWidth + px]
        if (accept(value)) { sum += value; count++ }
      }
    }
    return count ? sum / count : -1
  }
  for (let unknown = ratio.includes(-1); unknown;) {
    const before = ratio
    ratio = before.map((value, n) => value >= 0 ? value : around(before, n % cellWidth, Math.floor(n / cellWidth), other => other >= 0))
    if (!ratio.includes(-1) || ratio.every((value, n) => value === before[n])) unknown = false
  }
  for (let pass = 0; pass < 2; pass++) {
    const before = ratio
    ratio = before.map((value, n) => around(before, n % cellWidth, Math.floor(n / cellWidth), () => true))
  }
  // Stored bottom row first, the way the plates are read.
  const bytes = new Uint8Array(cellWidth * cellHeight)
  for (let y = 0; y < cellHeight; y++) {
    for (let x = 0; x < cellWidth; x++) {
      const value = ratio[y * cellWidth + x]
      bytes[(cellHeight - 1 - y) * cellWidth + x] = Math.round(255 * (value < 0 ? 1 : value) / ROOM_LIGHT_SCALE)
    }
  }
  const texture = new THREE.DataTexture(bytes, cellWidth, cellHeight, THREE.RedFormat)
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.needsUpdate = true
  return texture
}

function measureFits(cameraId) {
  const masks = objectMasks(cameraId)
  const { isObject } = mattes[cameraId]
  return BLOCKS.map((block, index) => {
    if (paintedBy(block) !== cameraId) return asFitVector(IDENTITY_FIT)
    return asFitVector(fitToWhitebox({
      width: WIDTH,
      height: HEIGHT,
      inWhitebox: masks[index],
      isPainted: isObject,
      isOther: (x, y) => masks.some((mask, other) => other !== index && mask(x, y)),
    }))
  })
}

// Turns whatever was painted pure green transparent.
function keyedOutGreen(image, width, height) {
  const paint = document.createElement('canvas')
  paint.width = width
  paint.height = height
  const ctx = paint.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(image, 0, 0, width, height)
  const pixels = ctx.getImageData(0, 0, width, height)
  const { data } = pixels
  for (let i = 0; i < data.length; i += 4) {
    const green = data[i + 1] - Math.max(data[i], data[i + 2])
    data[i + 3] = 255 * (1 - THREE.MathUtils.smoothstep(green, 25, 80))
  }
  ctx.putImageData(pixels, 0, 0)
  return { paint, data }
}

// The model paints everything that is not furniture pure green. Alpha ends up holding the outline.
async function loadMatte(url) {
  const { paint, data } = keyedOutGreen(await loadImage(url), WIDTH, HEIGHT)
  const isObject = (x, y) => data[(y * WIDTH + x) * 4 + 3] > 127
  return { texture: new THREE.CanvasTexture(paint), canvas: paint, isObject }
}

const itemIcons = {} // item id → picture to show in the inventory

async function loadProps() {
  for (const id of Object.keys(ITEMS)) {
    if (!(await assetExists(`plate_prop_${id}.png`))) continue
    const { paint } = keyedOutGreen(await loadImage(`assets/plate_prop_${id}.png`), 512, 512)
    itemIcons[id] = paint.toDataURL('image/png')
    if (id === STAGE_PROP?.item) {
      propMaterial.map = new THREE.CanvasTexture(paint)
      propMaterial.map.colorSpace = THREE.SRGBColorSpace
      propMaterial.needsUpdate = true
    }
  }
  shownItems = null
}

let shownItems = null

function updateItems() {
  const current = story.items.join()
  if (current === shownItems) return
  shownItems = current
  itemsEl.replaceChildren(...story.items.map(id => {
    const item = document.createElement('div')
    item.className = 'item'
    if (itemIcons[id]) {
      const icon = new Image()
      icon.src = itemIcons[id]
      icon.alt = ''
      item.append(icon)
    }
    item.append(ITEMS[id])
    return item
  }))
}

// A box's corners can stick out past what was painted. Colour spread outward from the furniture
// covers them, so a box never shows the wall that was behind it in the picture.
function spreadFurnitureColour(plateImage, matteCanvas) {
  const { naturalWidth: width, naturalHeight: height } = plateImage
  const blank = () => {
    const paint = document.createElement('canvas')
    paint.width = width
    paint.height = height
    return [paint, paint.getContext('2d')]
  }
  const [cut, cutCtx] = blank()
  cutCtx.drawImage(plateImage, 0, 0, width, height)
  cutCtx.globalCompositeOperation = 'destination-in'
  cutCtx.drawImage(matteCanvas, 0, 0, width, height)
  const [spread, ctx] = blank()
  ctx.drawImage(cut, 0, 0)
  ctx.globalCompositeOperation = 'destination-over'
  // Sharpest first, so each pixel takes its colour from the nearest furniture it can.
  for (const radius of [3, 6, 12, 24, 48, 96]) {
    ctx.filter = `blur(${radius}px)`
    for (let i = 0; i < 3; i++) ctx.drawImage(cut, 0, 0)
  }
  // A block the model painted nothing onto, because it drew the thing somewhere else, shows what the picture has
  // there rather than black.
  ctx.filter = 'none'
  ctx.drawImage(plateImage, 0, 0, width, height)
  const texture = new THREE.CanvasTexture(spread)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy()
  return texture
}

let knownAssets = null
async function assetExists(name) {
  knownAssets ??= (await (await fetch('api/status')).json()).assets
  return knownAssets.includes(name)
}

// ---------------------------------------------------------------- plates on the whitebox
// Painting each plate back onto the geometry is what lets the camera move: the picture stays on
// the surfaces instead of on the screen. It comes in two layers, because a plate cannot show what
// its furniture stands in front of. The floor and walls come from pictures of the emptied room, so
// they have no holes. The furniture comes from the finished pictures and sits on top.
const DEPTH_WIDTH = 2048
const DEPTH_HEIGHT = 1152

function renderPlateDepth(cameraId, open, withFurniture) {
  const depthTexture = new THREE.DepthTexture(DEPTH_WIDTH, DEPTH_HEIGHT, THREE.UnsignedIntType)
  const target = new THREE.WebGLRenderTarget(DEPTH_WIDTH, DEPTH_HEIGHT, { depthTexture, depthBuffer: true })
  setActorVisible(false)
  blockMeshes.forEach(mesh => { mesh.visible = withFurniture })
  doorPivot.rotation.y = open ? DOOR_OPEN_ANGLE : 0
  renderer.setRenderTarget(target)
  renderer.clear()
  renderer.render(scene, cameras[cameraId])
  renderer.setRenderTarget(null)
  blockMeshes.forEach(mesh => { mesh.visible = true })
  setActorVisible(true)
  return depthTexture
}

const roomDepths = { a: renderPlateDepth('a', false, false), b: renderPlateDepth('b', false, false) }
const furnitureDepths = { a: renderPlateDepth('a', false, true), b: renderPlateDepth('b', false, true) }

const viewProjection = camera => new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
const blockBounds = sign => BLOCKS.map(({ center, size }) =>
  new THREE.Vector3(...center.map((value, i) => value + sign * size[i] / 2)))

const projectionUniforms = () => ({
  plateA: { value: null },
  plateB: { value: null },
  depthA: { value: null },
  depthB: { value: null },
  viewProjectionA: { value: viewProjection(cameras.a) },
  viewProjectionB: { value: viewProjection(cameras.b) },
  plateMix: { value: 0 },
  depthTexel: { value: new THREE.Vector2(1 / DEPTH_WIDTH, 1 / DEPTH_HEIGHT) },
  blockMin: { value: blockBounds(-1) },
  blockMax: { value: blockBounds(1) },
})

const projectionVertex = `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

const projectionCommon = `
  uniform sampler2D plateA, plateB, depthA, depthB;
  uniform mat4 viewProjectionA, viewProjectionB;
  uniform float plateMix;
  uniform vec2 depthTexel;
  #define BLOCK_COUNT ${BLOCKS.length}
  uniform vec3 blockMin[BLOCK_COUNT];
  uniform vec3 blockMax[BLOCK_COUNT];
  varying vec3 vWorld;

  const float NEAR = ${NEAR.toFixed(3)};
  const float FAR = ${FAR.toFixed(3)};
  const float DEPTH_TOLERANCE = 0.08; // Metres.
  const float EDGE_FEATHER = 0.03;
  const float MAX_UV_STEP = 0.012;

  float metres(float stored) {
    float ndc = stored * 2.0 - 1.0;
    return 2.0 * NEAR * FAR / (FAR + NEAR - ndc * (FAR - NEAR));
  }

  // rgb is the plate's colour at this point, a is how far it can be trusted.
  vec4 fromPlate(sampler2D plate, sampler2D depth, mat4 viewProjectionMatrix, vec3 world, out vec2 uv) {
    vec4 clip = viewProjectionMatrix * vec4(world, 1.0);
    uv = clip.xy / max(clip.w, 0.0001) * 0.5 + 0.5;
    if (clip.w <= 0.0) return vec4(0.0);
    vec2 toEdge = min(uv, 1.0 - uv);
    float inside = smoothstep(0.0, EDGE_FEATHER, toEdge.x) * smoothstep(0.0, EDGE_FEATHER, toEdge.y);
    // Right on the edge of a mesh the screen gradient can come out wild, and the plate would then be read at its
    // blurriest level: a dotted line in the plate's average colour. No real surface minifies this much.
    vec2 alongX = dFdx(uv);
    vec2 alongY = dFdy(uv);
    float steepest = max(length(alongX), length(alongY));
    if (steepest > MAX_UV_STEP) {
      alongX *= MAX_UV_STEP / steepest;
      alongY *= MAX_UV_STEP / steepest;
    }
    if (inside <= 0.0) return vec4(0.0);
    float distance = metres(clip.z / clip.w * 0.5 + 0.5);
    vec4 around = vec4(
      metres(texture2D(depth, uv + depthTexel * vec2(-1.0, -1.0)).r),
      metres(texture2D(depth, uv + depthTexel * vec2( 1.0, -1.0)).r),
      metres(texture2D(depth, uv + depthTexel * vec2(-1.0,  1.0)).r),
      metres(texture2D(depth, uv + depthTexel * vec2( 1.0,  1.0)).r));
    // A wall seen nearly edge-on changes depth quickly from texel to texel, and without this
    // allowance it would read as hiding itself. A big jump is a real edge, not a slope.
    float spread = max(max(around.x, around.y), max(around.z, around.w)) - min(min(around.x, around.y), min(around.z, around.w));
    float tolerance = DEPTH_TOLERANCE + (spread < 1.0 ? spread : 0.0);
    float seen = dot(step(vec4(distance - tolerance), around), vec4(0.25));
    return vec4(textureGrad(plate, uv, alongX, alongY).rgb, inside * seen);
  }
`

// The floor, walls and door. Furniture leaves its contact shadow behind when it is painted out, so
// that comes from the distance to each box, which is soft everywhere and needs no picture.
const roomMaterial = new THREE.ShaderMaterial({
  uniforms: {
    ...projectionUniforms(),
    finishedA: { value: null },
    roomLight: { value: null },
    corridorPlate: { value: null },
    viewProjectionCorridor: { value: viewProjection(corridorCamera) },
    showHoles: { value: 0 },
  },
  vertexShader: projectionVertex,
  fragmentShader: `
    ${projectionCommon}
    uniform sampler2D finishedA, corridorPlate, roomLight;
    uniform mat4 viewProjectionCorridor;
    uniform float showHoles;
    const float CORRIDOR_BEGINS = ${(DOOR.z - 0.01).toFixed(2)};
    const float DOOR_WEST = ${(DOOR.x - DOOR.width / 2).toFixed(2)};
    const float DOOR_EAST = ${(DOOR.x + DOOR.width / 2).toFixed(2)};
    const float BEHIND_THE_WALL = ${(DOOR.z - 0.2).toFixed(2)};
    const bool OUTDOORS = ${ROOM_KIND === 'outdoor'};
    const bool EXIT_IS_DOOR = ${EXIT_KIND === 'door'};
    const float CONTACT_DARKEST = 0.6;
    const float CONTACT_REACH = 0.6; // Metres.
    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
    const vec3 HOLE = vec3(1.0, 0.0, 1.0);

    const float ROOM_LIGHT_SCALE = ${ROOM_LIGHT_SCALE.toFixed(1)};

    float contactLight() {
      float nearest = CONTACT_REACH;
      for (int i = 0; i < BLOCK_COUNT; i++) {
        vec3 outside = max(blockMin[i] - vWorld, vWorld - blockMax[i]);
        nearest = min(nearest, length(max(outside, vec3(0.0))));
      }
      return mix(CONTACT_DARKEST, 1.0, smoothstep(0.0, CONTACT_REACH, nearest));
    }

    // The emptied room keeps its grain, but the broad light and colour come from the finished
    // picture, so the soft shadows and the lamp's glow stay in the room.
    vec3 lit(vec3 emptied, vec2 uv) {
      // Sky is not lit by the room. Two paintings of it just have different clouds, and that is not a shadow.
      if (OUTDOORS && vWorld.y > 0.01) return emptied;
      vec2 inside = clamp(uv, 0.0, 1.0);
      // Brightness only. Dividing each colour on its own turns small differences into rainbows.
      float light = texture2D(roomLight, inside).r * ROOM_LIGHT_SCALE;
      vec3 tint = textureLod(finishedA, vec2(0.5), 20.0).rgb / max(textureLod(plateA, vec2(0.5), 20.0).rgb, vec3(0.005));
      return emptied * light * tint / max(dot(tint, LUMA), 0.005);
    }

    void main() {
      vec2 uvA, uvB;
      vec4 a = fromPlate(plateA, depthA, viewProjectionA, vWorld, uvA);
      vec4 b = fromPlate(plateB, depthB, viewProjectionB, vWorld, uvB);
      // Whatever the first picture saw always comes from it, whichever camera is looking. A surface
      // with one source cannot change as the view moves. The second picture only fills in the rest.
      vec3 color;
      if (showHoles > 0.5) {
        color = a.a > 0.5 ? lit(a.rgb, uvA) : HOLE;
      } else {
        vec3 rest = b.a > 0.0 ? b.rgb : textureLod(plateA, clamp(uvA, 0.0, 1.0), 4.0).rgb;
        color = mix(rest, lit(a.rgb, uvA), a.a) * contactLight();
      }
      // The floor runs on under the back wall, and along the wall's foot the hidden part can win a pixel here
      // and there. Only the doorway shows what is behind it, so anywhere else that pixel is just more floor.
      if (EXIT_IS_DOOR && vWorld.z < CORRIDOR_BEGINS && ((vWorld.x > DOOR_WEST && vWorld.x < DOOR_EAST) || vWorld.z < BEHIND_THE_WALL)) {
        vec4 clip = viewProjectionCorridor * vec4(vWorld, 1.0);
        color = texture2D(corridorPlate, clamp(clip.xy / clip.w * 0.5 + 0.5, 0.0, 1.0)).rgb;
      }
      gl_FragColor = vec4(color, 1.0);
      #include <colorspace_fragment>
    }
  `,
})

// A plate barely sees the sides of a box, and stretching those few pixels across the whole side
// looks like a smear. The box's front, folded around the corner, is the same material.
const furnitureFragment = `
  ${projectionCommon}
  uniform vec3 plateCameraA, plateCameraB;
  uniform vec4 fitA[BLOCK_COUNT];
  uniform vec4 fitB[BLOCK_COUNT];
  varying vec3 vPartLow, vPartHigh, vNormal;
  varying float vObjectIndex, vPartKind, vHomePlate;
  const float SIDE_VIEW_LIMIT = 0.45;
  const float SIDE_STRIP_START = 0.0; // Metres in from the front's edge. Any further and it can reach the books.
  const float SIDE_STRIP_WIDTH = 0.012;
  const float SIDE_BLUR = 4.5; // Mip level. A strip this thin, stretched across a whole side, shows as streaks.
  bool foldedSide = false;

  // Where on this part the plate saw something that can stand in for this point.
  vec3 seenStandIn(vec3 world, vec3 plateCamera) {
    if (vPartKind > ${(PART_KEEPS - 0.5).toFixed(1)}) return world;
    if (vPartKind > ${(PART_ROUND - 0.5).toFixed(1)}) {
      vec2 axis = (vPartLow.xz + vPartHigh.xz) * 0.5;
      vec2 toPlate = normalize(plateCamera.xz - axis);
      float side = dot(world.xz - axis, toPlate);
      return side >= 0.0 ? world : vec3(world.x - 2.0 * side * toPlate.x, world.y, world.z - 2.0 * side * toPlate.y);
    }
    vec3 low = vPartLow;
    vec3 high = vPartHigh;
    // Which face this is comes from its direction, not its position: a point on the front that
    // happens to be close to a corner is still on the front.
    if (abs(vNormal.y) > 0.5 || vNormal.z > 0.5) return world;
    if (vNormal.z < -0.5) return vec3(world.x, world.y, high.z);
    bool onWest = vNormal.x < 0.0;
    vec3 toPlate = normalize(plateCamera - world);
    bool facesPlate = onWest ? toPlate.x < 0.0 : toPlate.x > 0.0;
    if (facesPlate && abs(toPlate.x) >= SIDE_VIEW_LIMIT) return world;
    // The side of a thing is plain, whatever its front shows: a bookcase has no books on its side.
    // The outermost upright of the front is the same material, so the side is drawn from that.
    foldedSide = true;
    float width = high.x - low.x;
    float acrossSide = (high.z - world.z) / max(high.z - low.z, 0.001);
    float inset = min(SIDE_STRIP_START, width * 0.2) + acrossSide * min(SIDE_STRIP_WIDTH, width * 0.3);
    return vec3(onWest ? low.x + inset : high.x - inset, world.y, high.z);
  }

  // A thin part can hide a strip of a bigger one from the plate. The same surface just beside it is alike.
  vec4 besideWhatHidIt(sampler2D plate, sampler2D depth, mat4 viewProjectionMatrix, vec3 world, out vec2 uv) {
    vec4 here = fromPlate(plate, depth, viewProjectionMatrix, world, uv);
    if (here.a > 0.99) return here;
    vec2 asideUv;
    for (int i = 1; i <= 3; i++) {
      vec3 aside = vec3(0.1 * float(i), 0.0, 0.0);
      vec4 right = fromPlate(plate, depth, viewProjectionMatrix, world + aside, asideUv);
      if (right.a > 0.99) { uv = asideUv; return right; }
      vec4 left = fromPlate(plate, depth, viewProjectionMatrix, world - aside, asideUv);
      if (left.a > 0.99) { uv = asideUv; return left; }
    }
    return here;
  }

  void main() {
    int object = int(vObjectIndex + 0.5);
    vec2 uv;
    vec2 at;
    vec4 seen;
    vec3 sharp;
    vec3 soft;
    // Each object has one picture of it, whichever camera is looking, so it never changes.
    if (vHomePlate < 0.5) {
      seen = besideWhatHidIt(plateA, depthA, viewProjectionA, seenStandIn(vWorld, plateCameraA), uv);
      at = clamp(uv * fitA[object].xy + fitA[object].zw, 0.0, 1.0);
      sharp = foldedSide ? textureLod(plateA, at, SIDE_BLUR).rgb : texture2D(plateA, at).rgb;
      soft = textureLod(plateA, at, 4.0).rgb;
    } else {
      seen = besideWhatHidIt(plateB, depthB, viewProjectionB, seenStandIn(vWorld, plateCameraB), uv);
      at = clamp(uv * fitB[object].xy + fitB[object].zw, 0.0, 1.0);
      sharp = foldedSide ? textureLod(plateB, at, SIDE_BLUR).rgb : texture2D(plateB, at).rgb;
      soft = textureLod(plateB, at, 4.0).rgb;
    }
    gl_FragColor = vec4(mix(soft, sharp, seen.a), 1.0);
    #include <colorspace_fragment>
  }
`

const furnitureMaterial = new THREE.ShaderMaterial({
  uniforms: {
    ...projectionUniforms(),
    plateCameraA: { value: cameras.a.position },
    plateCameraB: { value: cameras.b.position },
    fitA: { value: furnitureFits.a },
    fitB: { value: furnitureFits.b },
  },
  vertexShader: `
    attribute vec3 partLow, partHigh;
    attribute float objectIndex, partKind, homePlate;
    varying vec3 vWorld, vPartLow, vPartHigh, vNormal;
    varying float vObjectIndex, vPartKind, vHomePlate;
    void main() {
      vec4 world = modelMatrix * vec4(position, 1.0);
      vWorld = world.xyz;
      vNormal = normal; // Furniture is never rotated, so this is also its direction in the room.
      vPartLow = partLow;
      vPartHigh = partHigh;
      vObjectIndex = objectIndex;
      vPartKind = partKind;
      vHomePlate = homePlate;
      gl_Position = projectionMatrix * viewMatrix * world;
    }
  `,
  fragmentShader: furnitureFragment,
})

// An open door is seen almost edge-on from the plate's camera, so that picture has nothing to put
// on it. The closed picture shows the whole door, and the leaf carries it wherever it swings.
const doorLeafMaterial = new THREE.ShaderMaterial({
  uniforms: {
    closedPlate: { value: null },
    viewProjectionA: { value: viewProjection(cameras.a) },
    pivot: { value: doorPivot.position },
    angle: { value: 0 },
  },
  vertexShader: projectionVertex,
  fragmentShader: `
    uniform sampler2D closedPlate;
    uniform float angle;
    uniform mat4 viewProjectionA;
    uniform vec3 pivot;
    varying vec3 vWorld;

    void main() {
      vec3 local = vWorld - pivot;
      float c = cos(angle);
      float s = sin(angle);
      vec3 shut = pivot + vec3(local.x * c - local.z * s, local.y, local.x * s + local.z * c);
      vec4 clip = viewProjectionA * vec4(shut, 1.0);
      gl_FragColor = vec4(texture2D(closedPlate, clip.xy / clip.w * 0.5 + 0.5).rgb, 1.0);
      #include <colorspace_fragment>
    }
  `,
})

// On a tripod the camera never leaves where the pictures were painted from, so every pixel of the view is simply
// that pixel of the picture: no stitching, no projected furniture, nothing to go wrong between them. The whitebox
// is still there, only now its job is to hide the player behind things.
const TRIPOD = CAMERAS.a.tripod === true
const pictureMaterial = new THREE.ShaderMaterial({
  uniforms: {
    pictureA: { value: null },
    pictureB: { value: null },
    corridorPlate: { value: null },
    viewA: { value: viewProjection(cameras.a) },
    viewB: { value: viewProjection(cameras.b) },
    viewCorridor: { value: viewProjection(corridorCamera) },
    pictureMix: { value: 0 },
  },
  vertexShader: projectionVertex,
  fragmentShader: `
    uniform sampler2D pictureA, pictureB, corridorPlate;
    uniform mat4 viewA, viewB, viewCorridor;
    uniform float pictureMix;
    varying vec3 vWorld;
    // Just behind the door's face, which stands at DOOR.z - 0.01. Exactly on it, rounding decides for each pixel
    // whether it is door or corridor, and a shut door shows as a scatter of specks.
    const float CORRIDOR_BEGINS = ${(DOOR.z - 0.02).toFixed(2)};
    const float DOOR_WEST = ${(DOOR.x - DOOR.width / 2).toFixed(2)};
    const float DOOR_EAST = ${(DOOR.x + DOOR.width / 2).toFixed(2)};
    const float BEHIND_THE_WALL = ${(DOOR.z - 0.2).toFixed(2)};
    // A fixed camera never looks into the corridor from anywhere but here, and the picture with the door open already
    // shows what it sees from here. A separate picture of the corridor would only cover that one up.
    const bool EXIT_IS_DOOR = ${EXIT_KIND === 'door' && !CAMERAS.a.fixed};
    const float MAX_UV_STEP = 0.012;

    vec2 uvIn(mat4 view) {
      vec4 clip = view * vec4(vWorld, 1.0);
      return clamp(clip.xy / max(clip.w, 0.0001) * 0.5 + 0.5, 0.0, 1.0);
    }

    // Right on the edge of a mesh the screen gradient can come out wild, which would read the blurriest level.
    vec3 read(sampler2D picture, vec2 uv) {
      vec2 alongX = dFdx(uv);
      vec2 alongY = dFdy(uv);
      float steepest = max(length(alongX), length(alongY));
      if (steepest > MAX_UV_STEP) {
        alongX *= MAX_UV_STEP / steepest;
        alongY *= MAX_UV_STEP / steepest;
      }
      return textureGrad(picture, uv, alongX, alongY).rgb;
    }

    void main() {
      vec3 color = mix(read(pictureA, uvIn(viewA)), read(pictureB, uvIn(viewB)), pictureMix);
      if (EXIT_IS_DOOR && vWorld.z < CORRIDOR_BEGINS && ((vWorld.x > DOOR_WEST && vWorld.x < DOOR_EAST) || vWorld.z < BEHIND_THE_WALL)) {
        color = read(corridorPlate, uvIn(viewCorridor));
      }
      gl_FragColor = vec4(color, 1.0);
      #include <colorspace_fragment>
    }
  `,
})

// A picture painted loosely has things that no longer fill their blocks, so a block hiding the player would cut
// them off in thin air, or let a painted table leg show through them. Here a block only says roughly where
// something is and how far away. What hides the player is the paint itself, as the matte outlines it: each
// thing's own piece of the picture is laid back over the player whenever that thing stands in front of them.
const pictureNoDepth = new THREE.ShaderMaterial({ uniforms: pictureMaterial.uniforms, vertexShader: projectionVertex, fragmentShader: pictureMaterial.fragmentShader, depthWrite: false })
// Blur radius. A thing may be painted about twice this far past its block and still count as that thing. Kept small:
// a matte says what is a thing, not which thing, so any further and a table claims the bookcase painted behind it.
const OCCLUDER_REACH_PX = 5
const occluders = {} // camera id → { masks, ctx, texture, key }
const occluderMaterial = new THREE.ShaderMaterial({
  uniforms: {
    pictureA: pictureMaterial.uniforms.pictureA,
    pictureB: pictureMaterial.uniforms.pictureB,
    viewA: pictureMaterial.uniforms.viewA,
    viewB: pictureMaterial.uniforms.viewB,
    pictureMix: pictureMaterial.uniforms.pictureMix,
    maskA: { value: null },
    maskB: { value: null },
    screenToWorld: { value: new THREE.Matrix4() },
  },
  transparent: true,
  depthTest: false,
  depthWrite: false,
  vertexShader: `
    varying vec2 vClip;
    void main() {
      vClip = position.xy;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D pictureA, pictureB, maskA, maskB;
    uniform mat4 viewA, viewB, screenToWorld;
    uniform float pictureMix;
    varying vec2 vClip;
    const float MAX_UV_STEP = 0.012;

    vec3 read(sampler2D picture, vec2 uv) {
      vec2 alongX = dFdx(uv);
      vec2 alongY = dFdy(uv);
      float steepest = max(length(alongX), length(alongY));
      if (steepest > MAX_UV_STEP) {
        alongX *= MAX_UV_STEP / steepest;
        alongY *= MAX_UV_STEP / steepest;
      }
      return textureGrad(picture, uv, alongX, alongY).rgb;
    }

    float onPicture(vec2 uv) {
      return step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    }

    void main() {
      vec4 far = screenToWorld * vec4(vClip, 1.0, 1.0);
      vec4 world = vec4(far.xyz / far.w, 1.0);
      vec4 clipA = viewA * world;
      vec4 clipB = viewB * world;
      vec2 uvA = clipA.xy / max(clipA.w, 0.0001) * 0.5 + 0.5;
      vec2 uvB = clipB.xy / max(clipB.w, 0.0001) * 0.5 + 0.5;
      float alphaA = texture2D(maskA, clamp(uvA, 0.0, 1.0)).a * onPicture(uvA);
      float alphaB = texture2D(maskB, clamp(uvB, 0.0, 1.0)).a * onPicture(uvB);
      gl_FragColor = vec4(mix(read(pictureA, clamp(uvA, 0.0, 1.0)), read(pictureB, clamp(uvB, 0.0, 1.0)), pictureMix), mix(alphaA, alphaB, pictureMix));
      #include <colorspace_fragment>
    }
  `,
})
occluderMesh.material = occluderMaterial

// This thing's own outline in the matte, within reach of its block. The block is drawn with everything else in the
// way, so the part of it another thing hides stays with that other thing.
const BLOCK_REACH_PX = 16 // Blur radius. A patch of a thing's colour has to come about twice this close to its block.
let paintedLabels = null // Kept for the automated checks.

// Which thing each pixel of a colour picture is. Null if this picture does not tell things apart.
function thingLabels(id, blocks) {
  const painted = mattes[id].canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, WIDTH, HEIGHT).data
  if (!isColourMap(painted)) return null
  const near = blocks.map(block => {
    const reach = document.createElement('canvas')
    reach.width = WIDTH
    reach.height = HEIGHT
    const ctx = reach.getContext('2d', { willReadFrequently: true })
    ctx.filter = `blur(${BLOCK_REACH_PX}px)`
    ctx.drawImage(block, 0, 0)
    const { data } = ctx.getImageData(0, 0, WIDTH, HEIGHT)
    const within = new Uint8Array(WIDTH * HEIGHT)
    for (let i = 0; i < within.length; i++) within[i] = data[i * 4 + 3] > 6 ? 1 : 0
    return within
  })
  return labelThings({ pixels: painted, width: WIDTH, height: HEIGHT, things: BLOCKS.length, isNear: (thing, at) => near[thing][at] === 1, blockAt: smallestBlockAt(blocks) })
}

// Which thing's block each pixel is inside, the smallest winning, so a lamp on a table is the lamp.
function smallestBlockAt(blocks) {
  const at = new Int8Array(WIDTH * HEIGHT).fill(-1)
  const footprints = blocks.map((block, index) => {
    const reach = document.createElement('canvas')
    reach.width = WIDTH
    reach.height = HEIGHT
    const ctx = reach.getContext('2d', { willReadFrequently: true })
    ctx.filter = 'blur(2px)' // Blocks are rough, and a thin part has little room for error.
    ctx.drawImage(block, 0, 0)
    const { data } = ctx.getImageData(0, 0, WIDTH, HEIGHT)
    const inside = []
    for (let i = 0; i < at.length; i++) if (data[i * 4 + 3] > 10) inside.push(i)
    return { index, inside }
  })
  for (const { index, inside } of footprints.sort((a, b) => b.inside.length - a.inside.length)) {
    for (const i of inside) at[i] = index
  }
  return at
}

// This thing's pixels as a mask. A hair of softness, or a figure passing behind the edge shows its stair-steps.
function outlineFromLabels(labels, thing) {
  const sharp = document.createElement('canvas')
  sharp.width = WIDTH
  sharp.height = HEIGHT
  const sharpCtx = sharp.getContext('2d')
  const outline = sharpCtx.createImageData(WIDTH, HEIGHT)
  let count = 0
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] !== thing) continue
    outline.data.set([255, 255, 255, 255], i * 4)
    count++
  }
  if (!count) return null
  sharpCtx.putImageData(outline, 0, 0)
  const soft = document.createElement('canvas')
  soft.width = WIDTH
  soft.height = HEIGHT
  const softCtx = soft.getContext('2d')
  softCtx.filter = 'blur(0.7px)'
  softCtx.drawImage(sharp, 0, 0)
  return soft
}

// Where a pixel of the first picture lands on the floor.
const floorRay = new THREE.Vector3()
function pictureToFloor(x, y) {
  floorRay.set(((x + 0.5) / WIDTH) * 2 - 1, 1 - ((y + 0.5) / HEIGHT) * 2, 0.5).unproject(cameras.a).sub(cameras.a.position)
  if (floorRay.y >= -1e-6) return null
  const along = -cameras.a.position.y / floorRay.y
  return { x: cameras.a.position.x + floorRay.x * along, z: cameras.a.position.z + floorRay.z * along }
}

function pictureAtDepth(x, y, z) {
  floorRay.set(((x + 0.5) / WIDTH) * 2 - 1, 1 - ((y + 0.5) / HEIGHT) * 2, 0.5).unproject(cameras.a).sub(cameras.a.position)
  return cameras.a.position.x + floorRay.x * ((z - cameras.a.position.z) / floorRay.z)
}

// The player walks on the room as painted, not as blocked out: a model free to design a bookcase makes it wider and
// deeper than its block, and the player must not stand on what they can see. Marks and the places things can be
// used from move with it. If that would cut anything off, the blocks stand.
function fitCollisionToPaint(labels) {
  const before = BLOCKS.map(({ center, size }) => ({ center: [...center], size: [...size] }))
  const marksBefore = BEATS.map(beat => ({ anchor: beat.anchor ? { ...beat.anchor } : null, target: { ...beat.target } }))
  const spawnBefore = { x: SPAWN.x, z: SPAWN.z }
  BLOCKS.forEach((block, index) => {
    if (block.center[1] - block.size[1] / 2 > 0.05) return // Stands on something else.
    const bounds = boundsFromPaint(block, footprintOf(labels, index, WIDTH, HEIGHT, pictureToFloor, pictureAtDepth, block.center[2] + block.size[2] / 2))
    // Where it can be used from comes forward with it, so it is as far from what the player sees as it ever was.
    const cameForward = bounds.maxZ - (block.center[2] + block.size[2] / 2)
    for (const beat of BEATS) {
      if (Math.hypot(beat.target.x - block.center[0], beat.target.z - block.center[2]) > 0.8) continue
      beat.target.x = (bounds.minX + bounds.maxX) / 2
      beat.target.z += cameForward
    }
    block.center[0] = (bounds.minX + bounds.maxX) / 2
    block.center[2] = (bounds.minZ + bounds.maxZ) / 2
    block.size[0] = bounds.maxX - bounds.minX
    block.size[2] = bounds.maxZ - bounds.minZ
  })
  const walkable = (x, z) => isWalkable(x, z, false)
  const spawn = nearestWalkable(SPAWN, walkable)
  let holds = Boolean(spawn)
  if (spawn) Object.assign(SPAWN, spawn)
  for (const beat of BEATS) {
    if (!beat.anchor) continue
    const mark = nearestWalkable(beat.anchor, walkable)
    if (mark) Object.assign(beat.anchor, mark)
    else holds = false
  }
  if (holds) {
    const reached = reachableFrom(SPAWN, walkable)
    holds = BEATS.every(beat => {
      if (beat.anchor && !reached(beat.anchor)) return false
      const { x, z, radius } = beat.target
      return Array.from({ length: 32 }, (_, turn) => (turn / 32) * Math.PI * 2).some(angle => [1, 0.75, 0.5].some(share => reached({ x: x + Math.cos(angle) * radius * share, z: z + Math.sin(angle) * radius * share })))
    })
  }
  // And the way out has to stay a way out, once the door is open. On the map, every one of them.
  if (holds) holds = JOURNEY
    ? WAYS_OUT.every(way => reachableFrom(SPAWN, walkable)(way.anchor))
    : reachableFrom(SPAWN, (x, z) => isWalkable(x, z, true))(EXIT_KIND === 'door' ? { x: DOOR.x, z: EXIT_Z - 0.1 } : DOOR_ANCHOR)
  if (holds) {
    player = createPlayer(SPAWN)
    return
  }
  log('按画面修正碰撞会挡住路，这一场沿用白模的范围。')
  BLOCKS.forEach((block, index) => {
    block.center.splice(0, 3, ...before[index].center)
    block.size.splice(0, 3, ...before[index].size)
  })
  BEATS.forEach((beat, index) => {
    if (marksBefore[index].anchor) Object.assign(beat.anchor, marksBefore[index].anchor)
    Object.assign(beat.target, marksBefore[index].target)
  })
  Object.assign(SPAWN, spawnBefore)
}

function buildOccluder(id) {
  // Each thing's block as drawn, with black as clear, so it can be cut out of its neighbours' reach.
  const exact = objectMeshes.map(meshes => {
    renderSilhouette(id, meshes)
    const block = document.createElement('canvas')
    block.width = WIDTH
    block.height = HEIGHT
    const ctx = block.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(canvas, 0, 0)
    const pixels = ctx.getImageData(0, 0, WIDTH, HEIGHT)
    for (let i = 0; i < pixels.data.length; i += 4) pixels.data[i + 3] = pixels.data[i]
    ctx.putImageData(pixels, 0, 0)
    return block
  })
  const labels = thingLabels(id, exact)
  const masks = exact.map((block, index) => {
    const coloured = labels && outlineFromLabels(labels, index)
    if (coloured) return coloured
    const mask = document.createElement('canvas')
    mask.width = WIDTH
    mask.height = HEIGHT
    const ctx = mask.getContext('2d', { willReadFrequently: true })
    // A matte that does not tell things apart, or a thing it missed: the block, as far as paint goes.
    ctx.filter = `blur(${OCCLUDER_REACH_PX}px)`
    ctx.drawImage(block, 0, 0)
    ctx.filter = 'none'
    const pixels = ctx.getImageData(0, 0, WIDTH, HEIGHT)
    // The reach is all or nothing: the edge the player sees is the paint's own, from the matte.
    for (let i = 0; i < pixels.data.length; i += 4) {
      pixels.data.set([255, 255, 255, pixels.data[i + 3] > 6 ? 255 : 0], i)
    }
    ctx.putImageData(pixels, 0, 0)
    ctx.globalCompositeOperation = 'destination-out'
    exact.forEach((other, otherIndex) => { if (otherIndex !== index) ctx.drawImage(other, 0, 0) })
    ctx.globalCompositeOperation = 'destination-in'
    ctx.drawImage(mattes[id].canvas, 0, 0, WIDTH, HEIGHT)
    return mask
  })
  paintedLabels = labels
  if (CAMERAS.a.fixed) highlightRings = masks.map(ringAround)
  if (CAMERAS.a.fixed && labels) fitCollisionToPaint(labels)
  const shown = document.createElement('canvas')
  shown.width = WIDTH
  shown.height = HEIGHT
  occluders[id]?.texture.dispose()
  occluders[id] = { masks, ctx: shown.getContext('2d'), texture: new THREE.CanvasTexture(shown), key: null }
  occludersBuilt = TRIPOD && Boolean(occluders.a && occluders.b)
}

// With a fixed view nothing moves to say what can be used, so what is within reach lights up. The painted outline
// of the thing, from its matte, and nothing else: a soft ring just outside the paint.
const HIGHLIGHT_REACH_PX = 3
const HIGHLIGHT_NEAR = 2.2 // Metres from a beat's target to a thing, or the beat is not about that thing.
let highlightRings = []
const highlightMaterial = new THREE.ShaderMaterial({
  uniforms: { ring: { value: null }, strength: { value: 0 } },
  transparent: true,
  depthTest: false,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = position.xy * 0.5 + 0.5;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D ring;
    uniform float strength;
    varying vec2 vUv;
    void main() {
      // A blurred ring is faint at its strongest, and has to read against a dark room.
      float amount = min(1.0, texture2D(ring, vUv).a * 1.8) * strength;
      gl_FragColor = vec4(vec3(1.0, 0.82, 0.55) * amount, amount);
    }
  `,
})
const highlightMesh = new THREE.Mesh(occluderGeometry, highlightMaterial)
highlightMesh.frustumCulled = false
highlightMesh.renderOrder = 1.8 // On the room, and under the player, so it never lies across them.
highlightMesh.visible = false
scene.add(highlightMesh)

function ringAround(mask) {
  const ring = document.createElement('canvas')
  ring.width = WIDTH
  ring.height = HEIGHT
  const ctx = ring.getContext('2d')
  ctx.filter = `blur(${HIGHLIGHT_REACH_PX}px)`
  ctx.drawImage(mask, 0, 0)
  ctx.filter = 'none'
  ctx.globalCompositeOperation = 'destination-out'
  ctx.drawImage(mask, 0, 0)
  return new THREE.CanvasTexture(ring)
}

// Not in a frame a video starts from, and only for something that can actually be done now.
function aimHighlight(live) {
  highlightMesh.visible = false
  if (!live || !highlightRings.length || phase !== 'explore' || viewMode !== 'plate') return
  const spot = story.nearby(player.x, player.z)
  // A way out is not one of the things standing in the room.
  if (!spot?.ready || spot.beat.isExit) return
  const { x, z } = spot.beat.target
  const away = BLOCKS.map(({ center }) => Math.hypot(center[0] - x, center[2] - z))
  const nearest = away.indexOf(Math.min(...away))
  if (away[nearest] > HIGHLIGHT_NEAR) return
  highlightMaterial.uniforms.ring.value = highlightRings[nearest]
  highlightMaterial.uniforms.strength.value = 0.6 + Math.sin(performance.now() / 500) * 0.15
  highlightMesh.visible = true
}

// Compared along the way this camera looks, so what matters is which is nearer in the picture, not in the room.
function standsInFront(block, cameraId) {
  const { position, target } = CAMERAS[cameraId]
  const along = (x, z) => (x - position[0]) * (target[0] - position[0]) + (z - position[2]) * (target[2] - position[2])
  return along(block.center[0], block.center[2]) < along(player.x, player.z)
}

function aimOccluders() {
  for (const id of ['a', 'b']) {
    const occluder = occluders[id]
    const inFront = BLOCKS.flatMap((block, index) => standsInFront(block, id) ? [index] : [])
    const key = inFront.join()
    if (occluder.key === key) continue
    occluder.key = key
    occluder.ctx.clearRect(0, 0, WIDTH, HEIGHT)
    for (const index of inFront) occluder.ctx.drawImage(occluder.masks[index], 0, 0)
    occluder.texture.needsUpdate = true
  }
  occluderMaterial.uniforms.maskA.value = occluders.a.texture
  occluderMaterial.uniforms.maskB.value = occluders.b.texture
  // A prop lying on something in front of the player stays on top of it.
  const under = STAGE_PROP && BLOCKS.find(({ center, size }) => Math.abs(STAGE_PROP.position[0] - center[0]) < size[0] / 2 && Math.abs(STAGE_PROP.position[2] - center[2]) < size[2] / 2 && STAGE_PROP.position[1] > center[1])
  stageProp.renderOrder = under && standsInFront(under, activeCameraId) ? 5 : 1.6
}

// The first picture carried over to the second camera by real geometry. A model given a finished picture to refer
// to copies its composition; given this, the composition is already right and the colours are already that place's,
// and it has only to paint what is rough or missing. What the first camera never saw stays a plain grey.
const draftOf = onFurniture => new THREE.ShaderMaterial({
  uniforms: projectionUniforms(),
  vertexShader: projectionVertex,
  fragmentShader: `
    ${projectionCommon}
    void main() {
      vec2 uvA;
      vec4 a = fromPlate(plateA, depthA, viewProjectionA, vWorld, uvA);
      // A thing's far side takes the colour of its near side. Left grey, it gets painted as a pale strip.
      float known = ${onFurniture ? 'step(0.0, uvA.x) * step(uvA.x, 1.0) * step(0.0, uvA.y) * step(uvA.y, 1.0)' : 'step(0.5, a.a)'};
      vec3 seen = ${onFurniture ? 'textureLod(plateA, clamp(uvA, 0.0, 1.0), 1.0).rgb' : 'a.rgb'};
      gl_FragColor = vec4(mix(vec3(0.42), seen, known), 1.0);
      #include <colorspace_fragment>
    }
  `,
})
const draftRoom = draftOf(false)
const draftThing = draftOf(true)

function renderDraft() {
  const originals = solids.map(mesh => [mesh, mesh.material, mesh.castShadow])
  const saved = { background: scene.background, door: doorPivot.rotation.y }
  for (const material of [draftRoom, draftThing]) {
    material.uniforms.plateA.value = plates.a_closed.texture
    material.uniforms.depthA.value = furnitureDepths.a
  }
  for (const mesh of solids) {
    mesh.material = blockMeshes.includes(mesh) ? draftThing : draftRoom
    mesh.castShadow = false
  }
  setActorVisible(false)
  shadowCatcher.visible = false
  doorPivot.rotation.y = 0
  scene.background = new THREE.Color(0x6b6b6b)
  renderer.render(scene, cameras.b)
  const dataUrl = RELAXED ? draftWithoutSmallHoles() : canvas.toDataURL('image/png')
  scene.background = saved.background
  doorPivot.rotation.y = saved.door
  setActorVisible(true)
  for (const [mesh, material, castShadow] of originals) {
    mesh.material = material
    mesh.castShadow = castShadow
  }
  return dataUrl
}

const UNPAINTED_GREY = 173 // What the draft's grey comes to on screen.
const LARGEST_SMALL_HOLE = WIDTH * HEIGHT * 0.04 // A lamp and the gap under its table can join up, and are still not a wall.

function draftWithoutSmallHoles() {
  const copy = document.createElement('canvas')
  copy.width = WIDTH
  copy.height = HEIGHT
  const ctx = copy.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(canvas, 0, 0)
  const picture = ctx.getImageData(0, 0, WIDTH, HEIGHT)
  const isGrey = (pixels, at) => Math.abs(pixels[at] - UNPAINTED_GREY) < 14 && Math.abs(pixels[at + 1] - UNPAINTED_GREY) < 14 && Math.abs(pixels[at + 2] - UNPAINTED_GREY) < 14
  fillSmallHoles(picture.data, WIDTH, HEIGHT, isGrey, LARGEST_SMALL_HOLE)
  ctx.putImageData(picture, 0, 0)
  return copy.toDataURL('image/png')
}

// A door swings, so it carries its own picture. A way out painted on the wall is just more wall: taking it from a
// different picture than the wall around it would show as a rectangle.
const leafMaterial = () => (EXIT_KIND === 'door' ? doorLeafMaterial : roomMaterial)

function aimProjection() {
  if (TRIPOD) {
    const picture = pictureMaterial.uniforms
    picture.pictureA.value = plates[doorOpen ? 'a_open' : 'a_closed'].texture
    picture.pictureB.value = plates.b.texture
    picture.corridorPlate.value = (plates.corridor ?? plates.a_closed).texture
    picture.pictureMix.value = viewPlateMix()
    return
  }
  const room = roomMaterial.uniforms
  room.plateA.value = plates.a_empty.texture
  room.plateB.value = plates.b_empty?.texture ?? null
  room.depthA.value = roomDepths.a
  room.depthB.value = roomDepths.b
  room.corridorPlate.value = (plates.corridor ?? plates.a_closed).texture
  room.finishedA.value = plates[doorOpen ? 'a_open' : 'a_closed'].texture

  const furniture = furnitureMaterial.uniforms
  furniture.plateA.value = furniturePaint.a
  furniture.plateB.value = furniturePaint.b ?? null
  furniture.depthA.value = furnitureDepths.a
  furniture.depthB.value = furnitureDepths.b
  furniture.fitA.value = furnitureFits.a
  furniture.fitB.value = furnitureFits.b

  const door = doorLeafMaterial.uniforms
  door.closedPlate.value = plates.a_closed.texture
  door.angle.value = doorOpen ? DOOR_OPEN_ANGLE : 0
}

// The second camera's view of what the first picture already holds. The image model is shown this,
// so what it adds belongs with what is there, and it can only add to the places marked for it.
function renderSecondCameraGuide({ holes = false, hideFurniture = false, unpainted = [] }) {
  const clay = new Set(unpainted)
  const originals = solids.map(mesh => [mesh, mesh.material, mesh.visible, mesh.castShadow])
  const saved = { background: scene.background, door: doorPivot.rotation.y }
  aimProjection()
  roomMaterial.uniforms.showHoles.value = holes ? 1 : 0
  for (const mesh of solids) {
    const isObject = isFurniture.has(mesh)
    mesh.material = mesh === doorLeaf ? leafMaterial()
      : clay.has(mesh) ? clayMaterial
      : isObject ? furnitureMaterial
      : roomMaterial
    mesh.visible = !(hideFurniture && isObject)
    mesh.castShadow = false
  }
  setActorVisible(false)
  shadowCatcher.visible = false
  doorPivot.rotation.y = 0
  hemisphere.color.set(0xffffff)
  hemisphere.intensity = 1.5
  sun.intensity = 2.2
  scene.background = new THREE.Color(0x000000)
  renderer.render(scene, cameras.b)
  const dataUrl = canvas.toDataURL('image/png')
  roomMaterial.uniforms.showHoles.value = 0
  scene.background = saved.background
  doorPivot.rotation.y = saved.door
  setActorVisible(true)
  for (const [mesh, material, visible, castShadow] of originals) {
    mesh.material = material
    mesh.visible = visible
    mesh.castShadow = castShadow
  }
  return dataUrl
}

// The figure takes its brightness from the plate around its feet, so it sits in the room's light.
const footPoint = new THREE.Vector3()
function lightAtFeet(plate, cameraId) {
  footPoint.set(player.x, 0.6, player.z).project(cameras[cameraId])
  const px = Math.min(63, Math.max(0, Math.round((footPoint.x * 0.5 + 0.5) * 63)))
  const py = Math.min(35, Math.max(0, Math.round((0.5 - footPoint.y * 0.5) * 35)))
  // A few cells around the feet: in a picture with real light and shadow, one cell can be a single dark gap.
  const cells = RELAXED
    ? [-1, 0, 1].flatMap(dy => [-1, 0, 1].map(dx => ((Math.min(35, Math.max(0, py + dy)) * 64 + Math.min(63, Math.max(0, px + dx))) * 4)))
    : [(py * 64 + px) * 4]
  return [0, 1, 2].map(channel => cells.reduce((sum, at) => sum + plate.pixels[at + channel], 0) / cells.length)
}

const FIGURE_LIGHT_RATE = 0.12 // Share of the way per drawn frame, so walking through a pool of light is a change and not a flicker.
let figureLight = null

function figureInPictureLight(sample) {
  const wanted = figureTint(sample)
  figureLight = framing || !figureLight ? wanted : figureLight.map((value, i) => value + (wanted[i] - value) * FIGURE_LIGHT_RATE)
  spriteMaterial.color.setRGB(...figureLight)
  outgoingMaterial.color.setRGB(...figureLight)
  const shadow = shadowFrom(GLOWS, player.x, player.z)
  if (!shadow) return
  sun.target.position.set(player.x, 0, player.z)
  sun.position.set(player.x + shadow.offset[0], shadow.offset[1], player.z + shadow.offset[2])
  // A flat figure's cast shadow only holds up from far away. Close to, with one camera, the contact shadow does the work.
  shadowCatcher.material.opacity = shadow.opacity * (CAMERAS.a.fixed ? 0.35 : 1)
}

function matchLightToPlate(sample) {
  if (RELAXED) figureInPictureLight(sample)
  const [r, g, b] = sample
  const brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  const level = 0.45 + brightness * 1.5
  hemisphere.color.setRGB(r / 255 * 0.6 + 0.4, g / 255 * 0.6 + 0.4, b / 255 * 0.6 + 0.4)
  hemisphere.intensity = 1.1 * level
  sun.intensity = 1.5 * level
  if (RELAXED) return
  // A drawn character already has its own light, so it only takes a tint from the room.
  const tint = 0.55 + 0.45 * Math.min(1, level)
  spriteMaterial.color.setRGB(tint * (r / 255 * 0.3 + 0.7), tint * (g / 255 * 0.3 + 0.7), tint * (b / 255 * 0.3 + 0.7))
}

const platesReady = () => (TRIPOD
  ? ['a_closed', 'a_open', 'b', ...(EXIT_KIND === 'door' && !CAMERAS.a.fixed ? ['corridor'] : [])].every(id => plates[id])
  : ['a_closed', 'a_open', 'b', 'a_empty', 'b_empty', ...(EXIT_KIND === 'door' ? ['corridor'] : [])].every(id => plates[id]) && mattes.a && mattes.b)
const isFurniture = new Set(blockMeshes)

function applyView(fromPlateCamera) {
  const projected = viewMode === 'plate' && !fromPlateCamera && platesReady()
  for (const mesh of solids) {
    const projectedOnto = TRIPOD ? (occludersBuilt && isFurniture.has(mesh) ? pictureNoDepth : pictureMaterial)
      : mesh === doorLeaf ? leafMaterial()
      : isFurniture.has(mesh) ? furnitureMaterial
      : roomMaterial
    mesh.material = projected ? projectedOnto : mesh.userData.clay
    // The plate holds the room's own shadows; in clay, the tall walls would only blacken the guide.
    mesh.castShadow = !projected && mesh.userData.castsInClay === true
  }
  shadowCatcher.visible = projected
  scene.background = clayBackground
  if (projected) {
    aimProjection()
    const a = lightAtFeet(plates[doorOpen ? 'a_open' : 'a_closed'], 'a')
    const b = lightAtFeet(plates.b, 'b')
    matchLightToPlate(a.map((value, i) => value + (b[i] - value) * viewPlateMix()))
  } else {
    hemisphere.color.set(0xffffff)
    hemisphere.intensity = 1.5
    sun.intensity = 2.2
    spriteMaterial.color.set(0xffffff)
    if (RELAXED) {
      // The whitebox guides were lit one way, and stay lit that way whatever the player's last shadow was doing.
      sun.position.set(-4, 7, 5)
      sun.target.position.set(0, 0, 0)
    }
  }
  atmosphere?.show({ live: !framing && !jobId, plate: projected })
}

// Pass a plate's camera to draw the whitebox as that plate's guide; otherwise this is the player's view.
function draw(plateCamera = null) {
  if (!plateCamera) aimViewCamera()
  applyView(Boolean(plateCamera))
  const viewer = plateCamera ?? viewCamera
  const basis = plateCamera ? bases[activeCameraId] : cameraBasis(viewPose())
  setActorVisible(actorVisible)
  stageProp.material = viewMode === 'plate' ? propMaterial : clayMaterial
  if (occluderMesh.visible) {
    aimOccluders()
    occluderMaterial.uniforms.screenToWorld.value.multiplyMatrices(viewer.projectionMatrix, viewer.matrixWorldInverse).invert()
  }
  aimHighlight(!plateCamera && !framing && actorVisible)
  if (showsRenderedCharacter()) poseSprite(player, viewer, basis)
  else poseFigure(player)
  doorPivot.rotation.y = doorOpen ? DOOR_OPEN_ANGLE : 0
  renderer.render(scene, viewer)
}

// ---------------------------------------------------------------- game loop
const held = new Set()
const directionHold = createDirectionHold()
let phase = 'explore' // title | explore | approach | clip | finished
let settleTimer = 0
// Where the player has got to, for a place on the map. Each place is its own page, and the address says what they bring.
const startingAt = new URLSearchParams(location.search)
const broughtProgress = () => {
  try {
    return JSON.parse(startingAt.get('journey') ?? 'null')
  } catch {
    return null
  }
}
// Trying one place out on the whitebox page: it stays that place, whatever is done in it.
const rehearsing = Boolean(JOURNEY) && startingAt.get('view') === 'clay'
let story = createStory(rehearsing ? rehearsalProgress() : broughtProgress())
const firstVisit = Boolean(JOURNEY) && !story.progress.seen.includes(SCENE_ID)
if (JOURNEY) story.arrived()
let performing = null // The beat being walked to or performed.
const clips = {} // clip id → its loaded video

function updateCamera() {
  if (activeCameraId === 'a' && player.x > CAMERA_SWITCH.toB) activeCameraId = 'b'
  else if (activeCameraId === 'b' && player.x < CAMERA_SWITCH.toA) activeCameraId = 'a'
}

// The studio says what the end of this scene means. Opened on its own, the scene is the whole film.
const FINISHED_LINE = new URLSearchParams(location.search).get('finish') ?? `《${TITLE}》完。按 R 重来。`

function updatePrompt() {
  const spot = phase === 'explore' ? story.nearby(player.x, player.z) : null
  objectiveEl.textContent = phase === 'finished' ? FINISHED_LINE : `目标：${story.objective}`
  promptEl.textContent = !spot ? '' : spot.ready ? spot.beat.prompt : '按 E 查看'
  updateItems()
}

// Where the view has to settle for this beat's video to start from the picture on screen.
const shotFor = beat => shotPose(CAMERAS[beat.camera], beat.anchor, SHOT_DISTANCE)
const firstView = () => solvePose(CAMERAS.a, SPAWN)

function interact() {
  if (phase !== 'explore') return
  const spot = story.nearby(player.x, player.z)
  if (!spot) return
  if (!spot.ready) {
    storyEl.textContent = spot.beat.tooEarly
  } else if (spot.beat.isExit) {
    goThrough(spot.beat)
  } else if (spot.beat.clip) {
    performing = spot.beat
    phase = 'approach'
    settleTimer = 0
  } else {
    finishBeat(spot.beat)
  }
}

// Going to another place on the map. Each place is a page of its own, so what happens next is the page around this one's.
function goThrough(exit) {
  if (rehearsing) {
    storyEl.textContent = `这里通向${JOURNEY.places[exit.to]?.title ?? '别处'}。`
    return
  }
  phase = 'title'
  sound.fadeRoom(0, 0.4)
  tellOutside({ type: 'travel', to: exit.to, from: SCENE_ID, progress: story.progress })
}

function tellOutside(message) {
  if (rehearsing) {
    if (message.type === 'restart') location.reload()
    return undefined
  }
  if (parent !== window) return parent.postMessage(message, '*')
  // Opened on its own, with nobody around it to say where to go next.
  if (message.to) location.href = `../${message.to}/?${new URLSearchParams({ journey: JSON.stringify(message.progress), from: message.from ?? '' })}`
  else if (message.type === 'restart') location.search = ''
  return undefined
}

function finishBeat(beat) {
  const result = story.complete(beat.id)
  propOnStage = Boolean(STAGE_PROP) && story.propOnStage
  if (JOURNEY) {
    tellOutside({ type: result.chapterEnded ? 'chapter-finished' : 'progress', storyEnded: result.storyEnded, progress: story.progress })
    if (beat.after) storyEl.textContent = beat.after
    return result
  }
  if (beat.opensDoor || (EXIT_KIND !== 'door' && story.objective === LAST_OBJECTIVE)) doorOpen = true
  if (beat.after) storyEl.textContent = beat.after
}

function reset() {
  // A performance cannot be interrupted: its video is on screen and the game is waiting for it.
  if (phase === 'clip' || phase === 'title') return
  if (JOURNEY) {
    tellOutside({ type: 'restart' })
    return
  }
  sound.fadeRoom(1)
  player = createPlayer(SPAWN)
  forgetPose()
  doorOpen = false
  activeCameraId = 'a'
  follow.snapTo(firstView(), 'a')
  phase = 'explore'
  performing = null
  story = createStory()
  propOnStage = Boolean(STAGE_PROP) && story.propOnStage
  canvas.style.visibility = ''
  storyEl.textContent = OPENING
  held.clear()
  log('已重置。')
}

const STUCK_SECONDS = 0.5
const LEG_REACHED = 0.3 // Metres. Close enough to a turn in the route to go on to the next, without stopping for it.
let stuckFor = 0
let approachFor = null
let approachLegs = []

function update(dt) {
  atmosphere?.update(dt)
  outgoingLeft = Math.max(0, outgoingLeft - dt)
  const walkedFrom = [player.x, player.z]
  if (phase === 'explore') {
    stepPlayer(player, directionHold.resolve(held, cameraBasis(follow.pose)), dt, doorOpen)
    updateCamera()
    const leaving = EXIT_KIND === 'door' ? player.z < EXIT_Z : Math.hypot(player.x - DOOR_ANCHOR.x, player.z - DOOR_ANCHOR.z) < EXIT_REACH
    if (!JOURNEY && doorOpen && leaving) {
      performing = LAST_SHOT
      phase = 'approach'
      settleTimer = 0
    }
  } else if (phase === 'finished') {
    stepPlayer(player, { x: 0, z: 0 }, dt, doorOpen)
  } else if (phase === 'approach') {
    const walkedFromX = player.x
    const walkedFromZ = player.z
    // Round whatever stands in the way. Straight at the mark would only walk into it.
    if (RELAXED && approachFor !== performing) {
      approachFor = performing
      approachLegs = findRoute(player, performing.anchor, (x, z) => isWalkable(x, z, doorOpen)) ?? []
    }
    while (approachLegs.length > 1 && Math.hypot(player.x - approachLegs[0].x, player.z - approachLegs[0].z) < LEG_REACHED) approachLegs.shift()
    const onAWayThere = RELAXED && approachLegs.length > 1
    if (onAWayThere) stepToward(player, { ...approachLegs[0], yaw: player.yaw }, dt, doorOpen)
    let arrived = onAWayThere ? false : stepToward(player, performing.anchor, dt, doorOpen)
    // The walk to a mark is a straight line, and a thing painted bigger than its block can stand across it.
    stuckFor = Math.hypot(player.x - walkedFromX, player.z - walkedFromZ) < 0.1 * dt && !arrived && Math.hypot(player.x - performing.anchor.x, player.z - performing.anchor.z) > 0.2 ? stuckFor + dt : 0
    if (RELAXED && stuckFor > STUCK_SECONDS) {
      Object.assign(player, performing.anchor, { vx: 0, vz: 0, gait: 0 })
      stuckFor = 0
      arrived = true
    }
    updateCamera()
    // Standing on the mark, the shot's own camera is the one that counts, or the view could wait for it forever.
    if (arrived) activeCameraId = performing.camera
    // The clip was made from this framing, so the view has to be there before it starts.
    settleTimer = arrived && follow.isAt(shotFor(performing), performing.camera) ? settleTimer + dt : 0
    if (settleTimer > 0.1) perform(performing)
  }
  if (phase === 'explore' || phase === 'approach') {
    const steps = footfalls.advance(Math.hypot(player.x - walkedFrom[0], player.z - walkedFrom[1]), sprites.e?.stepMeters ?? 0.6)
    if (steps > 0) sound.footstep()
  }
  if (phase !== 'clip') follow.update(player, activeCameraId, dt, phase === 'approach' ? shotFor(performing) : null)
  // A film has no controls, and the title screen has nothing to control yet.
  hud.update({ visible: phase === 'explore' || phase === 'approach', held, pose: follow.pose, playerYaw: player.yaw, dt })
  updatePrompt()
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function fadeClip(video, to, duration = CROSSFADE_MS) {
  return video.animate([{ opacity: to ? 0 : 1 }, { opacity: to }], { duration, fill: 'forwards', easing: 'linear' }).finished
}

let nowPlaying = null

async function standOnFirstFrame(video) {
  if (video.currentTime === 0) return
  video.currentTime = 0
  await new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }))
}

async function playToEnd(video) {
  const ended = new Promise(resolve => video.addEventListener('ended', resolve, { once: true }))
  nowPlaying = video
  try {
    await video.play()
  } catch (error) {
    // The browser refused sound. Better a silent film than none.
    if (error.name !== 'NotAllowedError') throw error
    log('浏览器不允许出声，这段视频静音播放。')
    video.muted = true
    await video.play()
  }
  await ended
  nowPlaying = null
}

async function perform(beat) {
  approachFor = null
  // Same exact pose every time: the frame the video starts from is the frame on screen.
  player = createPlayer(beat.anchor)
  activeCameraId = beat.camera
  forgetPose()
  follow.snapTo(shotFor(beat), beat.camera)
  draw()
  phase = 'clip'
  storyEl.textContent = beat.during
  const video = clips[beat.clip]
  // The last shot fades out to nothing, and the room with it.
  if (beat.isEnding) sound.fadeRoom(0, video ? video.duration : 1)
  if (video) {
    // The video is softer than the live picture, and only a fade hides that. Fading while it stands
    // on its first frame means nothing moves during the fade, so nothing shows double.
    await standOnFirstFrame(video)
    await fadeClip(video, 1)
    const subtitles = () => { storyEl.textContent = beat.speech?.find(line => video.currentTime >= line.from && video.currentTime < line.to)?.text ?? beat.during ?? '' }
    if (beat.speech) video.addEventListener('timeupdate', subtitles)
    await playToEnd(video)
    video.removeEventListener('timeupdate', subtitles)
  } else {
    log(`还没有视频 ${beat.clip}：跳过表演。`)
  }
  performing = null
  if (beat.isEnding) {
    // The film ends on black. There is nothing to come back to.
    if (!rehearsing) canvas.style.visibility = 'hidden'
    if (video) await fadeClip(video, 0, ENDING_FADE_MS)
    if (rehearsing) {
      story.complete(beat.id)
      storyEl.textContent = '这一章在这里结束。'
      phase = 'explore'
      return
    }
    if (JOURNEY) {
      // A chapter ends on black too, and the page around this one says what comes next.
      const { storyEnded } = story.complete(beat.id)
      phase = storyEnded ? 'finished' : 'title'
      log(storyEnded ? '剧情结束。' : '这一章结束。')
      tellOutside({ type: 'chapter-finished', storyEnded, progress: story.progress })
      return
    }
    phase = 'finished'
    log('剧情结束。')
    parent.postMessage({ type: 'scene-finished' }, '*')
    return
  }
  finishBeat(beat)
  draw()
  if (video) await fadeClip(video, 0)
  phase = 'explore'
}

// The film opens by itself and ends on the picture the player then walks on from.
async function playOpening() {
  const video = clips.opening
  if (!video || viewMode !== 'plate') return
  phase = 'clip'
  await fadeClip(video, 1, 0)
  await playToEnd(video)
  draw()
  await fadeClip(video, 0)
  phase = 'explore'
}

let last = performance.now()
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  update(dt)
  if (phase !== 'clip') draw()
  requestAnimationFrame(frame)
}

addEventListener('keydown', event => {
  sound.start()
  // Typing a key or a model name must not walk the player around.
  if (event.target instanceof HTMLInputElement) return
  if (isMoveKey(event.code)) {
    event.preventDefault()
    held.add(event.code)
  } else if (event.code === 'KeyE') {
    interact()
  } else if (event.code === 'Space' && nowPlaying) {
    event.preventDefault()
    nowPlaying.currentTime = nowPlaying.duration
  } else if (event.code === 'KeyV') {
    toggleView()
  } else if (event.code === 'KeyR') {
    reset()
  }
})
addEventListener('keyup', event => held.delete(event.code))
addEventListener('blur', () => held.clear())

function lookWithMouse(dx, dy) {
  if (phase !== 'explore' && phase !== 'finished') return
  follow.turn(dx * MOUSE_RADIANS_PER_PIXEL, dy * MOUSE_RADIANS_PER_PIXEL)
  hud.nudge(dx, dy)
  directionHold.rebase()
}

// Some embedded browsers refuse the lock. Dragging on the picture does the same job there.
if (!CAMERAS.a.fixed) canvas.addEventListener('click', () => canvas.requestPointerLock()?.catch?.(() => {}))
document.addEventListener('mousemove', event => {
  const dragging = event.target === canvas && event.buttons & 1
  if (document.pointerLockElement === canvas || dragging) lookWithMouse(event.movementX, event.movementY)
})

function toggleView() {
  viewMode = viewMode === 'clay' ? 'plate' : 'clay'
  if (viewMode === 'plate' && !platesReady()) {
    viewMode = 'clay'
    log('还没有生成底图。')
  }
}

document.getElementById('toggle').addEventListener('click', event => { toggleView(); event.target.blur() })
document.getElementById('reset').addEventListener('click', event => { reset(); event.target.blur() })

// ---------------------------------------------------------------- pipeline
const save = async (name, dataUrl) => (await fetch('api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, dataUrl }) })).json()

// Everything is posed explicitly, so a capture never depends on where the player happens to be.
async function capture(name, { camera, open, view, withPlayer, empty = false }) {
  const saved = { viewMode, doorOpen, activeCameraId, player }
  viewMode = view
  doorOpen = open
  activeCameraId = camera
  player = createPlayer(DOOR_ANCHOR)
  setActorVisible(withPlayer)
  blockMeshes.forEach(mesh => { mesh.visible = !empty })
  draw(cameras[camera])
  shadowCatcher.visible = withPlayer && view === 'plate'
  renderer.render(scene, cameras[camera])
  const dataUrl = canvas.toDataURL('image/png')
  ;({ viewMode, doorOpen, activeCameraId, player } = saved)
  setActorVisible(true)
  blockMeshes.forEach(mesh => { mesh.visible = true })
  return save(name, dataUrl)
}

const meshesPaintedBy = id => objectMeshes.filter((_, index) => paintedBy(BLOCKS[index]) === id).flat()

async function exportGuides() {
  await capture('clay_a_closed.png', { camera: 'a', open: false, view: 'clay', withPlayer: false })
  await capture('clay_a_open.png', { camera: 'a', open: true, view: 'clay', withPlayer: false })
  await capture('clay_b.png', { camera: 'b', open: false, view: 'clay', withPlayer: false })
  await capture('clay_a_empty.png', { camera: 'a', open: false, view: 'clay', withPlayer: false, empty: true })
  await capture('clay_b_empty.png', { camera: 'b', open: false, view: 'clay', withPlayer: false, empty: true })
  await save('clay_corridor.png', renderCorridorGuide())
  renderSilhouette('a', blockMeshes, true)
  await save('clay_a_mask.png', canvas.toDataURL('image/png'))
  // The second camera's picture only adds the objects that are painted from it.
  renderSilhouette('b', meshesPaintedBy('b'), true)
  await save('clay_b_mask.png', canvas.toDataURL('image/png'))
  // A second picture painted whole needs to know where everything goes, not just what only it can see.
  renderSilhouette('b', blockMeshes, true)
  await save('clay_b_full_mask.png', canvas.toDataURL('image/png'))
  await save('door_mask.png', renderDoorMask())
  log('白模引导图已导出。')
}

// The corridor alone, with everything between it and this camera taken away.
function renderCorridorGuide() {
  const savedView = viewMode
  viewMode = 'clay'
  applyView(true)
  setActorVisible(false)
  const shown = new Set([...corridorMeshes, floor])
  const originals = solids.map(mesh => [mesh, mesh.visible])
  for (const mesh of solids) mesh.visible = shown.has(mesh)
  renderer.render(scene, corridorCamera)
  const dataUrl = canvas.toDataURL('image/png')
  for (const [mesh, visible] of originals) mesh.visible = visible
  viewMode = savedView
  setActorVisible(true)
  return dataUrl
}

// White where these meshes show from this plate's camera, black everywhere else. As a guide for the
// image model it also marks the floor and the door, so the room's own lines stay put too.
function renderSilhouette(cameraId, white, asGuide = false) {
  const shown = new Set(white)
  const originals = solids.map(mesh => [mesh, mesh.material, mesh.visible])
  const saved = { background: scene.background, door: doorPivot.rotation.y }
  for (const mesh of solids) {
    mesh.material = shown.has(mesh) ? maskWhite
      : asGuide && mesh === floor ? guideFloor
      : asGuide && mesh === doorLeaf ? guideDoor
      : maskBlack
    mesh.visible = true
  }
  setActorVisible(false)
  shadowCatcher.visible = false
  doorPivot.rotation.y = 0
  scene.background = new THREE.Color(0x000000)
  renderer.render(scene, cameras[cameraId])
  scene.background = saved.background
  doorPivot.rotation.y = saved.door
  setActorVisible(true)
  for (const [mesh, material, visible] of originals) {
    mesh.material = material
    mesh.visible = visible
  }
}

// Where each object shows from this plate's camera, as seen with everything else in the way.
function objectMasks(cameraId) {
  const reader = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  reader.canvas.width = WIDTH
  reader.canvas.height = HEIGHT
  return objectMeshes.map(meshes => {
    renderSilhouette(cameraId, meshes)
    reader.drawImage(canvas, 0, 0)
    const { data } = reader.getImageData(0, 0, WIDTH, HEIGHT)
    const mask = new Uint8Array(WIDTH * HEIGHT)
    for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4] > 127 ? 1 : 0
    return (x, y) => mask[y * WIDTH + x] === 1
  })
}

// How well each painted object fills its whitebox outline, from 0 to 1, per plate.
function measureSilhouettes() {
  const result = {}
  for (const id of ['a', 'b']) {
    const masks = objectMasks(id)
    result[id] = {}
    BLOCKS.forEach((block, index) => {
      if (paintedBy(block) !== id) return
      const overlap = silhouetteOverlap({
        width: WIDTH,
        height: HEIGHT,
        inWhitebox: masks[index],
        isPainted: mattes[id].isObject,
        isOther: (x, y) => masks.some((mask, other) => other !== index && mask(x, y)),
      })
      if (overlap !== null) result[id][block.name] = Number(overlap.toFixed(3))
    })
  }
  return result
}

function renderDoorMask() {
  const originals = solids.map(mesh => [mesh, mesh.material, mesh.visible])
  const saved = { background: scene.background }
  for (const mesh of solids) {
    mesh.material = maskBlack
    mesh.visible = mesh !== doorLeaf
  }
  setActorVisible(false)
  shadowCatcher.visible = false
  scene.background = new THREE.Color(0x000000)
  doorOpeningMask.visible = true
  renderer.render(scene, cameras.a)
  const dataUrl = canvas.toDataURL('image/png')
  doorOpeningMask.visible = false
  scene.background = saved.background
  setActorVisible(true)
  for (const [mesh, material, visible] of originals) {
    mesh.material = material
    mesh.visible = visible
  }
  return dataUrl
}

// The model will drift somewhere, however it is told. Taking only the doorway from the
// "open" picture guarantees the rest of the room does not move when the door opens.
async function blendOpenPlate() {
  const [closed, open, mask] = await Promise.all(['plate_a_closed', 'plate_a_open_raw', 'door_mask'].map(name => loadImage(`assets/${name}.png`)))
  const out = document.createElement('canvas')
  out.width = closed.naturalWidth
  out.height = closed.naturalHeight
  const scale = out.width / WIDTH

  const alpha = document.createElement('canvas')
  alpha.width = out.width
  alpha.height = out.height
  const alphaCtx = alpha.getContext('2d')
  alphaCtx.filter = `blur(${5 * scale}px)`
  alphaCtx.drawImage(mask, 0, 0, out.width, out.height)
  const pixels = alphaCtx.getImageData(0, 0, out.width, out.height)
  for (let i = 0; i < pixels.data.length; i += 4) {
    // Growing the blurred mask pushes the seam outward onto the door frame.
    pixels.data[i + 3] = Math.min(255, pixels.data[i] * 2.4)
  }
  alphaCtx.putImageData(pixels, 0, 0)

  const layer = document.createElement('canvas')
  layer.width = out.width
  layer.height = out.height
  const layerCtx = layer.getContext('2d')
  layerCtx.drawImage(open, 0, 0, out.width, out.height)
  layerCtx.globalCompositeOperation = 'destination-in'
  layerCtx.drawImage(alpha, 0, 0)

  const ctx = out.getContext('2d')
  ctx.drawImage(closed, 0, 0, out.width, out.height)
  ctx.drawImage(layer, 0, 0)
  await save('plate_a_open.png', out.toDataURL('image/png'))
}

// Mean absolute difference per channel on a 0–255 scale. Below about 8 is hard to see in a crossfade.
function pixelsOf(source, width = 640, height = 360) {
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0, width, height)
  return ctx.getImageData(0, 0, width, height).data
}

function meanDifference(a, b) {
  const pa = pixelsOf(a)
  const pb = pixelsOf(b)
  let total = 0
  for (let i = 0; i < pa.length; i += 4) total += Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2])
  return total / ((pa.length / 4) * 3)
}

function edgeMap(source, width = 320, height = 180) {
  const pixels = pixelsOf(source, width, height)
  const gray = new Float32Array(width * height)
  for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * pixels[i * 4] + 0.587 * pixels[i * 4 + 1] + 0.114 * pixels[i * 4 + 2]
  const magnitude = new Float32Array(width * height)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      magnitude[i] = Math.hypot(gray[i + 1] - gray[i - 1], gray[i + width] - gray[i - width])
    }
  }
  const sorted = Float32Array.from(magnitude).sort()
  const threshold = Math.max(4, sorted[Math.floor(sorted.length * 0.9)])
  return { edges: magnitude.map(value => value >= threshold ? 1 : 0), width, height }
}

// Share of the whitebox's outlines that have an outline in the plate within 3px of 320×180.
function outlineAgreement(clay, plate) {
  const a = edgeMap(clay)
  const b = edgeMap(plate)
  const R = 3
  let matched = 0
  let total = 0
  for (let y = R; y < a.height - R; y++) {
    for (let x = R; x < a.width - R; x++) {
      if (!a.edges[y * a.width + x]) continue
      total++
      search: for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          if (b.edges[(y + dy) * a.width + x + dx]) { matched++; break search }
        }
      }
    }
  }
  return total ? matched / total : 0
}

// The film opens close on the scene's first subject, from the plate's own camera through a long lens.
const OPENING_POSE = { position: [...CAMERAS.a.position], target: OPENING_SHOT.target, fov: OPENING_SHOT.fov }

// Every video in the film and the pictures it has to start and end on. Only the door changes the
// room, and the last shot runs on to black, so it has no picture to end on.
function filmShots() {
  const room = { camera: 'a', mark: SPAWN, open: false, note: true }
  return [
    { clip: 'opening', first: { ...room, pose: OPENING_POSE }, last: { ...room, pose: firstView() } },
    ...BEATS.filter(beat => beat.clip).map(beat => {
      const start = { camera: beat.camera, mark: beat.anchor, open: false, note: false, pose: shotFor(beat) }
      // The first beat picks up what lies out on its object, so its shot starts with it there and ends with it gone.
      const first = beat === BEATS[0] ? { ...start, note: true } : start
      // The step a chapter closes on runs on to black, like the last shot of a film.
      return { clip: beat.clip, first, ...(beat.isEnding ? {} : { last: { ...start, open: Boolean(beat.opensDoor) } }) }
    }),
    ...(JOURNEY ? [] : [{ clip: LAST_SHOT.clip, first: { camera: LAST_SHOT.camera, mark: LAST_SHOT.anchor, open: true, note: false, pose: shotFor(LAST_SHOT) } }]),
  ]
}

async function captureFrame(name, { camera, mark, open, note, pose }) {
  const saved = { viewMode, doorOpen, activeCameraId, player, propOnStage }
  viewMode = 'plate'
  doorOpen = open
  activeCameraId = camera
  player = createPlayer(mark)
  propOnStage = Boolean(STAGE_PROP) && note
  framing = { pose, plateMix: camera === 'b' ? 1 : 0 }
  setActorVisible(true)
  draw()
  const dataUrl = canvas.toDataURL('image/png')
  framing = null
  ;({ viewMode, doorOpen, activeCameraId, player, propOnStage } = saved)
  setActorVisible(true)
  return save(name, dataUrl)
}

// True if a picture differs from the one the clip was last made from.
async function captureClipFrames(shot) {
  const start = await captureFrame(`frame_${shot.clip}_first.png`, shot.first)
  if (!shot.last) return start.changed
  const end = await captureFrame(`frame_${shot.clip}_last.png`, shot.last)
  return start.changed || end.changed
}

// On the map a place is loaded every time it is come back to, so only what can still be played here.
const comingUp = clip => !JOURNEY || (clip === 'opening' ? firstTimeHere() : !story.progress.done.includes(`${SCENE_ID}/${clip}`))
const firstTimeHere = () => firstVisit

async function loadClips() {
  for (const { clip: id } of filmShots().filter(shot => comingUp(shot.clip))) {
    if (!(await assetExists(`${id}.mp4`))) continue
    const video = document.createElement('video')
    video.playsInline = true
    video.preload = 'auto'
    // Held whole in memory, so it can seek without the server's help and a cut never waits on the network.
    const whole = await (await fetch(`assets/${id}.mp4?t=${Date.now()}`)).blob()
    await new Promise((resolve, reject) => {
      video.addEventListener('canplaythrough', resolve, { once: true })
      video.addEventListener('error', () => reject(new Error(`视频 ${id} 无法播放`)), { once: true })
      video.src = URL.createObjectURL(whole)
      video.load()
    })
    if (clips[id]) URL.revokeObjectURL(clips[id].src)
    clips[id]?.remove()
    clips[id] = video
    stage.append(video)
  }
}

// Everything the server cannot draw by itself. Each job gets a fresh page, so nothing can leak from
// one to the next, and the page saves what it draws through the same scene-scoped address as the game.
const JOBS = {
  guides: () => exportGuides(),
  draftB: () => save('guide_b_draft.png', renderDraft()),
  guideRoom: () => save('guide_b_room.png', renderSecondCameraGuide({ holes: true, hideFurniture: true })),
  guideFurniture: () => save('guide_b_furniture.png', renderSecondCameraGuide({ unpainted: meshesPaintedBy('b') })),
  blendOpen: () => blendOpenPlate(),
  frames: async () => {
    viewMode = 'plate'
    if (!platesReady()) throw new Error('底图还不齐，拍不了视频首尾帧。')
    if (!hasSprites()) throw new Error('人物序列帧还没有，拍不了视频首尾帧。')
    for (const shot of filmShots()) await captureClipFrames(shot)
  },
  silhouettes: () => measureSilhouettes(),
}

const postJob = body => fetch('api/job', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

async function runJob(id) {
  const reply = await (await fetch(`api/job?id=${encodeURIComponent(id)}`)).json()
  // A job the server stops hearing about is a browser that died, not one that is slow.
  // And a server that has gone away leaves nothing for this page to do, so it does not linger.
  const beat = setInterval(() => postJob({ id, alive: true }).catch(() => close()), 10000)
  const body = { id }
  try {
    body.result = await JOBS[reply.op]() ?? null
  } catch (error) {
    body.error = error.message
  }
  clearInterval(beat)
  await postJob(body)
}

// ---------------------------------------------------------------- start
const params = new URLSearchParams(location.search)
const jobId = params.get('job')
const clayOnly = params.get('view') === 'clay'

if (RELAXED && !jobId) createFilmLook(stage)
await loadPlates()
if (platesReady() && !clayOnly) viewMode = 'plate'
// Nothing zooms in on a fixed view, so the screen can show the picture at the size it was painted. Only once
// loading is over, which reads masks off this canvas at its normal size, and never for a saved frame.
if (CAMERAS.a.fixed && !jobId) {
  stage.classList.add('fixed-view')
  renderer.setPixelRatio(2)
}
await loadSprites()
await loadProps()
if (!jobId) await loadClips().catch(error => log(error.message))
log(viewMode === 'plate' ? '已加载底图。' : '白模模式：可以直接试走。')
// Said on the way in the first time. Coming back to a place is nothing to announce.
storyEl.textContent = JOURNEY && !firstVisit ? '' : OPENING
follow.snapTo(firstView(), 'a')
// Loading draws masks on this same canvas, which nobody should see.
if (!jobId) requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById('stage-loading')?.remove()))
if (jobId) await runJob(jobId)
else requestAnimationFrame(frame)

// Coming back to a place on the map is at the way back to where they were. The first time, the opening walks them in.
if (JOURNEY && !jobId) {
  const way = EXITS.find(exit => exit.to === startingAt.get('from'))
  if (way && !firstTimeHere()) {
    player = createPlayer({ ...way.anchor, ...nearestWalkable(way.anchor, (x, z) => isWalkable(x, z, false)) })
    forgetPose()
    follow.snapTo(firstView(), 'a')
  }
}

if (JOURNEY && !jobId && story.finished) phase = 'finished'

// A browser only allows sound once the player has done something, so the film waits to be started.
if (!jobId && clips.opening && viewMode === 'plate' && (!JOURNEY || firstTimeHere())) {
  phase = 'title'
  startEl.textContent = `开始《${TITLE}》`
  startEl.hidden = false
  startEl.addEventListener('click', () => {
    startEl.hidden = true
    startEl.blur()
    sound.start()
    playOpening().catch(error => {
      log(`开场视频无法播放：${error.message}`)
      phase = 'explore'
    })
  }, { once: true })
}

// For automated checks only.
window.__loop = {
  labels: () => paintedLabels,
  snapshot: () => ({ scene: SCENE_ID, journey: JOURNEY ? story.progress : null, x: player.x, z: player.z, yaw: player.yaw, gait: player.gait, camera: activeCameraId, doorOpen, phase, viewMode, clips: Object.keys(clips), sound: sound.state, items: story.items, propOnStage, objective: story.objective, line: storyEl.textContent, prompt: promptEl.textContent, view: follow.pose, look: follow.look, plateMix: follow.plateMix }),
  teleport: (x, z) => { player.x = x; player.z = z },
  look: lookWithMouse,
  pressE: interact,
  start: () => startEl.click(),
  viewFrom: async (pose, plateMix) => {
    framing = { pose, plateMix }
    const saved = actorVisible
    setActorVisible(false)
    draw()
    const dataUrl = canvas.toDataURL('image/png')
    framing = null
    setActorVisible(saved)
    return dataUrl
  },
  fits: () => Object.fromEntries(Object.entries(furnitureFits).map(([id, fits]) => [id, Object.fromEntries(BLOCKS.map((block, i) => [block.name, fits[i].toArray().map(v => Number(v.toFixed(3)))]))])),
  captureEnds: async () => {
    const changed = {}
    for (const shot of filmShots()) changed[shot.clip] = await captureClipFrames(shot)
    return changed
  },
  // Runs the game forward without waiting for the display, for when the tab is not being painted.
  advance: (seconds, dt = 1 / 60) => {
    for (let i = 0; i < Math.round(seconds / dt); i++) update(dt)
    if (phase !== 'clip') draw()
  },
}
