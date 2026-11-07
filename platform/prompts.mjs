// Every prompt the models see, written from a project's data. The wording was learned on 《闭馆之后》:
// each sentence here is in answer to something a model actually got wrong.
import { plateSees } from '../runtime/followCamera.js'
import { OBJECT_COLOURS } from '../runtime/objectColours.js'
import { speechSeconds } from './speech.mjs'
import { ARCHETYPES, wallsFirstCameraSees } from './stage.mjs'

const NO_PEOPLE = '画面中不得出现任何人物、文字、水印或界面。'
const KEEP_LAYOUT = '严格保持白模的相机位置、透视和构图。不得增加、移动或删除任何物体，不得改变房间结构。白模只是粗略的体块，请把每个物体画成真实的东西，加上合理的细节和材质，但外轮廓不能变。'
// What this space calls its parts. A street has no skirting, and telling a model about one puts one there.
const wordsFor = ({ kind }) => (kind === 'outdoor'
  ? { edge: '远景', floor: '地面', wallsAndFloor: '远景和地面', backEdge: '远端', outdoors: true }
  : { edge: '墙', floor: '地板', wallsAndFloor: '墙面和地板', backEdge: '后墙', outdoors: false })

// A model likes to finish a room by adding the wall it expects, and what it invents lands on the real floor
// once the picture is seen from the second camera. So it is told which sides this camera has in its picture.
function whatCanBeSeen(shell) {
  const { east } = wallsFirstCameraSees(shell)
  if (shell.kind === 'outdoor') return east ? '这里是室外，没有屋顶，也没有房间的墙。' : '这里是室外，没有屋顶，也没有房间的墙。地面一直延伸到画面右边缘。'
  return east ? '画面里能看到左墙、后墙和右墙三面墙，不要多画，也不要少画。' : '画面里只有左墙和后墙两面墙：后墙和地板一直延伸到画面右边缘，画面右侧没有墙，也没有第二个墙角。'
}

const exitSide = ({ stage: { doorAt } }) => (doorAt < 0.3 ? '左侧' : '中段')
const sideOfWay = (way, { room }) => {
  const across = (way.x - room.west) / (room.east - room.west)
  return across < 0.35 ? '左侧' : across < 0.65 ? '中段' : '右侧'
}

// A place on the map may have several ways out. Each is painted as what it is, and stays as painted: going through is a cut.
function waysInPicture(scene, shell) {
  const { backEdge } = wordsFor(shell)
  const said = shell.EXITS.flatMap(way => {
    const exit = scene.exits.find(candidate => candidate.id === way.id)
    if (!exit) return []
    return [way.kind === 'door'
      ? `${backEdge}${sideOfWay(way, shell)}一扇关闭的${exit.name}，位置和大小与图1那块深色区域一致，是一扇真正的门，有门框和把手。`
      : `${backEdge}${sideOfWay(way, shell)}是${exit.name}，图1那块深色区域只标出它的位置，人从这里走出去，通向${exit.beyond || '别处'}。`]
  })
  return `${said.join('')}出口一共只有 ${said.length} 个，不要多画门或路口，也不要少画。`
}

function exitInGuide(shell, exit) {
  if (shell.exit === 'door') return '门必须正好填满深灰区域，门的下沿落在这条交线上，它是一扇真正的门，有门框和把手。'
  const ground = shell.kind === 'outdoor' ? '地面' : '地板'
  const marker = shell.kind === 'outdoor' ? '灰色上边界上那段贴地的深灰矮条' : '深灰区域'
  return `${marker}只是标出${exit.name || '出口'}的位置，它本身不是一件东西，不要画成立着的石板、门板或墙。这里是人走出去的地方：${ground}从这里连出去，通向${exit.beyond || '别处'}，一眼能看出路的去向，路口的宽度和这段标记差不多。`
}

function silhouette(shell, exit, firstCamera = true) {
  const { edge, floor, outdoors } = wordsFor(shell)
  const exitWord = shell.exit === 'door' ? '门' : '出口'
  const zones = outdoors ? `白色是物体，灰色是地面，深灰是${exitWord}，黑色是远处的背景` : `白色是物体，灰色是地面，深灰是${exitWord}，黑色是墙`
  const blackMeans = outdoors ? '这些颜色只表示区域，不代表真实颜色，黑色的地方要画成后面描述的远景和天空，不能画成黑色。' : '这些颜色只表示区域，不代表真实颜色，墙和地面按后面的描述来画，墙不能画成黑色。'
  const line = outdoors
    ? '地面必须正好铺满灰色区域，地面和远景的交界必须与图2中灰色的上边界完全重合，这条交界可以是矮墙、围栏、树丛的底边，或者地平线。'
    : '地板必须正好铺满灰色区域，墙和地板的交线必须与图2中灰色的上边界完全重合，踢脚线很矮，全部画在这条线上方的黑色区域内。'
  return `图2是同一相机下的分区图：${zones}。${blackMeans}每个物体的外轮廓必须正好填满图2中对应的白色区域，不超出、不缩小、不偏移；白色之外的地方只能是${edge}和${floor}，物体不得伸到那里。腿和腿之间、靠背和扶手之间如果图2不是白色，就要能看到后面的${floor}或${edge}。${line}${exitInGuide(shell, exit)}${firstCamera ? whatCanBeSeen(shell) : ''}`
}

const softLight = ({ kind }) => (kind === 'outdoor'
  ? '光线是柔和的天光，比如阴天或傍晚。绝对没有直射的阳光，地面上不得有硬边的影子、光斑或亮块。白模里的硬边影子只是渲染痕迹，不要照搬，物体脚下只有柔和的接触影。物件上不得有海报、招牌或任何可辨认的文字。画面里不得有雨、雪、雾或飘动的东西，这是一张静止的底图。'
  : '光线柔和均匀，从上方漫射下来。绝对没有直射的阳光，墙上和地板上都不得有窗影、光斑或亮块。白模里的硬边影子只是渲染痕迹，不要照搬，物体脚下只有柔和的接触影。墙上和物件上不得有海报、招牌或任何可辨认的文字。画面里不得有雨、雪、雾或飘动的东西，这是一张静止的底图。')

function emptied(shell) {
  const { edge, floor } = wordsFor(shell)
  return shell.kind === 'outdoor'
    ? `相机位置和透视绝对不变，${floor}和${edge}的交界必须与图1逐像素重合。没有被东西遮挡的地方，${floor}纹理、${edge}和整体色调都与图1完全相同。这里除了${floor}和${edge}，不得有任何物体。画面中不得出现任何人物、文字、水印或界面。`
    : '相机位置和透视绝对不变，墙角线、踢脚线和地板边界必须与图1逐像素重合。没有被家具遮挡的地方，地板纹理、墙面质感和整体色调都与图1完全相同。房间里除了墙、地板和门，不得有任何物体。画面中不得出现任何人物、文字、水印或界面。'
}
const MATTE = '保留的物体必须和图1逐像素相同，位置、大小、轮廓和颜色都不得变化，也不得增加任何内容。绿色是完全均匀的纯绿色（#00FF00），没有渐变、纹理或阴影，并且紧贴物体边缘，物体的腿之间、靠背和扶手之间露出的墙和地板也要涂成绿色。墙和地板之间的踢脚线也要涂成绿色。相机和构图不变。不得出现文字或水印。'
const PROP = '背景是完全均匀的纯绿色（#00FF00），没有影子和渐变，物体上不得有绿色。图1只用来参考材质和光线的感觉。写实风格。不得出现人物、文字或水印。'

// What the model wrote may or may not end a sentence, and these run on into each other.
const sentence = text => {
  const trimmed = String(text ?? '').trim()
  return !trimmed || /[。！？.!?]$/.test(trimmed) ? trimmed : `${trimmed}。`
}

const look = (project, scene, shell) => `风格：${sentence(project.style)}这个地方：${sentence(scene.place)}${scene.edges ? `四周：${sentence(scene.edges)}` : ''}氛围：${sentence(scene.mood)}${softLight(shell)}`

function whereIs({ center: [x, , z], onLabel }, { room }, backEdge) {
  if (onLabel) return `${onLabel}上面`
  const across = (x - room.west) / (room.east - room.west)
  const along = (z - room.north) / (room.south - room.north)
  return `${across < 0.23 ? '左侧' : across > 0.625 ? '右侧' : '中央'}${along < 0.14 ? `靠${backEdge}` : along > 0.78 ? '近处' : ''}`
}

function describeBlock(block, shell) {
  const kind = ARCHETYPES[block.archetype]?.label
  return `${whereIs(block, shell, wordsFor(shell).backEdge)}是${block.label}${kind ? `（体块是${kind}的大形）` : ''}：${block.look || block.label}`
}

const blockList = (blocks, shell) => blocks.map(block => describeBlock(block, shell)).join('；')

// ---------------------------------------------------------------- plates
export function platePrompts(project, scene, stage) {
  const exit = scene.exit ?? scene.exits?.[0] ?? {}
  const { shell } = stage
  const { edge, floor, wallsAndFloor, backEdge, outdoors } = wordsFor(shell)
  const isDoor = shell.exit === 'door'
  const side = exitSide(shell)
  const fromA = stage.blocks.filter(block => !block.paintedBy)
  const fromB = stage.blocks.filter(block => block.paintedBy === 'b')
  const names = list => list.map(block => block.label).join('、')
  const loose = scene.paint === 'relaxed' ? loosePrompts(project, scene, stage) : {}
  return {
    a_closed: `图1是一个场景的白模。把它渲染成完成的场景。白模中的体块一一对应：${blockList(fromA, shell)}${fromB.length ? `；画面边缘可能露出${names(fromB)}的一部分` : ''}；${isDoor ? `${backEdge}${side}一扇关闭的${exit.name}` : `${backEdge}${side}是${exit.name || '出口'}，人从这里走出去`}。${silhouette(shell, exit)}${KEEP_LAYOUT}${look(project, scene, shell)}${NO_PEOPLE}`,
    a_open_raw: isDoor ? `图1是完成的场景，图2是门打开后的白模。只把图1${backEdge}${side}的${exit.name}改为向外打开的状态，门洞内露出${exit.beyond}。除门洞以外的所有内容必须与图1逐像素相同，构图和光线不得变化。${NO_PEOPLE}` : null,
    a_empty: `图1是完成的场景，图2是同一相机下搬空所有物件后的白模。把图1改成一个完全搬空的空间：移除${names(stage.blocks)}，以及它们投在${floor}和${edge}上的影子，露出它们背后完整连续的${wallsAndFloor}，上面都不得有亮斑。${isDoor ? `${backEdge}上的${exit.name}必须留在原位，保持关闭。` : `${exit.name || '出口'}必须留在原位。`}${whatCanBeSeen(shell)}${emptied(shell)}`,
    a_matte: `只保留图1中的这些物体：${names(fromA.length ? fromA : stage.blocks)}。把其余的一切都涂成纯绿色：${wallsAndFloor}、${isDoor ? '门' : '出口'}、以及物体投下的所有影子。${MATTE}`,
    corridor: !isDoor ? null : `图1是${outdoors ? '一段短路的白模：左右两侧的边界、尽头和地面' : '一条短通道内部的白模：左右两面墙、尽头一面墙和地面'}，相机正对前方。把它渲染成完成的场景：${exit.beyond}。严格保持图1的相机和透视，两侧和地面的边界必须与白模逐一对齐。这里没有门、没有家具、没有灯具，也没有任何其他物体，只有连续的两侧和地面。图2只用来参考材质、色调和光线，不得照搬图2的构图和物体。白模之外的深色背景保持深色。${NO_PEOPLE}`,
    b_empty: `图1是同一个空间换了角度看到的样子，品红色（#FF00FF）的区域是还没有画的地方。把所有品红色区域画完：它们是右侧的${wallsAndFloor}，必须和紧邻的已画部分连成一体，${outdoors ? '远景和地面的纹理走向' : '墙面质感、地板纹理的走向、踢脚线的高度和颜色'}、明暗和色调都完全一样，看不出接缝。不是品红色的部分逐像素保持不变。图2是同一相机下的白模，${edge}和${floor}的边界必须与它对齐。这里是空的，除了${wallsAndFloor}不得有任何物体${outdoors ? '' : '，右侧墙上没有门和窗'}。画面中不得留下任何品红色。${NO_PEOPLE}`,
    // On a tripod each camera has a whole picture of its own. The first one says what this place looks like.
    b_whole: `图1是这个地方从第二个机位看到的草稿，图2是这个机位的分区图。草稿的相机、构图、每件东西的位置和大小都是准确的，必须严格保持，不得改变视角。草稿里有颜色的部分来自同一个地方的另一张成品，材质、颜色和光线都以它为准；那些拉伸、模糊、错位和破碎只是草稿的痕迹，要重新画清楚。灰色的部分是还没画的，要按旁边的样子画完，和有颜色的部分是同一个地方。${fromB.length ? `灰色部分里只有这些东西：${blockList(fromB, shell)}。除此之外，灰色部分只有${wallsAndFloor}，不得画任何别的东西。` : `灰色部分只有${wallsAndFloor}，不得画任何东西。`}草稿里已经有的东西，数量、位置和大小都不变，不得增加或复制。把整张图重新画成一张完整、清晰、连贯的成品，就像站在这里用另一个机位实拍的一样。${silhouette(shell, exit, false)}${KEEP_LAYOUT}${look(project, scene, shell)}${NO_PEOPLE}`,
    b: fromB.length ? `图1是已经完成的场景，只有几个灰白色的体块还没有画。把这些体块渲染成真实的东西：${blockList(fromB, shell)}。它们的光线、色调和新旧程度要和场景里已有的东西一致，脚下有柔和的接触影。图2的白色是它们的范围，轮廓必须正好填满白色。除了这些东西和它们脚下的影子，其余所有内容逐像素保持不变，不得增加任何东西。相机和构图不变。${NO_PEOPLE}` : null,
    b_matte: fromB.length ? `只保留图1中的这些物体：${names(fromB)}。把其余的一切都涂成纯绿色：${wallsAndFloor}、其他所有东西、以及物体投下的所有影子。${MATTE}` : null,
    ...loose,
  }
}

// ---------------------------------------------------------------- plates painted loosely over the whitebox
// Told to fill the blocks, a model hands back the blocks with a texture on them. So the whitebox says only where
// things are, and what they look like, what else is on the walls and how the light falls is the painter's.
const LOOSE_FORM = '每件东西站在图1里它所在的位置，占地和高度大致相同，上下浮动两成以内。除此之外不要照搬方块的形状：灰色方块只代表位置和大小，不是它真正的样子。按真实物件重新设计它的结构、比例、线脚、工艺和使用痕迹，不能有方块感，也不能只是给方块贴一层材质。'
const DRESSING = '墙面和屋顶要有设计：可以加护墙板、线脚、壁灯、无字的挂画、窗、天花结构和年代痕迹。家具上可以放合理的小物件。地面只加纹理、拼缝、磨损和污迹，不得在地面上增加任何站立的物件或地毯，人要从这些地方走过。'
const DRESSING_OUTDOORS = '四周和远景要有设计：可以加建筑立面、围栏、树丛、远处的天际线和时代痕迹。大件东西上可以放合理的小物件。地面只加纹理、拼缝、磨损、落叶和污迹，不得在地面上增加任何站立的物件，人要从这些地方走过。'
const LOOSE_FINISH = '材质要有真实的厚度、磨损和微小起伏，不要涂抹感和重复的纹理。光要像电影布光：有看得出来源的主光，有光池、投影和干净的暗部层次，不要平均打光。草模和草稿里的硬边影子只是渲染痕迹，不要照搬，影子要按这里真正的光源来画。这是一张静止的画面，不要雨雪和飘动的东西。'
const NO_WRITING = '书脊和物件上不得有可辨认的文字。'
const NO_WRITING_OUTDOORS = '建筑、招牌和物件上不得有可辨认的文字。'

function loosePrompts(project, scene, stage) {
  const { shell, blocks } = stage
  const { backEdge, wallsAndFloor } = wordsFor(shell)
  const exit = scene.exit ?? scene.exits?.[0] ?? {}
  const isDoor = shell.exit === 'door'
  const side = exitSide(shell)
  const fromA = blocks.filter(block => !block.paintedBy)
  const fromB = blocks.filter(block => block.paintedBy)
  const brief = `风格：${sentence(project.style)}这个地方：${sentence(scene.place)}${scene.edges ? `四周：${sentence(scene.edges)}` : ''}光线和氛围：${sentence(scene.mood)}`
  // A layout with room to walk in is only worth anything if the picture keeps it.
  const rowOf = block => ((block.center[2] - shell.room.north) / (shell.room.south - shell.room.north) < 0.4 ? '后排' : '前排')
  const standingThings = blocks.filter(block => !block.onTop)
  const inRow = row => standingThings.filter(block => rowOf(block) === row).map(block => block.label).join('、')
  const dressing = shell.kind === 'outdoor' ? DRESSING_OUTDOORS : DRESSING
  const noWriting = shell.kind === 'outdoor' ? NO_WRITING_OUTDOORS : NO_WRITING
  const keepsWays = shell.stage.framing === 'close' ? `靠${backEdge}的后排是：${inRow('后排') || '没有东西'}。站在房间里的前排是：${inRow('前排') || '没有东西'}。每件东西都必须画在图1中它自己的体块上，不得互换位置，大小也要和它的体块一样，不得因为它重要就画大。图1里东西之间的空地是人走的路，必须原样留出来：每件东西的前沿和左右边都不得超出它的体块，不得把东西画大、前移或靠拢占掉过道。` : ''
  const way = scene.exits ? waysInPicture(scene, shell) : isDoor
    ? `${backEdge}${side}一扇关闭的${exit.name}，门的位置和大小与图1的深色区域一致，是一扇真正的门，有门框和把手。`
    : `${backEdge}${side}是${exit.name || '出口'}，人从这里走出去，通向${exit.beyond || '别处'}。`
  // Each thing in its own flat colour, in the order the game reads them. Past the last colour they are simply left out.
  const colouring = blocks.flatMap((block, index) => (OBJECT_COLOURS[index] ? [`${block.label}涂成${OBJECT_COLOURS[index].name}（${OBJECT_COLOURS[index].hex}）`] : [])).join('；')
  const matte = () => `图1是一张完成的场景画面。把它画成一张分割图：相机和构图完全不变，每件东西的轮廓必须紧贴它在图1中实际画出来的样子，一个像素都不要偏。${colouring}。放在某件东西上面的小物件，算作那件东西的一部分。其余的一切都涂成纯绿色（#00FF00）：${wallsAndFloor}、墙上的装饰、壁灯、挂画、窗、${isDoor ? '门' : '出口'}、以及所有影子。每一块都是完全均匀的单一颜色，没有纹理、光影、渐变和描边。图1里看不到的东西就不要画，绝不能新增任何东西。物体的腿之间、靠背和扶手之间露出来的墙和地板也要涂成绿色。不得出现文字或水印。`
  return {
    // What only shows at the edge of this picture still has to be painted as what it is, or the model makes
    // it into whatever it was last told about, and the second camera then shows something else there.
    a_paint: `图1是这个场景的布局草模，只用来确定相机、透视、墙和地面的位置，以及每件东西大致在哪、有多大。把它画成一张精致的电影美术成品。东西一一对应：${blockList(fromA, shell)}。${fromB.length ? `画面边缘会露出这些东西的一部分，也要照此来画：${blockList(fromB, shell)}。` : ''}${way}相机、透视和墙地交线必须与图1一致。${whatCanBeSeen(shell)}${LOOSE_FORM}${keepsWays}${dressing}${brief}${LOOSE_FINISH}${noWriting}${NO_PEOPLE}`,
    // Not shown the first camera's finished picture: a model given that copies its composition, and paints the
    // first camera's view all over again. The draft already carries that picture's colours and materials.
    b_paint: `图1是这个地方从第二个机位看到的草稿。视角、构图和每件东西的位置都是准确的，必须严格保持这个视角，不得改成别的机位。草稿里有颜色的部分来自同一个地方的另一张成品，材质、颜色和光线都以它为准，里面的拉伸、破碎和错位只是草稿的痕迹，要按真实物件重新画清楚。灰色部分是还没画的${wallsAndFloor}，要按旁边的样子画完。这个机位能看到：${blockList(blocks, shell)}。图2是这个机位的分区图，每件东西都必须画在图2中它那块白色的位置上，不得左右挪动，也不得缩小到只占其中一部分，每块白色里只有一件东西，不得多画一盏灯或一件家具。${isDoor && !plateSees(shell.CAMERAS.b, [shell.DOOR.x, 1, shell.DOOR.z]) ? `这个机位看不到${exit.name}，任何一面墙上都不得画门。` : ''}${LOOSE_FORM}${dressing}把整张图重新画成一张完整、清晰、连贯的成品，就像站在这里用另一个机位实拍的一样。${brief}${LOOSE_FINISH}${noWriting}${NO_PEOPLE}`,
    a_matte: matte(),
    b_matte: matte(),
  }
}

// A part of a finished picture, painted again at full size so the model spends all its pixels on what is in it.
export const refinePrompt = (project, scene, labels) => `图1是一张完成的场景画面的局部，里面主要是${labels.join('、')}。把这张局部重新画得更精致：材质、木纹、金属、布料的细节，工艺、磨损和使用痕迹，都要像近距离看真实物件一样清晰可信，去掉涂抹感。东西还是这些东西，轮廓、位置、大小、透视和构图都不变，光线方向、明暗和色调也不变，靠近四边的内容尤其要保持不变，因为它要贴回原图。不得增加或移走任何东西。风格：${sentence(project.style)}${NO_WRITING}${NO_PEOPLE}`

export const propPrompt = prop => `${prop.name}：${prop.look || prop.name}。平放，从正上方俯拍，占画面约七成，完整可见。${PROP}`

// ---------------------------------------------------------------- people
// It has to be made from words alone: the video model refuses a face it cannot trust, and it only
// trusts its own family's pure text-to-image.
export const facePrompt = person => `虚构电影角色的头肩定妆照：两个头像并排，左边正面，右边正侧面，是完全同一个人。这位角色${person.age ? `${person.age}，` : ''}${person.look}。穿着：${person.costume}。背景是中性灰，光线柔和均匀，写实电影质感。不得出现文字或水印。`

export const DIRECTIONS = {
  e: '身体完全朝向画面右侧，标准侧面',
  n: '完全背对镜头',
  s: '完全正面朝向镜头',
  ne: '背对镜头，身体朝画面右前方转 45 度，看得到背部和一点右侧身',
  se: '面向镜头，身体朝画面右方转 45 度，看得到正面和一点右侧身',
}

const GREEN_SCREEN = '绿幕抠像素材：背景必须和图片2一样，是完全均匀的亮绿色（#00FF00）平面，从上到下同一种颜色。不是青色，不是蓝绿色，不是摄影棚；没有地面线、墙角、影子或渐变。'

export const walkPrompt = (person, direction, hasFeet) => `${GREEN_SCREEN}图片1是这位人物的定妆照，脸和发型必须与图片1完全相同，但不要照搬图片1的灰色背景。人物穿着：${person.costume}。${hasFeet ? '图片3是这双鞋，颜色和款式必须与图片3完全相同，从任何方向看都是这个颜色。' : ''}固定机位，镜头完全不动，相机略高于人物，约 15 度俯视。人物全身入镜，占画面高度约八成，头顶和脚下都留有一点空白，始终在画面正中。人物在原地匀速自然行走，像在跑步机上：从第一帧起就在走，不停顿；步幅自然，双腿交替迈步，膝盖自然弯曲，脚跟先着地；双臂前后自然摆动，衣摆随步伐摆动；每一步的节奏完全相同，约一秒走两步。人物始终${DIRECTIONS[direction]}，不转身，不发生任何位移。人物身上不得有绿色。${GREEN_SCREEN}光线柔和均匀。写实电影质感。单一连续镜头，不得出现文字或水印。`

export const standPrompt = () => '图1是这位人物走路时的样子。画同一个人，脸、发型、服装、鞋子和配色都完全不变，相机角度、人物朝向和人物在画面中的大小也都不变。人物静止站立，放松自然：身体挺直，双脚并拢平放在地上，双腿伸直，双臂自然下垂，没有任何迈步或摆臂的动作。背景是完全均匀的亮绿色（#00FF00），没有地面线、影子或渐变。全身入镜。不得出现文字或水印。'

// ---------------------------------------------------------------- film
// The film has to come back to the game, so it ends exactly where it was told to.
const LANDS_ON_LAST_FRAME = '最后回到给定尾帧的构图并停稳，最后一帧与给定的尾帧完全相同。'
const NO_FACE = '人物全程不露脸，只出现背影、肩膀和手。'

const FILM_SOUND = '人物外貌和服装全程不变。声音是写实的同期声：环境声和动作声，音量自然，没有人说话，没有旁白，没有音乐。不得出现任何文字：没有字幕、水印，物件上也不得有可辨认的字。'
// Only a shot with lines changes what it asks for, so every shot already made stays what it was.
const TALKING_SOUND = '人物外貌和服装全程不变。声音是写实的同期声：人物用中文普通话说出下面的台词，一字不改，每句只说一遍，一句说完下一句才开始，口型和台词对上；背景是环境声，音量低于人声。除这些台词外没有别的人声，没有旁白，没有音乐。不得出现任何文字：没有字幕、水印，物件上也不得有可辨认的字。'
const TALKING_FACES = '画面里只有上面这些人，每人只出现一次，背景和远处不得再出现同一个人。说话时看着对方，不看镜头；没轮到说话的人听着，嘴闭上。'
const voiceOf = person => (person?.voice ? `（声音：${person.voice}）` : '')
const linesToSay = (lines, people) => `台词，按顺序说：${lines.map(line => `${line.who}${voiceOf(people.find(person => person.name === line.who))}说：“${line.says}”`).join('；')}。`
const filmLook = () => `写实电影质感，浅景深，运镜平稳，光线和色调与第一帧一致。场景就是画面里的这个地方，不得出现别的地方、家具或人物。不得出现阳光、光束或窗影。灯光柔和，不要放射状的光线。${FILM_SOUND}`
// A picture lit like a film already has its light, so a shot keeps what is there and adds nothing.
const litFilmLook = () => `写实电影质感，浅景深，运镜平稳。光线、光源和色调与第一帧完全一致，不要增加或改变光源。场景就是画面里的这个地方，不得出现别的地方、家具或人物。${FILM_SOUND}`
const FADES_TO_BLACK = '最后画面慢慢暗下去，直到全黑，所有声音也随之消失。'
const FROM_WHOLE_ROOM = '第一帧是这个地方的固定全景，人物很小：镜头从全景平稳推近到动作，拍清楚手和东西。'
// A close shot has no first frame to hold it. Who is in it and where they look has to be said.
const ONE_OF_EACH = '画面里只有上面这些人，每人只出现一次，背景和远处不得再出现同一个人。眼睛不看镜头，视线落在画面外或手里的东西上。'
const faceLook = () => `写实电影质感，浅景深，运镜平稳。光线和色调与参考的这个地方一致，不要增加光源。背景就是这个地方，虚化。${FILM_SOUND}`
// Once through the door the room is behind the camera, and the only picture there is would bring it back.
const outsideLook = action => `写实电影质感，浅景深，运镜平稳。人物已经走出门，现在在门外，就是这个地方：${action}背景不得出现屋内、门框或家具。${FILM_SOUND}`

function facesLine(people, hasPlace = true) {
  const place = index => hasPlace ? `图片${index}只用来参考这个地方的墙面、家具、光线和色调，不要照搬它的构图。` : ''
  if (people.length === 1) return `图片1是这位人物的定妆照，脸必须和图片1完全相同，是同一个人${hasPlace ? '' : '，但不要照搬图片1的灰色背景'}。${place(2)}人物穿着：${people[0].costume}。`
  const each = people.map((person, index) => `图片${index + 1}是${person.name}的定妆照，穿着：${person.costume}`).join('；')
  return `${each}。脸必须和各自的定妆照完全相同。${place(people.length + 1)}`
}

const withSound = (text, sound) => `${text}${sound ? `声音：${sound}。` : ''}`

// A shot that shows a face cannot also be pinned to frames: the video model allows one or the other.
// So the shots that join the game are pinned and show no face, the shot with the face is made from
// the portrait, and they meet on a cut, as shots do.
// With the fixed view, the place a face shot refers to is the painted picture with nobody in it (facePlate), since a
// model shown a frame with the person in it paints them a second time. null means the shot is somewhere no picture shows.
function partsOf({ action, face, settle, sound, people, lines = [], landsOnEnd, fixedView = false, closeUp = false, facePlate, fadesOut = false }) {
  const pinnedEnd = landsOnEnd ? LANDS_ON_LAST_FRAME : ''
  const look = fixedView ? litFilmLook : filmLook
  const opening = closeUp ? FROM_WHOLE_ROOM : ''
  if (!face) {
    return [{ duration: 10, landsOnEnd, text: withSound(`电影短片。从第一帧开始。${opening}${action}`, sound) + NO_FACE + (fadesOut ? FADES_TO_BLACK : '') + pinnedEnd + look() }]
  }
  const faceShot = fixedView
    ? { duration: 4, showsFace: true, people, facePlate, text: withSound(`电影镜头：${face}`, sound) + facesLine(people, facePlate !== null) + ONE_OF_EACH + (facePlate === null ? outsideLook(action) : faceLook()) }
    : { duration: 4, showsFace: true, people, text: withSound(`电影镜头：${face}`, sound) + facesLine(people) + look() }
  const parts = [
    { duration: 5, text: withSound(`电影短片，从第一帧开始。${opening}${action}`, sound) + NO_FACE + look() },
    lines.length
      ? { ...faceShot, duration: speechSeconds(lines), lines, text: linesToSay(lines, people) + faceShot.text.replace(ONE_OF_EACH, TALKING_FACES).replace(FILM_SOUND, TALKING_SOUND) }
      : faceShot,
  ]
  if (fadesOut) parts.at(-1).text = `${FADES_TO_BLACK}${parts.at(-1).text}`
  if (landsOnEnd) {
    parts.push({ duration: 4, landsOnEnd: true, opensOnCut: true, text: withSound(`电影短片。从第一帧开始，切到特写：${settle || '手收回来。'}然后切到给定尾帧的构图，人物背对镜头站定。`, sound) + NO_FACE + pinnedEnd + look() })
  }
  return parts
}

// Every video in a scene, in the order they play.
export function filmClips(project, scene, stage) {
  const player = project.cast.find(person => person.playable) ?? project.cast[0]
  const peopleFor = names => {
    const named = names.map(name => project.cast.find(person => person.name === name)).filter(Boolean)
    return [player, ...named.filter(person => person !== player)]
  }
  const fixedView = Boolean(stage.shell.CAMERAS.a.fixed)
  const clips = [{
    id: 'opening', title: '开场',
    parts: partsOf({ action: `${scene.film.opening.action}一位人物（${player.costume}）走到尾帧的位置停下，背对镜头。`, sound: scene.film.opening.sound, people: [player], landsOnEnd: true, fixedView }),
    hasLast: true,
  }]
  for (const beat of scene.beats) {
    if (!beat.performed || !stage.data.story.beats.some(entry => entry.id === beat.id && entry.clip)) continue
    // The last step of a chapter is where the chapter closes: it runs on to black, with no picture to come back to.
    const closes = Boolean(beat.endsChapter)
    clips.push({
      id: beat.id, title: beat.objective,
      parts: partsOf({ action: beat.action, face: beat.face, settle: beat.settle, sound: beat.sound, people: peopleFor(beat.faceCast ?? []), lines: beat.lines, landsOnEnd: !closes, fixedView, closeUp: fixedView, facePlate: 'plate_a_closed.png', fadesOut: closes }),
      hasLast: !closes,
    })
  }
  // A way out on the map is a cut, with no shot of its own, and a place has no ending: chapters do.
  if (scene.exits) return clips
  // A way out with nothing to open has no shot of its own: the player just walks there.
  if (stage.shell.exit === 'door') {
    clips.push({
      id: 'door', title: scene.exit.objective || '推门',
      parts: partsOf({ action: scene.film.door?.action || `手推开${scene.exit.name || '那扇门'}，最后回到第一帧的构图，门已打开。`, sound: scene.film.door?.sound, people: [player], landsOnEnd: true, fixedView, closeUp: fixedView }),
      hasLast: true,
    })
  }
  clips.push({
    id: 'ending', title: '结尾',
    parts: partsOf({ action: scene.film.ending.action, face: scene.film.ending.face || '人物侧脸的特写，然后画面慢慢暗下去，直到全黑，所有声音也随之消失。', sound: scene.film.ending.sound, people: peopleFor(scene.film.ending.faceCast ?? []), lines: scene.film.ending.lines, landsOnEnd: false, fixedView, facePlate: stage.shell.exit === 'door' ? null : 'plate_a_open.png' }),
    hasLast: false,
  })
  return clips
}
