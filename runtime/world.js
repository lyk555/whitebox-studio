// The one source of truth for the space. Renderer, collision and prompts all read this,
// so what the player walks on and what the image model is shown can never disagree.
// Units are metres. +x is east, -z is north, y is up.
//
// The scene says what space it happens in; shell.js works that out. A scene with no description is the room
// the plates, the follow camera and the framing rules were first tuned on.
import SCENE from './sceneData.js'
import { EXIT_REACH, PLAYER_RADIUS, shellFrom, walkableIn } from './shell.js'

const shell = shellFrom(SCENE.stage)
export const { CAMERA_SWITCH, CAMERAS, CORRIDOR_CAMERA, DOOR, DOOR_ANCHOR, EXIT_Z, EXITS: WAYS_OUT, ROOM_WALK, SHELLS, WALL_HEIGHT } = shell
export const EXIT_KIND = shell.exit
export const ROOM = shell.room
export const ROOM_KIND = shell.kind
export { EXIT_REACH, PLAYER_RADIUS }

export const BLOCKS = SCENE.blocks
// A scene painted loosely over its whitebox: what is in the picture decides what hides the player, not the blocks.
export const RELAXED = SCENE.relaxed === true
export const GLOWS = SCENE.glows ?? []

// Each object has one picture of it, so it looks the same from every camera. Only what the first
// camera cannot see whole is painted from the second.
export const paintedBy = block => block.paintedBy ?? 'a'

export const SPAWN = SCENE.spawn
export const INTERACT_RADIUS = 1.5
export const walkableAmong = blocks => walkableIn(shell, blocks)

export const isWalkable = walkableAmong(BLOCKS)
