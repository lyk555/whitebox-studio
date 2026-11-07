// What one scene puts on the stage. The server replaces this file per scene when it serves the game
// (/play/<project>/<scene>/sceneData.js). As written here it is 《闭馆之后》, the scene the stage was
// tuned on, which is also what the tests check the stage rules against.
const box = (center, size) => ({ shape: 'box', center, size })
const round = (center, radiusTop, radiusBottom, height) => ({ shape: 'round', center, radiusTop, radiusBottom, height })
// Half a cylinder lying along x, flat side down.
const dome = (center, radius, length) => ({ shape: 'dome', center, radius, length })

const WALL_HEIGHT = 5
const DOOR_ANCHOR = { x: -3, z: -3.1, yaw: Math.PI }

export default {
  // Rough shapes only: enough for the image model to know what each thing is and how big. center and
  // size are the whole object's bounds, which is what the player and the camera collide with.
  blocks: [
    {
      name: 'table', center: [-1, 0.425, 0.5], size: [2, 0.85, 1],
      parts: [
        box([-1, 0.79, 0.5], [2, 0.12, 1]),
        box([-1.88, 0.365, 0.1], [0.14, 0.73, 0.14]), box([-0.12, 0.365, 0.1], [0.14, 0.73, 0.14]),
        box([-1.88, 0.365, 0.9], [0.14, 0.73, 0.14]), box([-0.12, 0.365, 0.9], [0.14, 0.73, 0.14]),
      ],
    },
    {
      name: 'lamp', center: [-1.3, 1.15, 0.45], size: [0.4, 0.6, 0.4],
      parts: [round([-1.3, 1.31, 0.45], 0.1, 0.2, 0.28), round([-1.3, 1.01, 0.45], 0.035, 0.07, 0.32)],
    },
    {
      name: 'pillar', center: [-3.9, WALL_HEIGHT / 2, 1], size: [0.8, WALL_HEIGHT, 0.8],
      parts: [box([-3.9, 0.2, 1], [0.8, 0.4, 0.8]), round([-3.9, 2.7, 1], 0.28, 0.28, 4.6)],
    },
    {
      name: 'shelf', center: [0.5, 1, -3.7], size: [2.5, 2, 0.5],
      parts: [box([0.5, 0.95, -3.72], [2.4, 1.9, 0.46]), box([0.5, 1.95, -3.7], [2.5, 0.1, 0.5])],
    },
    {
      name: 'chest', center: [4.2, 0.55, -1.5], size: [1.3, 1.1, 0.9],
      parts: [box([4.2, 0.325, -1.5], [1.3, 0.65, 0.9]), dome([4.2, 0.65, -1.5], 0.45, 1.3)],
    },
    {
      name: 'cabinet', center: [5.8, 0.9, 1.5], size: [1, 1.8, 1], paintedBy: 'b',
      parts: [
        box([5.8, 0.1, 1.5], [0.8, 0.2, 0.8]),
        box([5.8, 0.95, 1.5], [0.9, 1.5, 0.9]),
        box([5.8, 1.75, 1.5], [1, 0.1, 1]),
      ],
    },
    {
      // The back is on the far side, so the seat faces the camera.
      name: 'couch', center: [3, 0.45, 2.275], size: [2.1, 0.9, 0.85], paintedBy: 'b',
      parts: [
        box([3, 0.25, 2.35], [1.7, 0.5, 0.7]),
        box([3, 0.45, 1.95], [2.1, 0.9, 0.2]),
        box([2.05, 0.325, 2.35], [0.2, 0.65, 0.7]),
        box([3.95, 0.325, 2.35], [0.2, 0.65, 0.7]),
      ],
    },
  ],
  spawn: { x: 0.6, z: 1.9, yaw: Math.PI },
  story: {
    title: '闭馆之后',
    opening: '馆长三天没回来了。他留话让我闭馆后来这里，说桌上有东西给我。',
    ending: '走廊尽头亮着一盏灯。有人一直在等我。',
    lastObjective: '走进门后的走廊',
    items: { note: '馆长的便条', key: '旧钥匙', photo: '走廊的旧照片' },
    // A real thing in the scene until its beat takes it, so taking it away needs no new plate.
    stageProp: { item: 'note', position: [-0.8, 0.854, 0.62], turn: 0.3, size: 0.3 },
    // The film opens on this, seen from the first camera through a long lens.
    openingShot: { target: [-1, 0.95, 0.55], fov: 14 },
    beats: [
      {
        id: 'note',
        objective: '看看桌上留了什么',
        target: { x: -1, z: 0.5, radius: 2 },
        prompt: '按 E 拿起便条',
        gives: 'note',
        after: '便条上只有一句：钥匙在我读了四十年的那本书后面。',
      },
      {
        id: 'shelf',
        objective: '在书架上找那本书',
        target: { x: 0.5, z: -3.2, radius: 1.7 },
        prompt: '按 E 找书',
        tooEarly: '这么多书，总得先知道找哪一本。',
        clip: 'shelf',
        camera: 'a',
        // To one side of the shelf, so the character does not stand in front of the books being searched.
        anchor: { x: -0.1, z: -3, yaw: Math.PI },
        gives: 'key',
        during: '……真有一把钥匙，旧得发黑，却一点灰都没有。',
        after: '这屋里带锁的，只有那口木箱。',
      },
      {
        id: 'chest',
        objective: '用钥匙打开木箱',
        target: { x: 4.2, z: -1.5, radius: 1.7 },
        prompt: '按 E 用钥匙开箱',
        tooEarly: '箱子上了锁。',
        clip: 'chest',
        camera: 'b',
        // At the chest's front corner, where the camera sees both the character and the lid. Just past
        // the chest's east edge, so walking here from behind it slides around the chest, not into it.
        anchor: { x: 5.15, z: -0.6, yaw: Math.atan2(-0.75, -0.9) },
        takes: 'key',
        gives: 'photo',
        during: '箱子里没有金子，只有一张走廊的旧照片。',
        after: '照片背面写着：门没锁过，只是没人敢推。',
      },
      {
        id: 'door',
        objective: '推开那扇门',
        target: { x: DOOR_ANCHOR.x, z: DOOR_ANCHOR.z, radius: 1.5 },
        prompt: '按 E 推门',
        tooEarly: '手放到门上，又收了回来。还不到时候。',
        clip: 'door',
        camera: 'a',
        anchor: DOOR_ANCHOR,
        opensDoor: true,
        during: '门比想象中轻。',
      },
    ],
    // Plays by itself once the player walks into the corridor, and the scene ends on it.
    lastShot: {
      clip: 'ending',
      camera: 'a',
      anchor: { x: -2.85, z: -5.5, yaw: Math.PI },
      isEnding: true,
    },
  },
}
