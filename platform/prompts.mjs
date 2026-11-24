// Every prompt the models see, written from a project's data. The wording was learned on 《闭馆之后》:
// each sentence here is in answer to something a model actually got wrong.
import { plateSees } from '../runtime/followCamera.js'
import { OBJECT_COLOURS } from '../runtime/objectColours.js'
import { pictureBounds } from './detail.mjs'
import { LONGEST_TALKING_SHOT, speechSeconds } from './speech.mjs'
import { heightOf, inPicture } from './people.mjs'
import { ARCHETYPES, personBox, wallsFirstCameraSees } from './stage.mjs'
import { copiesLines, namedProps, propNamesOf, sentence, withoutLines } from './wording.mjs'

const [PLATE_WIDTH, PLATE_HEIGHT] = [2560, 1440]
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
  // Each thing cut out under its own name, in the order the game reads them. Past the last colour they are left out.
  const labels = blocks.slice(0, OBJECT_COLOURS.length).map(block => block.label)
  // A way out is not a thing, and nor is the building overhead: split off with a thing next to them, they make it look
  // twice its size.
  const waysOut = scene.exits ? scene.exits.map(way => way.name) : [exit.name || (isDoor ? '门' : '出口')]
  const keptInBase = `${wallsAndFloor}、${shell.kind === 'outdoor' ? '天空、远处的建筑、地上的痕迹' : '天花、窗、壁灯、挂画、地毯'}、头顶的梁架和棚顶，以及${waysOut.join('、')}`
  // Where each standing thing is in this camera's picture of the whitebox, in thousandths, as the models take a box.
  const boxesIn = camera => blocks.flatMap(block => {
    const bounds = block.onTop ? null : pictureBounds(block, shell.CAMERAS[camera])
    if (!bounds) return []
    const share = (value, size) => Math.round(Math.min(Math.max(value / size, 0), 1) * 1000)
    return [`${block.label}<bbox>${share(bounds.x0, PLATE_WIDTH)} ${share(bounds.y0, PLATE_HEIGHT)} ${share(bounds.x1, PLATE_WIDTH)} ${share(bounds.y1, PLATE_HEIGHT)}</bbox>`]
  })
  // Named only, a thing can be confused with what it is named after: a pier's steel frame came back as the pier in the
  // distance. Where to look settles it, and it is told the picture may differ, so a thing moved is still found where it is.
  const matte = camera => {
    const boxes = shell.stage.framing === 'close' ? boxesIn(camera) : []
    return `拆出画面里的这些东西，每件一个图层，图层名用这里给的名字，一字不改：${labels.join('、')}。画面里没有的就跳过，不要新画。${boxes.length ? `它们在布局草模里大致的位置（千分比坐标，依次是左上角和右下角）：${boxes.join('；')}。画出来的位置可能有偏差，以画面里实际的东西为准。` : ''}${keptInBase}都不是这些东西，留在底图里，不要拆进任何图层。`
  }
  // Words alone left a model free to move things about: one moved the fireplace from behind the armchair to bare wall
  // three times running. A box in the picture is something it keeps to.
  const placed = camera => {
    if (shell.stage.framing !== 'close') return ''
    const boxes = boxesIn(camera)
    return boxes.length ? `每件东西在画面里的位置框（千分比坐标，依次是左上角和右下角）：${boxes.join('；')}。每件东西必须正好画在自己的框里，不得超出，也不得和别的东西换位置；框重叠的地方，近处的东西挡住远处的。` : ''
  }
  return {
    // What only shows at the edge of this picture still has to be painted as what it is, or the model makes
    // it into whatever it was last told about, and the second camera then shows something else there.
    a_paint: `图1是这个场景的布局草模，只用来确定相机、透视、墙和地面的位置，以及每件东西大致在哪、有多大。把它画成一张精致的电影美术成品。东西一一对应：${blockList(fromA, shell)}。${fromB.length ? `画面边缘会露出这些东西的一部分，也要照此来画：${blockList(fromB, shell)}。` : ''}${way}相机、透视和墙地交线必须与图1一致。${whatCanBeSeen(shell)}${LOOSE_FORM}${keepsWays}${placed('a')}${dressing}${brief}${LOOSE_FINISH}${noWriting}${NO_PEOPLE}`,
    // Not shown the first camera's finished picture: a model given that copies its composition, and paints the
    // first camera's view all over again. The draft already carries that picture's colours and materials.
    b_paint: `图1是这个地方从第二个机位看到的草稿。视角、构图和每件东西的位置都是准确的，必须严格保持这个视角，不得改成别的机位。草稿里有颜色的部分来自同一个地方的另一张成品，材质、颜色和光线都以它为准，里面的拉伸、破碎和错位只是草稿的痕迹，要按真实物件重新画清楚。灰色部分是还没画的${wallsAndFloor}，要按旁边的样子画完。这个机位能看到：${blockList(blocks, shell)}。图2是这个机位的分区图，每件东西都必须画在图2中它那块白色的位置上，不得左右挪动，也不得缩小到只占其中一部分，每块白色里只有一件东西，不得多画一盏灯或一件家具。${placed('b')}${isDoor && !plateSees(shell.CAMERAS.b, [shell.DOOR.x, 1, shell.DOOR.z]) ? `这个机位看不到${exit.name}，任何一面墙上都不得画门。` : ''}${LOOSE_FORM}${dressing}把整张图重新画成一张完整、清晰、连贯的成品，就像站在这里用另一个机位实拍的一样。${brief}${LOOSE_FINISH}${noWriting}${NO_PEOPLE}`,
    a_matte: matte('a'),
    b_matte: matte('b'),
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

// Someone else standing in the room, for the game: one still picture, turned towards whoever comes up to them from the left.
// Made from the portrait like the walk, so it is the same face the video model is shown in the shots with their face.
export const figurePrompt = person => `${GREEN_SCREEN}图片1是这位人物的定妆照，脸和发型必须与图片1完全相同，但不要照搬图片1的灰色背景。人物穿着：${person.costume}。人物在原地静止站立，身体朝画面左方转约 45 度，看得到正面和一点左侧身，放松自然：双脚平放在地上，双臂自然下垂，手里不拿东西。全身入镜，占画面高度约八成，头顶和脚下都留有一点空白，在画面正中。相机略高于人物，约 15 度俯视。人物身上不得有绿色。光线柔和均匀，写实电影质感。不得出现文字或水印。`

export const standPrompt = () => '图1是这位人物走路时的样子。画同一个人，脸、发型、服装、鞋子和配色都完全不变，相机角度、人物朝向和人物在画面中的大小也都不变。人物静止站立，放松自然：身体挺直，双脚并拢平放在地上，双腿伸直，双臂自然下垂，没有任何迈步或摆臂的动作。背景是完全均匀的亮绿色（#00FF00），没有地面线、影子或渐变。全身入镜。不得出现文字或水印。'

// ---------------------------------------------------------------- film
// The film has to come back to the game, so it ends exactly where it was told to.
const LANDS_ON_LAST_FRAME = '最后回到给定尾帧的构图并停稳，最后一帧与给定的尾帧完全相同。'
const NO_FACE = '人物全程不露脸，只出现背影、肩膀和手。'

const FILM_SOUND = '人物外貌和服装全程不变。声音是写实的同期声：环境声和动作声，音量自然，没有人说话，没有旁白，没有音乐。不得出现任何文字：没有字幕、水印，物件上也不得有可辨认的字。'
// Only a shot with lines changes what it asks for, so every shot already made stays what it was.
const TALKING_SOUND = '人物外貌和服装全程不变。声音是写实的同期声：人物用中文普通话说出下面的台词，一字不改，每句只说一遍，一句说完下一句才开始，口型和台词对上；背景是环境声，音量低于人声。除这些台词外没有别的人声，没有旁白，没有音乐。不得出现任何文字：没有字幕、水印，物件上也不得有可辨认的字。'
const TALKING_FACES = '画面里只有上面这些人，每人只出现一次，背景和远处不得再出现同一个人。说话时看着对方，不看镜头；没轮到说话的人听着，嘴闭上。'
// Told to look at whoever he is talking to, a man talking alone is given someone: a shoulder at the edge of the picture, in a
// study the story says is empty (seen on 《雾都码头谜案》). Alone, he talks to himself.
const TALKING_ALONE = '画面里只有他一个人，他在自言自语，视线落在手里的东西或画面外，不看镜头。画面里不得出现任何别的人，前景和画面边缘也不得有别人的背影、肩膀、手或衣服。'
// With the others standing in the room he is not talking to himself, and told that he is, he says to nobody what the story has
// him say to their faces (seen on 《雾都码头谜案》: Holmes tells the man who cornered him that help is coming, and mutters it at
// his own hands). They still have no portrait in this shot, so they stay out of it.
const TALKING_PAST_CAMERA = '画面里只拍这一个人。这个地方还有别人，都在画面外：这些话是说给他们听的，视线落在画面外他们所在的方向，不看镜头。画面里不得出现任何别的人，前景和画面边缘也不得有别人的背影、肩膀、手或衣服。'
const voiceOf = person => (person?.voice ? `（声音：${person.voice}）` : '')
const linesToSay = (lines, people) => `台词，按顺序说：${lines.map(line => `${line.who}${voiceOf(people.find(person => person.name === line.who))}说：“${line.says}”`).join('；')}。`
const filmLook = () => `写实电影质感，浅景深，运镜平稳，光线和色调与第一帧一致。场景就是画面里的这个地方，不得出现别的地方、家具或人物。不得出现阳光、光束或窗影。灯光柔和，不要放射状的光线。${FILM_SOUND}`
// A picture lit like a film already has its light, so a shot keeps what is there and adds nothing.
const litFilmLook = () => `写实电影质感，浅景深，运镜平稳。光线、光源和色调与第一帧完全一致，不要增加或改变光源。场景就是画面里的这个地方，不得出现别的地方、家具或人物。${FILM_SOUND}`
const FADES_TO_BLACK = '最后画面慢慢暗下去，直到全黑，所有声音也随之消失。'
// Told first of all that everything goes dark and silent, and given no longer than the lines take, a shot has to choose between
// the lines and the dark. So the dark comes after what the shot shows, is said to come after the lines, and has time of its own.
const FADES_AFTER_LINES = '台词全部说完以后，画面才慢慢暗下去，直到全黑，环境声也随之消失。'
const FADE_SECONDS = 2
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

// Others standing in the pictures a shot is pinned to. Said only when someone is there, so a shot with nobody else stays as it was.
// Pushed in close, a face the model has no portrait for turns into someone else (seen on 《雾都码头谜案》: the coal heaver aged
// thirty years), so with others in the picture the camera stays back, where faces are too small to change.
// What the hands do is written for a camera that comes in close, and this one may not: which of the two gives way has to be said.
const KEEPS_WIDE = '第一帧是这个地方的固定全景，人物很小。镜头只缓慢推近一点点，始终是看得到所有人全身的全景，人物一直很小，看不清脸。画面里只有一个主角，不要出现第一人称视角的手。动作里手上的细节在全景里看不清也没关系，只要看得出主角在做这件事。'
const standingThere = people => people.map(person => `${person.name}（${person.costume}），站在${person.where}`).join('；')
// Someone walking over during the shot is the one who does not keep still.
const othersIn = (people, where, moving = []) => people.length ? `${where}里还有${standingThere(people)}。${moving.length ? `除了${moving.map(person => person.name).join('、')}，` : ''}他们一直站在原地，不走开，可以转头看向主角，外貌和服装全程不变。` : ''
const walkersIn = (first, last) => last.filter(person => !first.includes(person) && first.some(other => other.name === person.name))
const comeIn = (first, last) => {
  const arriving = last.filter(person => !first.includes(person))
  const walkedFrom = person => first.find(other => other.name === person.name)
  const comes = arriving.filter(person => !walkedFrom(person))
  const walks = arriving.filter(walkedFrom)
  return (comes.length ? `尾帧里${standingThere(comes)}，是这时走进来的。` : '') + (walks.length ? `尾帧里${walks.map(person => `${person.name}站在${person.where}，是这时从${walkedFrom(person).where}走过来的`).join('；')}。` : '')
}
const ONLY_THESE = '不得出现别的地方、家具或人物。'
const onlyThose = (text, people) => people.length ? text.replace(ONLY_THESE, '不得出现别的地方或家具，除了这里说到的这些人，不得出现别的人物。') : text
const CLOSE_ON_HANDS = '特写里只拍手和东西，不拍别人的脸。'
// With several others in the room, a shot free at its end loses track of which small figure is the player, and brings in a second
// one close to the camera (seen on 《雾都码头谜案》: five people in a warehouse of four). So it is told how many there are, and which.
const CROWD = 2
const whoLeads = (lead, count, there = '', coming = 0) => lead ? `画面里一共${count + coming}个人。${lead.name}是第一帧里${lead.where}背对镜头、穿${lead.costume}的那一个，就是他${there ? '' : '走过去'}做这些动作；镜头前不要再出现另一个人，${coming ? `第一帧里是${count}个人，走进来的人站定以后是这${count + coming}个人` : `从头到尾都是这${count}个人`}。` : ''
// The game takes a step's first frame with the player already at its thing (game.js filmShots), and what a step shows is often
// written from the walk over to it. Asked to walk to where he stands, a model walks him somewhere else and back, or brings a
// second one in. Said only of a step written that way, so the others stay as they were.
const WALKS_OVER = /走到|走向|走近|走去|走过去|走过来|挪到|挪向|迈步|踱/
const alreadyAt = (who, thing) => `第一帧里${who}已经站在${thing}前，不用再走过去：下面写到走过来的地方都略过，动作从站在这里开始。`
const BESIDE = 1.3 // Metres past a thing's edge that still reads as standing beside it.
const FAR_APART = 2 // Metres. Further apart than this, two people talking are seen apart.
// Everyone in the game stands, and the shot cuts back to the game.
const STANDS_STILL = '人物都站着，不坐、不蹲、不靠在东西上，各自站在原地不走动。'

// A shot that shows a face cannot also be pinned to frames: the video model allows one or the other.
// So the shots that join the game are pinned and show no face, the shot with the face is made from
// the portrait, and they meet on a cut, as shots do.
// With the fixed view, the place a face shot refers to is the painted picture with nobody in it (facePlate), since a
// model shown a frame with the person in it paints them a second time. null means the shot is somewhere no picture shows.
// A step can also say what the place sounds like under it (ambience). Its sound is written for the hands, and given to all three
// shots a door is kicked in three times: so the shots after the first take the place's sound when there is one.
function partsOf({ action, face, settle, sound, ambience, people, lines = [], landsOnEnd, fixedView = false, closeUp = false, facePlate, fadesOut = false, others = { first: [], last: [] }, lead = null, alone = false, thing = '', staging = '', key = null }) {
  const pinnedEnd = landsOnEnd ? LANDS_ON_LAST_FRAME : ''
  const lookOf = fixedView ? litFilmLook : filmLook
  const anyone = [...new Set([...others.first, ...others.last])]
  // The face shot is made from portraits and shows whoever it says, so only the shots pinned to the game are told who stands there.
  const look = () => onlyThose(lookOf(), anyone)
  // Someone coming in during a step is seen to come in: before the face shot if it shows them, after it if not. Told only that
  // they came in, the cut to the close-up of the hands brought them in out of nowhere (seen on 《榆园命案》).
  const arriving = face ? others.last.filter(person => !others.first.includes(person)) : []
  const seenIn = arriving.filter(person => people.some(shown => shown.name === person.name))
  const comesLater = arriving.filter(person => !seenIn.includes(person))
  const opening = closeUp ? (others.first.length || seenIn.length ? KEEPS_WIDE : FROM_WHOLE_ROOM) : ''
  const noFace = anyone.length ? `${people[0].name}${NO_FACE.replace('人物', '')}` : NO_FACE
  const standing = othersIn(others.first, '第一帧', walkersIn(others.first, others.last)) + comeIn(others.first, others.last)
  const there = thing && WALKS_OVER.test(action) ? alreadyAt(anyone.length ? people[0].name : '人物', thing) : ''
  if (!face) {
    return [{ duration: 10, landsOnEnd, text: withSound(`电影短片。从第一帧开始。${opening}${there}${action}`, sound) + standing + noFace + (fadesOut ? FADES_TO_BLACK : '') + pinnedEnd + look() }]
  }
  const air = ambience || sound
  // The lines are handed over by themselves: what the shot shows does not say them a second time.
  const shows = withSound(`电影镜头：${copiesLines(face, lines) ? sentence(withoutLines(face, lines)) : face}`, air) + (!fadesOut ? '' : lines.length ? FADES_AFTER_LINES : FADES_TO_BLACK)
  const fade = fadesOut ? FADE_SECONDS : 0
  const faceShot = fixedView
    ? { duration: 4 + fade, showsFace: true, people, facePlate, text: shows + facesLine(people, facePlate !== null) + staging + ONE_OF_EACH + (facePlate === null ? outsideLook(action) : faceLook()) }
    : { duration: 4 + fade, showsFace: true, people, text: shows + facesLine(people) + staging + lookOf() }
  const heardBy = alone && people.length === 1 ? (others.first.length ? TALKING_PAST_CAMERA : TALKING_ALONE) : TALKING_FACES
  const parts = [
    { duration: 5, text: withSound(`电影短片，从第一帧开始。${opening}${there}${action}`, sound) + othersIn(others.first, '第一帧', walkersIn(others.first, seenIn)) + walksIn(seenIn, '动作进行时', others.first) + whoLeads(others.first.length >= CROWD && lead, others.first.length + 1, there, seenIn.length - walkersIn(others.first, seenIn).length) + noFace + onlyThose(lookOf(), [...others.first, ...seenIn]) },
    lines.length
      ? { ...faceShot, duration: Math.min(LONGEST_TALKING_SHOT, speechSeconds(lines) + fade), lines, text: linesToSay(lines, people) + faceShot.text.replace(ONE_OF_EACH, heardBy).replace(FILM_SOUND, TALKING_SOUND) }
      : faceShot,
  ]
  if (landsOnEnd) {
    // The game's first frame starts this shot, from before anyone came in; what comes after the cut is where they stand now.
    const atEnd = arriving.length ? othersIn(others.first, '第一帧', walkersIn(others.first, arriving)) + (seenIn.length ? `尾帧里${standingThere(seenIn)}，${seenIn.some(person => others.first.some(other => other.name === person.name)) ? '刚才已经走到那里了' : '刚才已经走进来了'}。` : '') : standing
    const settles = comesLater.length ? `${walksIn(comesLater, '', others.first).replace(/。$/, '，')}${people[0].name}背对镜头站定。` : '人物背对镜头站定。'
    parts.push({ duration: comesLater.length ? 6 : 4, landsOnEnd: true, opensOnCut: true, text: withSound(`电影短片。从第一帧开始，切到特写：${settle || '手收回来。'}然后切到给定尾帧的构图，${settles}`, air) + atEnd + (anyone.length ? CLOSE_ON_HANDS : '') + noFace + pinnedEnd + look() })
  }
  if (!key) return parts
  // The same step as one take, through the picture of it pushed in (key). Each shot starts on the picture the one before ended on,
  // so nothing jumps. The shots above are what each becomes if the video model will not start from that picture.
  return oneTake({ action, face, sound, air, people, lines, landsOnEnd, fadesOut, fade, others, lead, there, key, arriving, lookOf }).map((part, index) => ({ ...part, fallback: parts[index] }))
}

// ---------------------------------------------------------------- the picture a take is pushed in to
// No closer than this share of the game's picture across. The video model refuses a picture whose faces are big enough to be a
// real person's: on 《榆园命案》 the boot room pushed in to half the width, Holmes turned to the camera, was refused; the sitting
// room at seven tenths, Holmes's back to it and the others' faces small, was taken.
const CLOSEST_KEY = 0.7
// Room round what has to be in it, as a share of its size: headroom, and a little floor.
const KEY_ROOM = { across: 0.18, up: 0.14, down: 0.08 }

// The part of the game's picture that holds all of these, as wide as the picture is, in its pixels.
export function framed(boxes, [width, height] = [PLATE_WIDTH, PLATE_HEIGHT]) {
  let x0 = Math.min(...boxes.map(box => box.x0))
  let x1 = Math.max(...boxes.map(box => box.x1))
  let y0 = Math.min(...boxes.map(box => box.y0))
  let y1 = Math.max(...boxes.map(box => box.y1))
  const [w, h] = [x1 - x0, y1 - y0]
  x0 -= w * KEY_ROOM.across
  x1 += w * KEY_ROOM.across
  y0 -= h * KEY_ROOM.up
  y1 += h * KEY_ROOM.down
  const aspect = width / height
  let across = Math.max(x1 - x0, (y1 - y0) * aspect, width * CLOSEST_KEY)
  across = Math.min(across, width)
  const down = across / aspect
  const middle = [(x0 + x1) / 2, (y0 + y1) / 2]
  const left = Math.min(Math.max(middle[0] - across / 2, 0), width - across)
  const top = Math.min(Math.max(middle[1] - down / 2, 0), height - down)
  return { x0: left, y0: top, x1: left + across, y1: top + down }
}

// Painted from the game's own picture, pushed in, so the room and where everyone stands are the game's; the faces from the portraits.
export const keyPrompt = (project, people, layout) => `图1是电影里一个镜头推近以后的画面，是从游戏画面里放大出来的，很模糊，但构图是准确的。把它重新画成同一个镜头的一张清晰的写实电影剧照：相机位置、视角和构图，房间、墙面、门窗和家具的位置、大小和样子，每个人站的位置、身高和身体朝向，都必须和图1一致，不得增加、移走或挪动任何人和东西，人和家具的比例保持图1的样子。${people.map((person, index) => `图${index + 2}是${person.name}的定妆照，穿着：${person.costume}`).join('；')}。脸必须和各自的定妆照完全相同，是同一个人，但不要照搬定妆照的灰色背景和构图。画面里：${layout}。人物都站着，不坐、不蹲、不靠在东西上。除了这些人，画面里没有别的人。光线、光源和色调与图1一致，不要增加光源。风格：${sentence(project.style)}不得出现文字或水印。`

// ---------------------------------------------------------------- one take
// Told only to stay still, a whole step was three shots joined by cuts: the room, a face from somewhere else in it, a close-up of
// the hands, and back. Seen on 《榆园命案》: Holmes at the boot rack, cut to his face, cut to the boots, cut back, and everyone
// stood somewhere new each time. Now the camera moves in to a picture of the step pushed in, painted from the game's own picture
// so everyone stands where they stand, holds there for the lines, and moves back out to the game.
const ONE_TAKE = '这是一个连续的镜头，中间不切镜头，不跳到别的画面，也不插入特写。'
const NOTHING_JUMPS = '人物不会凭空出现、消失或瞬间换位置：谁换了位置，都要拍出他走过去的过程。镜头推近或拉远时，人和房间、家具的比例始终不变。'
const HOLDS_FOR_LINES = '这一段是同一个画面里的对话：第一帧和最后一帧都是给定的这张画面，镜头几乎不动，最多极慢地推近一点，最后回到第一帧的构图。'
const LOOKS_AT_EACH_OTHER = '说话的人看着对方说，不看镜头；没轮到说话的人听着，嘴闭上。'
// A shot with nothing to fall back on whose first picture is refused, as a face too near (seen on 《榆园命案》: the opening in the
// garden, Lestrade's face at the top of the long-lens picture), starts on the picture it ends on and holds there, so the scene
// still opens without a jump into the game. Its sound and the rules after the action are kept as they were.
export const HELD_SECONDS = 5
export function heldOn(part) {
  const sound = part.prompt.match(/声音：[^。]*。/)?.[0] ?? ''
  const rules = part.prompt.indexOf('写实电影质感')
  return {
    ...part, first: part.last, duration: HELD_SECONDS, opensOnCut: false,
    prompt: `电影短片。${ONE_TAKE}第一帧和最后一帧都是给定的这张画面：镜头几乎不动，极慢地推近一点，再回到这个构图并停稳。画面里的人都站在原地不走动，可以轻微转头、呼吸。${sound}${rules >= 0 ? part.prompt.slice(rules) : litFilmLook()}`,
  }
}

// Someone walks over in this time, which a few steps take; otherwise the camera's move and the hands are all there is.
const PUSH_IN_SECONDS = 5
const WALKING_SECONDS = 6

function oneTake({ action, face, sound, air, people, lines, landsOnEnd, fadesOut, fade, others, lead, there, key, arriving, lookOf }) {
  const player = people[0]
  const inKey = person => key.keys.includes(person.key)
  // Who walks during the push in: anyone in the picture it ends on who was not standing there at the start.
  const nowIn = arriving.filter(inKey)
  const later = arriving.filter(person => !inKey(person))
  const walkers = walkersIn(others.first, nowIn)
  const look = shown => onlyThose(lookOf(), shown)
  const hero = `${player.name}（${player.costume}）在第一帧里${lead ? lead.where : ''}背对镜头。`
  const pushIn = {
    duration: nowIn.length ? WALKING_SECONDS : PUSH_IN_SECONDS, from: 'first', to: 'key',
    text: withSound(`电影短片。${ONE_TAKE}从第一帧的全景开始，镜头平稳地缓缓推近${key.toward}，最后停在给定尾帧的构图上。${hero}${there}${action}`, sound)
      + othersIn(others.first, '第一帧', walkers) + walksIn(nowIn, '动作进行时', others.first)
      + `尾帧里：${key.layout}。` + NOTHING_JUMPS + LANDS_ON_LAST_FRAME + look([...others.first, ...nowIn]),
  }
  const shows = withSound(`电影镜头：${copiesLines(face, lines) ? sentence(withoutLines(face, lines)) : face}`, air)
  const talking = lines.length ? linesToSay(lines, people) : ''
  const hold = {
    duration: lines.length ? Math.min(LONGEST_TALKING_SHOT, speechSeconds(lines) + fade) : 4 + fade, from: 'key', to: fadesOut ? null : 'key',
    // What the step shows was written for a face shot of its own, and can put people where the game does not (Jem by the
    // brushes, when he stands at the boot rack): where they stand is the picture's.
    text: `${talking}电影短片。${ONE_TAKE}${fadesOut ? '第一帧是给定的这张画面，镜头几乎不动。' : HOLDS_FOR_LINES}${shows}谁站在哪，以画面为准，上面写的位置和画面不一样时，照画面来：${key.layout}。${STANDS_STILL}${lines.length ? LOOKS_AT_EACH_OTHER : ''}`
      + (fadesOut ? (lines.length ? FADES_AFTER_LINES : FADES_TO_BLACK) : LANDS_ON_LAST_FRAME)
      + look(key.people).replace(FILM_SOUND, lines.length ? TALKING_SOUND : FILM_SOUND),
  }
  if (!landsOnEnd) return [pushIn, hold]
  const backOut = {
    duration: later.length ? WALKING_SECONDS : 4, from: 'key', to: 'last',
    text: withSound(`电影短片。${ONE_TAKE}从第一帧开始，镜头平稳地缓缓拉远，回到给定尾帧的全景构图。${player.name}转回去，背对镜头站定。`, air)
      + (later.length ? walksIn(later, '镜头拉远时', others.first) : '')
      + othersIn(others.last.filter(person => !later.includes(person)), '尾帧')
      + NOTHING_JUMPS + LANDS_ON_LAST_FRAME + look(others.last),
  }
  return [pushIn, hold, backOut]
}

// Who comes in, through which way, to where they then stand; or, already in the room, walks over from where they stood.
const walksIn = (people, when, before = []) => people.length ? `${when ? `${when}，` : ''}${people.map(person => {
  const was = before.find(other => other.name === person.name)
  return was ? `${person.name}从${was.where}走到${person.where}站定` : `${person.name}（${person.costume}）从${person.door}走进来，走到${person.where}站定`
}).join('；')}，之后一直站在那里，可以转头看向主角。` : ''

// Every video in a scene, in the order they play.
export function filmClips(project, scene, stage) {
  const player = project.cast.find(person => person.playable) ?? project.cast[0]
  const peopleFor = names => {
    const named = names.map(name => project.cast.find(person => person.name === name)).filter(Boolean)
    return [player, ...named.filter(person => person !== player)]
  }
  const fixedView = Boolean(stage.shell.CAMERAS.a.fixed)
  // Who else is in the game's pictures a clip starts and ends on: only those the stage found somewhere to stand.
  const standing = new Map((stage.data.people ?? []).map(person => [person.key ?? person.id, person]))
  const seenAt = inPicture(scene)
  // Where they are in the picture, as the frame shows them. Their thing is named only when they really are beside it: told
  // "by the armchair" of someone a few metres off, a model walks them over to it.
  const whereIs = (spot, beat) => {
    const bounds = pictureBounds(personBox(spot), stage.shell.CAMERAS.a)
    const across = bounds ? (bounds.x0 + bounds.x1) / 2 / PLATE_WIDTH : 0.5
    const side = across < 0.2 ? '画面最左边' : across < 0.4 ? '画面左侧' : across < 0.6 ? '画面中间' : across < 0.8 ? '画面右侧' : '画面最右边'
    const block = stage.blocks.find(candidate => candidate.name === beat?.object)
    const beside = block && Math.hypot(spot.x - block.center[0], spot.z - block.center[2]) <= Math.max(block.size[0], block.size[2]) / 2 + BESIDE
    return beside ? `${side}的${beat.objectName}旁` : side
  }
  // The player where a step's shot starts, said the same way as the others.
  const leadAt = beatId => {
    const mark = stage.data.story.beats.find(entry => entry.id === beatId)?.anchor
    return mark ? { name: player.name, costume: player.costume, where: whereIs(mark, null) } : null
  }
  // The way in nearest where someone ends up: a person coming in is seen to come in through it. Every way out is at the far side.
  const wayInFor = spot => {
    const way = [...(stage.shell.EXITS ?? [])].sort((one, other) => Math.hypot(one.anchor.x - spot.x, one.anchor.z - spot.z) - Math.hypot(other.anchor.x - spot.x, other.anchor.z - spot.z))[0]
    if (!way) return '画面外'
    return `${whereIs(way.anchor, null)}远处的${scene.exits?.find(exit => exit.id === way.id)?.name || scene.exit?.name || '出口'}`
  }
  const othersAt = clipId => {
    const keyOf = entry => entry.key ?? entry.cast
    const described = entries => entries.filter(entry => standing.has(keyOf(entry))).flatMap(entry => {
      const person = project.cast.find(candidate => candidate.id === entry.cast)
      const beat = scene.beats.find(candidate => candidate.id === entry.by)
      const spot = standing.get(keyOf(entry))
      return person ? [{ key: keyOf(entry), name: person.name, costume: person.costume, where: whereIs(spot, beat), door: wayInFor(spot), spot, by: entry.by }] : []
    })
    const { first, last } = seenAt(clipId)
    // The opening starts too close for anyone whose face would show (stage.mjs): they walk in while it pulls back.
    const firstPeople = described(clipId === 'opening' ? first.filter(entry => !standing.get(keyOf(entry))?.walksIn) : first)
    // The same entry on both ends is the same person, so who came in, or walked over, can be told by who is new.
    return { first: firstPeople, last: described(last).map(person => firstPeople.find(other => other.key === person.key) ?? person) }
  }
  const clips = [{
    id: 'opening', title: '开场',
    parts: partsOf({ action: `${scene.film.opening.action}一位人物（${player.costume}）走到尾帧的位置停下，背对镜头。`, sound: scene.film.opening.sound, people: [player], landsOnEnd: true, fixedView, others: othersAt('opening') }),
    hasLast: true,
  }]
  // With the others standing in the room, a face shot shows only who it names or hears, or who stands there by the end of the
  // step: a portrait handed over for anyone else puts them in the shot, out of nowhere (seen on 《雾都码头谜案》: the coal heaver
  // beside Holmes on the pier, where he never was).
  // Someone coming in during the step is not there yet when the face shot comes, unless it says so: Holmes asks whether Watson
  // is back, and Watson walks in after.
  const inFaceShot = beat => {
    if (!scene.onStage) return beat.faceCast ?? []
    const there = new Set(othersAt(beat.id).first.map(person => person.name))
    return (beat.faceCast ?? []).filter(name => there.has(name) || (beat.face ?? '').includes(name) || (beat.lines ?? []).some(line => line.who === name))
  }
  // A face shot is made from portraits and an empty picture of the place, so where everyone stands has to be said. Told nothing,
  // a model stages the talk where it likes. Seen on 《榆园命案》: Holmes, at the experiment table in the game, sat by the fire in
  // the cut to Watson's face; Ellen, across the room from him, stood at his shoulder; then both were back where they had been.
  // Beside the thing they were put by, as the shots of the game say it; else the nearest, so a small thing on the wall is not it.
  const gapTo = (spot, block) => Math.hypot(Math.max(Math.abs(spot.x - block.center[0]) - block.size[0] / 2, 0), Math.max(Math.abs(spot.z - block.center[2]) - block.size[2] / 2, 0))
  const besideWhat = (spot, by) => {
    const own = stage.blocks.find(block => block.name === scene.beats.find(beat => beat.id === by)?.object)
    if (own && gapTo(spot, own) <= BESIDE) return `${own.label}旁`
    const near = stage.blocks.filter(block => !block.onTop).sort((one, other) => gapTo(spot, one) - gapTo(spot, other))[0]
    return near && gapTo(spot, near) <= BESIDE ? `${near.label}旁` : '房间里'
  }
  const stagingAt = (beat, shown) => {
    const mark = scene.onStage && stage.data.story.beats.find(entry => entry.id === beat.id)?.anchor
    if (!mark) return ''
    // Where they stand once the step is done: whoever walks over during it has done so before the face shot.
    const end = othersAt(beat.id).last
    const others = shown.filter(person => person !== player).flatMap(person => end.filter(there => there.name === person.name)).map(there => ({ ...there, apart: Math.hypot(there.spot.x - mark.x, there.spot.z - mark.z) }))
    const far = others.filter(other => other.apart > FAR_APART).map(other => other.name)
    const where = [`${player.name}站在${beat.objectName || '这里'}前`, ...others.map(other => `${other.name}站在${besideWhat(other.spot, other.by)}，离${player.name}约${Math.max(1, Math.round(other.apart * 2) / 2)}米`)]
    return `站位和游戏里一样：${where.join('；')}。${STANDS_STILL}${far.length ? `${far.join('、')}和${player.name}隔着这段距离说话，不要走近，也不要并肩站在一起：镜头可以越过一个人的肩膀拍远处的另一个人，但两人之间始终隔着这段距离。` : ''}`
  }
  // The picture a step's take is pushed in to: the part of the game's picture with the player, the thing and whoever the shot
  // shows, painted again clear and with their faces. Cut from the picture the step ends on, so whoever walks over or comes in
  // during it is already where they stand. Only when everyone the shot shows is standing in the room: a face shot for someone
  // the game does not show would have to paint them in.
  const keyFor = (beat, shown) => {
    if (!fixedView || !beat.face) return null
    const mark = stage.data.story.beats.find(entry => entry.id === beat.id)?.anchor
    if (!mark) return null
    const closes = Boolean(beat.endsChapter)
    const { first, last } = othersAt(beat.id)
    const there = closes ? first : last
    const others = shown.filter(person => person !== player)
    if (!others.every(person => there.some(one => one.name === person.name))) return null
    const camera = stage.shell.CAMERAS.a
    const bounds = box => pictureBounds(box, camera)
    const heroBox = bounds(personBox({ x: mark.x, z: mark.z, height: heightOf(player) }))
    const thing = stage.blocks.find(block => block.name === beat.object)
    const talkers = there.filter(one => others.some(person => person.name === one.name))
    const must = [heroBox, thing && bounds(thing), ...talkers.map(one => bounds(personBox(one.spot)))].filter(Boolean)
    if (!heroBox) return null
    const rect = framed(must)
    const share = box => {
      const inside = Math.max(0, Math.min(box.x1, rect.x1) - Math.max(box.x0, rect.x0)) * Math.max(0, Math.min(box.y1, rect.y1) - Math.max(box.y0, rect.y0))
      return inside / ((box.x1 - box.x0) * (box.y1 - box.y0))
    }
    // Everyone mostly in the picture is in it, said or not: a person left out of the words is painted out, or into someone else.
    const inIt = there.filter(one => {
      const box = bounds(personBox(one.spot))
      return box && share(box) > 0.5
    })
    const across = box => {
      const middle = ((box.x0 + box.x1) / 2 - rect.x0) / (rect.x1 - rect.x0)
      return middle < 0.35 ? '画面左侧' : middle > 0.65 ? '画面右侧' : '画面中间'
    }
    const shorter = person => {
      const gap = heightOf(player) - heightOf(person)
      return gap >= 0.25 ? `，比${player.name}矮一个头` : gap >= 0.08 ? `，比${player.name}矮一些` : ''
    }
    const pictured = [player, ...inIt.map(one => project.cast.find(person => person.name === one.name)).filter(Boolean)]
    const where = person => {
      if (person === player) return `${player.name}在${across(heroBox)}，站在${beat.objectName || '这里'}前`
      const one = inIt.find(candidate => candidate.name === person.name)
      return `${person.name}在${across(bounds(personBox(one.spot)))}，站在${besideWhat(one.spot, one.by)}${shorter(person)}`
    }
    const talksTo = talkers.filter(one => inIt.includes(one)).map(one => one.name)
    // He keeps his back to the camera, as the game has him: his face turned to it is the one big enough to be refused.
    const turn = talksTo.length ? `${player.name}刚做完手上的事，还是背对镜头站着，只把头转向${talksTo.join('和')}；${talksTo.join('、')}面向${player.name}` : `${player.name}刚做完手上的事，还是背对镜头站着，微微低头`
    const layout = `${pictured.map(where).join('；')}。${turn}`
    return {
      from: closes ? 'first' : 'last',
      rect: [rect.x0 / PLATE_WIDTH, rect.y0 / PLATE_HEIGHT, (rect.x1 - rect.x0) / PLATE_WIDTH, (rect.y1 - rect.y0) / PLATE_HEIGHT].map(value => Number(value.toFixed(4))),
      keys: inIt.map(one => one.key),
      people: pictured,
      layout,
      toward: `到${player.name}和${beat.objectName || '他面前的东西'}${talksTo.length ? `，以及${talksTo.join('、')}` : ''}`,
      prompt: keyPrompt(project, pictured, layout),
    }
  }
  // An id is for the code. Written into a shot by a model, it is put back to what the thing is called.
  const called = propNamesOf(project)
  const named = text => namedProps(text, called)
  for (const beat of scene.beats) {
    if (!beat.performed || !stage.data.story.beats.some(entry => entry.id === beat.id && entry.clip)) continue
    // The last step of a chapter is where the chapter closes: it runs on to black, with no picture to come back to.
    const closes = Boolean(beat.endsChapter)
    const shown = peopleFor(inFaceShot(beat))
    const key = keyFor(beat, shown)
    clips.push({
      id: beat.id, title: beat.objective,
      parts: partsOf({ action: named(beat.action), face: named(beat.face), settle: named(beat.settle), sound: beat.sound, ambience: beat.ambience, people: shown, lines: beat.lines, landsOnEnd: !closes, fixedView, closeUp: fixedView, facePlate: 'plate_a_closed.png', fadesOut: closes, others: othersAt(beat.id), lead: leadAt(beat.id), alone: Boolean(scene.onStage), thing: beat.objectName, staging: beat.face ? stagingAt(beat, shown) : '', key }),
      hasLast: !closes,
      ...(key ? { key } : {}),
    })
  }
  // A way out on the map is a cut, with no shot of its own, and a place has no ending: chapters do.
  if (scene.exits) return clips
  // A way out with nothing to open has no shot of its own: the player just walks there.
  if (stage.shell.exit === 'door') {
    clips.push({
      id: 'door', title: scene.exit.objective || '推门',
      parts: partsOf({ action: scene.film.door?.action || `手推开${scene.exit.name || '那扇门'}，最后回到第一帧的构图，门已打开。`, sound: scene.film.door?.sound, people: [player], landsOnEnd: true, fixedView, closeUp: fixedView, others: othersAt('door') }),
      hasLast: true,
    })
  }
  clips.push({
    id: 'ending', title: '结尾',
    parts: partsOf({ action: scene.film.ending.action, face: scene.film.ending.face || '人物侧脸的特写，然后画面慢慢暗下去，直到全黑，所有声音也随之消失。', sound: scene.film.ending.sound, people: peopleFor(scene.film.ending.faceCast ?? []), lines: scene.film.ending.lines, landsOnEnd: false, fixedView, facePlate: stage.shell.exit === 'door' ? null : 'plate_a_open.png', others: othersAt('ending') }),
    hasLast: false,
  })
  return clips
}
