// 《闭馆之后》 as a read-only project, so the finished thing can be walked and watched from day one.
// Its pictures stay where they are in the whitebox-loop experiment and are only ever read from there.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './config.mjs'
import { createProject, readProject } from './store.mjs'

const SOURCE = join(ROOT, '..', 'whitebox-loop', 'assets')
export const DEMO_ID = 'closing-time'

export async function ensureDemo() {
  if (!existsSync(join(SOURCE, 'plate_a_closed.png'))) return null
  try {
    return await readProject(DEMO_ID)
  } catch {
    return createProject({
      id: DEMO_ID,
      title: '闭馆之后',
      readonly: true,
      assetsFrom: SOURCE,
      provider: 'mock',
      story: '馆长三天没回来了。他留话让我闭馆后来这里，说桌上有东西给我。桌上的便条写着：钥匙在我读了四十年的那本书后面。我在书架上找到那本书，书后真有一把钥匙，旧得发黑，却一点灰都没有。这屋里带锁的只有那口木箱。箱子里没有金子，只有一张走廊的旧照片，背面写着：门没锁过，只是没人敢推。我推开门，走廊尽头亮着一盏灯。有人一直在等我。',
      style: '写实电影感，傍晚的旧图书馆阅览室，深色木地板，斑驳的灰褐色墙面。',
      cast: [{ id: 'c1', name: '我', role: 'protagonist', playable: true, age: '二十出头', look: '东亚面孔，黑色短发，有细碎的刘海', costume: '深青色羊毛长外套，深色毛衣，深红色粗针织围巾，深色长裤，棕色短靴', personality: '' }],
      scenes: [{
        id: 's1', demoStage: true, title: '阅览室', place: '傍晚的旧图书馆阅览室。', mood: '柔和的傍晚环境光，桌上台灯的暖光。', openingLine: '馆长三天没回来了。他留话让我闭馆后来这里，说桌上有东西给我。', endingLine: '走廊尽头亮着一盏灯。有人一直在等我。',
        objects: [], props: [{ id: 'note', name: '馆长的便条' }, { id: 'key', name: '旧钥匙' }, { id: 'photo', name: '走廊的旧照片' }],
        beats: [
          { id: 'note', objective: '看看桌上留了什么', objectName: '桌子', performed: false, during: '', after: '便条上只有一句：钥匙在我读了四十年的那本书后面。', gives: 'note' },
          { id: 'shelf', objective: '在书架上找那本书', objectName: '书架', performed: true, during: '……真有一把钥匙，旧得发黑，却一点灰都没有。', after: '这屋里带锁的，只有那口木箱。', gives: 'key' },
          { id: 'chest', objective: '用钥匙打开木箱', objectName: '木箱', performed: true, during: '箱子里没有金子，只有一张走廊的旧照片。', after: '照片背面写着：门没锁过，只是没人敢推。', takes: 'key', gives: 'photo' },
        ],
        exit: { name: '木门', beyond: '被暖光照亮的短走廊', objective: '推开那扇门', during: '门比想象中轻。' },
        clips: [
          { id: 'opening.mp4', file: 'opening.mp4', title: '开场' },
          { id: 'shelf.mp4', file: 'shelf.mp4', title: '在书架上找那本书' },
          { id: 'chest.mp4', file: 'chest.mp4', title: '用钥匙打开木箱' },
          { id: 'door.mp4', file: 'door.mp4', title: '推开那扇门' },
          { id: 'ending.mp4', file: 'ending.mp4', title: '结尾' },
        ],
      }],
    })
  }
}
