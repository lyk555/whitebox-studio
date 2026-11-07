// 《闭馆之后》 again, as an ordinary project painted loosely over its whitebox, so the two can be set side by side.
// The read-only original is not touched. The walking character, the portrait and the props are copied over, so
// nothing already paid for is paid for twice.
//
//   node tools/closingTimeRelaxed.mjs [project id] [ark|mock] [low|fixed|close]
//
// fixed is the same room seen from one camera that never moves, laid out shallower so that it all fits one screen.
// close is that camera moved in until the back wall nearly fills the picture.
import { existsSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT } from '../platform/config.mjs'
import { adoptNode } from '../platform/engine.mjs'
import { buildGraph, stageOf } from '../platform/graph.mjs'
import { castDir, createProject, projectDir, sceneDir } from '../platform/store.mjs'

const SOURCE = join(ROOT, '..', 'whitebox-loop', 'assets')
const [id = 'closing-time-relaxed', provider = 'ark', lens = 'low'] = process.argv.slice(2)
const DIRECTIONS = ['e', 'n', 'ne', 's', 'se']

if (existsSync(projectDir(id))) {
  console.error(`项目 ${id} 已经存在，没有改动。`)
  process.exit(1)
}

const story = '馆长三天没回来了。他留话让我闭馆后来这里，说桌上有东西给我。桌上的便条写着：钥匙在我读了四十年的那本书后面。我在书架上找到那本书，书后真有一把钥匙，旧得发黑，却一点灰都没有。这屋里带锁的只有那口木箱。箱子里没有金子，只有一张走廊的旧照片，背面写着：门没锁过，只是没人敢推。我推开门，走廊尽头亮着一盏灯。有人一直在等我。'

const project = {
  id,
  title: '闭馆之后 · 放松实验',
  titleLocked: true,
  story,
  provider,
  style: '写实电影美术，年代感很强的上世纪中叶私人图书馆阅览室。胡桃木、黄铜、旧皮革和石材，做工考究，处处有几十年使用留下的痕迹。低饱和的暖褐色和冷蓝灰形成对比，像大师级的电影布景。',
  cast: [{ id: 'c1', name: '我', role: 'protagonist', playable: true, age: '二十出头', look: '东亚面孔，黑色短发，有细碎的刘海', costume: '深青色羊毛长外套，深色毛衣，深红色粗针织围巾，深色长裤，棕色短靴', personality: '' }],
  scenes: [{
    id: 's1',
    paint: 'relaxed',
    stage: { kind: 'indoor', exit: 'door', width: 12, depth: 7.4, doorAt: 1 / 6, lens: 'low' },
    title: '阅览室',
    place: '闭馆后的旧图书馆阅览室，挑高很高。墙下半部是深色胡桃木护墙板，上半部是斑驳的旧灰泥，顶部有石膏线脚和深色木梁。左墙高处有一排细长的拱窗。地面是深色人字拼木地板，走道被踩得发亮。',
    edges: '房间四周都是实墙，后墙有一扇通向走廊的木门。',
    mood: '黄昏刚过。左墙高窗透进最后一点冷蓝色的天光，只淡淡地扫过左墙和地板。长桌上的黄铜台灯亮着，是房间里唯一的暖光：桌面和周围的地板上有一片清晰的暖色光池，光池之外很快沉入暗部，房间四角几乎看不清，但暗部依然有层次。',
    openingLine: '馆长三天没回来了。他留话让我闭馆后来这里，说桌上有东西给我。',
    endingLine: '走廊尽头亮着一盏灯。有人一直在等我。',
    objects: [
      { id: 'table', name: '阅览长桌', archetype: 'table', x: -1, z: 0.5, look: '厚重的胡桃木阅览长桌，车削的粗桌腿和横枨，桌面镶深绿色旧皮革，边缘包着磨亮的木线。桌上散着几本合上的旧书。' },
      { id: 'lamp', name: '黄铜台灯', archetype: 'lamp', on: 'table', dx: -0.3, dz: -0.05, look: '老式黄铜台灯，亮着，灯罩是暖色的旧玻璃或织物，灯座有细致的旋纹。', glow: { color: '#ffb46a', radius: 1.5 } },
      { id: 'pillar', name: '石柱', archetype: 'pillar', x: -3.9, z: 1, look: '古典石柱，有方形柱础和细致的柱身凹槽，石头表面有年代留下的崩口和污痕。' },
      { id: 'shelf', name: '书架', archetype: 'shelf', x: 0.5, z: -3.7, look: '靠后墙的胡桃木大书架，有雕花檐口和立柱，放满高低错落的旧书，有的平放、有的斜靠，书脊磨损。' },
      { id: 'chest', name: '木箱', archetype: 'chest', x: 4.2, z: -1.5, look: '旧航海木箱，弧形箱盖，铁皮包角和铆钉，正面有一把生锈的大锁，皮革提手已经开裂。' },
      { id: 'cabinet', name: '高柜', archetype: 'cabinet', x: 5.8, z: 1.5, look: '高大的深色木档案柜，一排排小抽屉配黄铜把手，柜顶有檐口。' },
      { id: 'couch', name: '旧沙发', archetype: 'couch', x: 3, z: 2.28, look: '上世纪的深色皮沙发，拉扣靠背，扶手磨得发白，坐垫塌陷，靠背朝向后方。' },
    ],
    props: [{ id: 'note', name: '馆长的便条', look: '泛黄的便条' }, { id: 'key', name: '旧钥匙', look: '发黑的旧钥匙' }, { id: 'photo', name: '走廊的旧照片', look: '一张走廊的旧照片' }],
    beats: [
      { id: 'note', objective: '看看桌上留了什么', object: 'table', objectName: '阅览长桌', performed: true, prompt: '按 E 拿起便条', gives: 'note', after: '便条上只有一句：钥匙在我读了四十年的那本书后面。', action: '手和桌面的特写：手从桌上拿起便条。' },
      { id: 'shelf', objective: '在书架上找那本书', object: 'shelf', objectName: '书架', performed: true, prompt: '按 E 找书', tooEarly: '这么多书，总得先知道找哪一本。', gives: 'key', during: '……真有一把钥匙，旧得发黑，却一点灰都没有。', after: '这屋里带锁的，只有那口木箱。', action: '手在书架上找到一本书，抽出来，书后有一把钥匙。' },
      { id: 'chest', objective: '用钥匙打开木箱', object: 'chest', objectName: '木箱', performed: true, prompt: '按 E 用钥匙开箱', tooEarly: '箱子上了锁。', takes: 'key', gives: 'photo', during: '箱子里没有金子，只有一张走廊的旧照片。', after: '照片背面写着：门没锁过，只是没人敢推。', action: '手用钥匙打开木箱，掀开箱盖，里面是一张旧照片。' },
    ],
    exit: { name: '木门', beyond: '被暖光照亮的短走廊', objective: '推开那扇门', prompt: '按 E 推门', tooEarly: '手放到门上，又收了回来。还不到时候。', during: '门比想象中轻。' },
    film: { opening: { action: '镜头从桌上的台灯慢慢拉开。' }, door: { action: '手推开木门，最后回到第一帧的构图，门已打开。' }, ending: { action: '人物走进走廊，走向尽头的灯。' } },
  }],
}

if (lens === 'fixed') {
  const [scene] = project.scenes
  scene.stage = { kind: 'indoor', exit: 'door', width: 10, depth: 7.6, doorAt: 0.1, lens: 'fixed' }
  const place = { table: [-2, -0.7], pillar: [-4.1, 0.2], shelf: [-0.1, -3.7], chest: [3.6, -2.6], cabinet: [4.3, -0.4], couch: [2.1, 0.3] }
  for (const object of scene.objects) if (place[object.id]) [object.x, object.z] = place[object.id]
}
// The same room seen from close to: a shallower floor, with everything nearer the back wall.
if (lens === 'close') {
  const [scene] = project.scenes
  scene.stage = { kind: 'indoor', exit: 'door', width: 10, depth: 4.9, doorAt: 0.16, lens: 'fixed', framing: 'close' }
  // What is only there to look at stands along the back wall. What the story uses stands out in the room, in plain
  // view and with a clear way all round it.
  const place = { table: [-1.3, -1.4], pillar: [-4.4, -3.1], shelf: [0, -3.7], chest: [3, -1.3], couch: [2.4, -3.5], cabinet: [3.95, -3.4] }
  for (const object of scene.objects) if (place[object.id]) [object.x, object.z] = place[object.id]
}

const stage = stageOf(project.scenes[0])
if (!stage.ok) {
  console.error('舞台没有通过检查：', stage.issues.filter(issue => issue.level === 'error').map(issue => issue.message))
  process.exit(1)
}

await createProject(project)

const castFolder = castDir(id, 'c1')
await mkdir(castFolder, { recursive: true })
const castFiles = ['plate_face.png', 'boots_reference.png', 'sprites.json', ...DIRECTIONS.flatMap(direction => [`walk_${direction}.mp4`, `stand_${direction}.png`, `sprite_${direction}.png`, `walk_${direction}_ref.png`])]
for (const file of castFiles) await copyFile(join(SOURCE, file), join(castFolder, file))
const scene = sceneDir(id, 's1')
await mkdir(scene, { recursive: true })
for (const prop of ['note', 'key', 'photo']) await copyFile(join(SOURCE, `plate_prop_${prop}.png`), join(scene, `plate_prop_${prop}.png`))

for (const node of buildGraph(project).filter(candidate => candidate.id.startsWith('cast:'))) await adoptNode(project, node)

const nodes = buildGraph(project).filter(node => node.id.startsWith('scene:s1:'))
const pictures = nodes.filter(node => node.resource === 'image' && !node.id.includes(':prop_'))
console.log(`已建好 ${id}（${provider}）。这一轮要画 ${pictures.length} 张图（底图不合格时最多多画 ${pictures.filter(node => node.params.gate).length * 2} 张）：`)
for (const node of pictures) console.log(`  ${node.title}`)
