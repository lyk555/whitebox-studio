// Story → cast → scenes → what stands in each scene. The model reads and sorts; this code checks what
// came back, and a sentence that does not check out goes back to the model with the reason attached.
import { FatalError } from './engine.mjs'
import { CLOSE_LIMITS, closeStage } from '../runtime/shell.js'
import { PART_RULES, shapeFromParts } from './shapes.mjs'
import { linesProblem, spokenLines } from './speech.mjs'
import { isWorld, outlineText } from './world.mjs'
import { ARCHETYPES, buildStage, closeSpots, MIN_PASSAGE, placeObjects, repeatedLayout, settleForFilming, shapeOf, shellFor, SLOT_ORDER, SLOTS } from './stage.mjs'

const MAX_ROUNDS = 3
const JSON_ONLY = '只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。'

function parseAnswer(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('回答里没有 JSON 对象。')
  return JSON.parse(text.slice(start, end + 1))
}

const clean = value => String(value ?? '').trim()

// Asks until the answer checks out. The reason a round failed is what the next round is told.
export async function askChecked({ provider, system, user, images, check, signal, log, progress, rounds = MAX_ROUNDS, model, thinking, onUsage }) {
  let lastError = null
  let lastAnswer = ''
  for (let round = 1; round <= rounds; round++) {
    const asked = lastError
      ? `${user}\n\n上一次的回答没有通过检查：${lastError}\n上一次的回答：\n${lastAnswer.slice(0, 6000)}\n请修正后重新输出完整的 JSON。`
      : user
    lastAnswer = await provider.text({ system, user: asked, ...(images?.length ? { images } : {}), ...(model ? { model, thinking, onUsage } : {}), signal, onProgress: progress })
    try {
      return check(parseAnswer(lastAnswer))
    } catch (error) {
      lastError = error.message
      log(`第 ${round} 轮没通过检查：${error.message}`)
    }
  }
  throw new FatalError(`模型连续 ${rounds} 轮都没给出合格的结果：${lastError}`)
}

// ---------------------------------------------------------------- the whole story
// One line of premise is not a story. Everything after this reads what is written here, so a story that is only a
// fragment stops here, whether it was the person or the model who left it that way.
const PLOT_SYSTEM = `你是类型片编剧，把导演给的一段故事或一个题材，写成一部可以走进去玩的电影的完整故事。主角由玩家操作，其他人物不走动，只在主角走到某件东西前触发的电影镜头里露面、说话。${JSON_ONLY}`

// Below this a story is an idea to be developed. Above it, it is what the person wrote, and may well be one room on purpose.
const SHORT_STORY = 800
const FEWEST_PLACES = 4
const FEWEST_CASE_PLACES = 5
const FEWEST_SUSPECTS = 3
const FEWEST_CLUES = 5
const WORDS_PER_PLACE = 150 // Fewer than this and it is an outline of a story, and the place's facts are nowhere but the outline.
const SCENE_REVIEW_ROUNDS = 2
const PLACE_ROUNDS = 5 // One place failing throws away every place written before it, and those were not the problem.

function plotUser(story) {
  return `导演写的：
${story}

先判断它有没有要破的案子、要解的谜。有就是 case，其他都是 other。

输出：
{
  "type": "case 或 other",
  "story": "完整的故事全文，按发生顺序写，每个地方至少一段 ${WORDS_PER_PLACE} 字以上：谁在哪，做了什么，发现了什么，谁对谁说了什么要紧的话。不是提纲，读它就能知道整个故事",
  "case": {
    "crime": "到底发生了什么：谁、什么时候、怎么做的",
    "culprit": "真凶的名字",
    "motive": "动机",
    "suspects": [{ "name": "嫌疑人名字，真凶也在内", "suspected_because": "为什么被怀疑", "truth": "他在隐瞒什么，最后怎么被排除或被定罪" }],
    "clues": [{ "clue": "线索是什么", "place": 在第几个地方发现（数字，从 1 开始）, "seems": "乍看说明什么", "means": "实际说明什么", "misleading": 这条是不是把人引向错误方向（true 或 false） }],
    "false_turn": "中段主角认定了谁，为什么错了，什么让他发现错了",
    "deduction": "揭晓时的推理，一环扣一环，每一环都用前面发现过的线索"
  },
  "places": [
    { "title": "地点名", "happens": "在这里依次发生的事，每件事都是主角和一件东西互动，或者走到一件东西前和人当面说话", "people": ["这里露面的人物，不含主角"], "learned": "这里结束时主角知道了什么，为什么要去下一个地方" }
  ]
}
type 是 other 时不写 case。

要求：
- 原文写到的人物、地点、情节和结局都要保留，缺的补上。原文已经完整就少动它，只补缺的部分。
- 长度以讲完整为准，不设上限。原文只有几句或一个题材时：案件至少 ${FEWEST_CASE_PLACES} 个地方、${FEWEST_SUSPECTS} 个嫌疑人、${FEWEST_CLUES} 条线索；其他故事至少 ${FEWEST_PLACES} 个地方，要有开端、转折、高潮和结局。
- 案件要公平：真凶在揭晓之前就要露面，读者看到的线索够自己推出答案。至少一条线索把人引向错误方向，中段要有一次真正的判断失误。最后一个地方当面揭晓，真凶在场。
- 案子要由主角破：判断失误靠他自己发现的新证据纠正，真相靠他用线索推出来，再当面说破。不能靠受害者醒来说出真相，不能靠凶手主动坦白，也不能靠巧合。
- 人物之间要有当面的对话和冲突，不能只有主角一个人找东西。每个嫌疑人都要和主角当面说过话。
- 一个地方只写在这里能做到的事。下一个地方为什么要去，必须来自上一个地方得到的东西。
- 同一个人全文只用一个名字，people、suspects、culprit 里一字不差，不要加括号写别名。
- 写原创的情节，不要照搬已有作品的案件。`
}

// "刀疤乔（乔瑟夫·马龙）" and "刀疤乔" are one person, and the check is about who is on screen, not how they are written.
const plainName = name => clean(name).replace(/[（(].*?[）)]/g, '').trim()

function checkPlot(answer, story) {
  const text = clean(answer.story)
  if (!text) throw new Error('story 是空的。')
  if (text.length < story.length) throw new Error(`story 只有 ${text.length} 字，比原文的 ${story.length} 字还短。原文的内容不能丢。`)
  const short = story.length < SHORT_STORY
  const isCase = answer.type === 'case'
  const places = (Array.isArray(answer.places) ? answer.places : []).map((place, index) => {
    if (!clean(place.title) || !clean(place.happens) || !clean(place.learned)) throw new Error(`第 ${index + 1} 个地方缺 title、happens 或 learned。`)
    return { title: clean(place.title), happens: clean(place.happens), people: Array.isArray(place.people) ? place.people.map(plainName).filter(Boolean) : [], learned: clean(place.learned) }
  })
  if (!places.length) throw new Error('places 是空的。')
  const fewest = isCase ? FEWEST_CASE_PLACES : FEWEST_PLACES
  if (short && places.length < fewest) throw new Error(`只有 ${places.length} 个地方，这样只是一个片段。至少要 ${fewest} 个地方，把故事写完整。`)
  if (short && text.length < places.length * WORDS_PER_PLACE) throw new Error(`story 只有 ${text.length} 字，${places.length} 个地方平均不到 ${WORDS_PER_PLACE} 字，这是提纲不是故事。每个地方写一段，线索、对话和转折都要写进去。`)
  if (!isCase) return { story: text, plot: { type: 'other', places } }
  const found = answer.case ?? {}
  const culprit = plainName(found.culprit)
  const suspects = (Array.isArray(found.suspects) ? found.suspects : []).map(suspect => ({ name: plainName(suspect.name), suspectedBecause: clean(suspect.suspected_because), truth: clean(suspect.truth) })).filter(suspect => suspect.name)
  const clues = (Array.isArray(found.clues) ? found.clues : []).map(clue => ({ clue: clean(clue.clue), place: Number(clue.place), seems: clean(clue.seems), means: clean(clue.means), misleading: clue.misleading === true })).filter(clue => clue.clue)
  // Everything at once: told one fault a round, a model mends it and breaks the last one, and runs out of rounds.
  const faults = []
  if (!culprit || !clean(found.crime) || !clean(found.motive)) faults.push('case 要写清 crime、culprit 和 motive。')
  if (!clean(found.false_turn) || !clean(found.deduction)) faults.push('case 要写 false_turn 和 deduction：中段的判断失误和最后的推理。')
  if (!suspects.some(suspect => suspect.name === culprit)) faults.push(`真凶“${culprit}”不在 suspects 里。`)
  if (short && suspects.length < FEWEST_SUSPECTS) faults.push(`只有 ${suspects.length} 个嫌疑人，至少要 ${FEWEST_SUSPECTS} 个，否则没有什么可猜的。`)
  if (short && clues.length < FEWEST_CLUES) faults.push(`只有 ${clues.length} 条线索，至少要 ${FEWEST_CLUES} 条。`)
  if (!clues.some(clue => clue.misleading)) faults.push('没有一条线索把人引向错误方向。')
  for (const clue of clues) if (!(clue.place >= 1 && clue.place <= places.length)) faults.push(`线索“${clue.clue}”的 place 是 ${clue.place}，只有 1 到 ${places.length}。`)
  const sameName = (one, other) => one === other || one.includes(other) || other.includes(one)
  const seenIn = name => places.flatMap((place, index) => (place.people.some(person => sameName(person, name)) ? [index] : []))
  for (const { name } of suspects) if (!seenIn(name).length) faults.push(`嫌疑人“${name}”没有在任何地方露面，把他写进某个地方的 people。`)
  const culpritSeen = seenIn(culprit)
  if (!culpritSeen.includes(places.length - 1)) faults.push(`最后一个地方要当面揭晓，真凶“${culprit}”要在它的 people 里。`)
  if (culpritSeen.length < 2) faults.push(`真凶“${culprit}”只在揭晓时才露面，这样对观众不公平，要在前面的地方就和主角说过话。`)
  if (faults.length) throw new Error(faults.join(' '))
  return { story: text, plot: { type: 'case', places, case: { crime: clean(found.crime), culprit, motive: clean(found.motive), suspects, clues, falseTurn: clean(found.false_turn), deduction: clean(found.deduction) } } }
}

export async function breakdownPlot({ project, provider, signal, log, progress }) {
  const story = clean(project.premise ?? project.story)
  if (!story) throw new FatalError('还没有故事。')
  if (!provider.text) return { story, plot: null }
  return askChecked({ provider, system: PLOT_SYSTEM, user: plotUser(story), check: answer => checkPlot(answer, story), signal, log, progress })
}

// ---------------------------------------------------------------- cast
const CAST_SYSTEM = `你是影视项目的前期统筹，把一段故事拆成人物表。${JSON_ONLY}`

function castUser(story) {
  return `故事：
${story}

输出：
{
  "title": "片名，不超过 10 个字",
  "style": "整部片子的美术风格，一句话，写材质、色调和时代感",
  "cast": [
    {
      "name": "人物名",
      "role": "protagonist 或 supporting",
      "age": "年龄段",
      "look": "外貌：脸型、发型、肤色等能画出来的特征",
      "costume": "服装：从上到下，写清颜色和材质，鞋也要写",
      "personality": "一句话性格",
      "voice": "说话的声音：男声或女声、年龄感、音色和语速，一句，如：中年男声，低沉，语速快"
    }
  ]
}

要求：
- 故事里真正露面或说话的人物都要列出来，一个不漏。主角只有一个，玩家操作的就是主角。
- 都是虚构角色，不得写成真实存在的名人。
- look 和 costume 要具体到能据此画出同一个人。`
}

// Everyone the story needs on screen has to be someone with a face to draw.
function castCovers(cast, plot) {
  const needed = [...new Set((plot?.places ?? []).flatMap(place => place.people))]
  const missing = needed.filter(name => !cast.some(person => person.name === name || person.name.includes(name) || name.includes(person.name)))
  if (missing.length) throw new Error(`故事里露面的${missing.join('、')}不在 cast 里。`)
  return cast
}

function checkCast(answer) {
  const list = Array.isArray(answer.cast) ? answer.cast : []
  if (!list.length) throw new Error('cast 是空的。')
  const cast = list.map((person, index) => {
    if (!clean(person.name)) throw new Error(`第 ${index + 1} 个人物没有 name。`)
    if (!clean(person.look) || !clean(person.costume)) throw new Error(`人物 ${person.name} 缺 look 或 costume。`)
    return { id: `c${index + 1}`, name: clean(person.name), role: person.role === 'protagonist' ? 'protagonist' : 'supporting', age: clean(person.age), look: clean(person.look), costume: clean(person.costume), personality: clean(person.personality), ...(clean(person.voice) ? { voice: clean(person.voice) } : {}), playable: false }
  })
  const lead = cast.find(person => person.role === 'protagonist') ?? cast[0]
  lead.playable = true
  return { title: clean(answer.title), style: clean(answer.style), cast }
}

// ---------------------------------------------------------------- scenes
const SCENES_SYSTEM = `你把故事改编成可以走动游玩的短片。每个地方是一屏固定的画面，相机不动，正对着这个地方的远端，玩家控制主角在画面里走动，按顺序和几件东西互动，每次互动都会播放一段电影视频。地方可以是室内，也可以是室外。${JSON_ONLY}`

export const SCENE_FORMAT = `    {
      "title": "场景名",
      "stage": { "kind": "indoor 或 outdoor", "width": "这个地方的宽度，米", "depth": "这个地方的进深，米", "exit": "door 或 opening", "door_at": "出口在远端边界上的位置，0.08 靠左，0.5 在中间" },
      "edges": "这个地方四周是什么，一句：室内写墙，室外写围栏、树丛、建筑立面或远处的景色",
      "place": "这个地方是什么样，写四周、地面和整体环境，一两句",
      "mood": "这里看起来的光线和色调，一两句，像电影布光：主光从哪来（一盏灯、一扇窗、火光、落日），照亮哪里，哪里沉入暗部，冷暖怎么对比。只写看得见的光，不写声音",
      "opening_line": "进入场景时屏幕上的一句旁白，第一人称",
      "ending_line": "离开场景时的最后一句旁白",
      "props": [{ "id": "英文小写短词", "name": "道具名", "look": "道具的样子" }],
      "beats": [
        {
          "objective": "屏幕上显示的目标，如：在书架上找那本书",
          "object": "这一步要互动的具体物件，如：书架",
          "prompt": "靠近时的按键提示，如：按 E 找书",
          "too_early": "还没轮到这一步时靠近会看到的一句话",
          "during": "这一步进行时的一句旁白",
          "after": "完成后的一句旁白，指向下一步",
          "gives": ["完成后得到的道具 id，可以有多个，没有就是空数组"],
          "takes": ["这一步用掉的道具 id，可以有多个，没有就是空数组"],
          "action": "这次交互的视频内容，必填：分镜头写人物的手怎么碰到这件东西、做了什么、看到了什么，全程不露脸，只有背影、肩膀和手",
          "face": "可选：一个露脸的中近景镜头，写谁在哪、表情和动作；不需要就留空",
          "face_cast": ["这个露脸镜头里除主角外的人物名，要和人物表一字不差"],
          "lines": [{ "who": "说话的人，人物表里的全名", "says": "他开口说的一句话" }],
          "settle": "可选：露脸镜头之后，回到原来构图之前的一个不露脸的特写",
          "sound": "这段视频的环境声和动作声，人说的话写在 lines"
        }
      ],
      "exit": {
        "name": "离开这个地方走的路，如：木门、石拱门洞、林间小路、向下的楼梯",
        "beyond": "走过去之后看到什么样，一句",
        "objective": "目标文字", "prompt": "按键提示", "too_early": "没到时候的一句话", "during": "推门时的旁白", "last_objective": "门开后的目标，如：走进门后的走廊"
      },
      "film": {
        "opening": { "action": "开场视频：从 第一个 beat 的物件 特写开始，镜头后拉，主角走进来停下背对镜头", "sound": "声音" },
        "door": { "action": "推门视频，exit 是 door 时才写：分镜头，全程不露脸，最后回到第一帧的构图，门已打开", "sound": "声音" },
        "ending": { "action": "结尾第一段：主角背对镜头沿门后的通道走，不露脸", "face": "结尾第二段：一个露脸的特写，然后画面慢慢暗到全黑", "face_cast": ["这个特写里除主角外还有谁，没有就是空数组"], "lines": [{ "who": "说话的人", "says": "一句话" }], "sound": "环境声和动作声" }
      }
    }`

export const STORY_RULES = `- 每个场景 1 到 5 个 beat，严格按故事顺序，每个 beat 绑定一个不同的物件。物件必须是一开始就立在地上的完整家具或大件东西，不能是墙、门或人。
- 物件不能是另一件东西的一部分（暗格、抽屉、机关、把手、井沿），也不能是互动之后才出现的东西（升上来的梯子、打开后露出的东西）。这些都写进它所属那件东西的 action 里。几个动作都发生在同一件东西上，就合并成一个 beat，gives 和 takes 也合在一起，不要为了凑数拆开。
- 最后离开靠 exit，不要写进 beats。opening 不用互动，故事做完就能走过去。
- 每个 beat 都是玩家和一件东西的交互，每个都会拍成一段视频，所以 action 都要写。看一块怀表、翻一份卷宗这样的小动作，就写手和东西的特写。
- 人物开口说话只能写在露脸镜头里，写进 lines，视频里真的会说出来。露脸镜头较贵，每个场景一到两个，留给和人当面对话、关键发现和揭晓；其余 beat 的 face 和 lines 留空。
- 不露脸的 action 里只有主角的手和背影，不能写别的人物。其他人物不在场景里走动，只能出现在 face 镜头里，一个镜头里除主角外最多两个人。要和人说话，就把 beat 绑在他身边的一件东西上（酒馆的吧台、办公室的账台），这件东西的 action 拍主角走到那里的手部动作，他本人在 face 里露面。
- 有其他人物的露脸镜头必须有 lines，你来我往，像真人吵架和试探，有潜台词，不要念说明书。一个镜头最多 12 秒，台词加起来不超过 40 个字，每句尽量不超过 15 个字。说不完就分到另一步。
- 视频和图片里不能有文字，不要写需要看清字的镜头，也不要在 place 里写海报、招牌、书法这类带字的东西。
- place 要写清墙面和地面的颜色与材质。
- 旁白要像人物自己在心里说话，短，具体，不解释。人说出口的话写 lines，不要写进旁白。`

function scenesUser(project) {
  const cast = project.cast.map(person => `${person.name}（${person.role === 'protagonist' ? '主角，玩家操作' : '配角'}）`).join('、')
  return `故事：
${project.story}

人物：${cast}

输出：
{
  "scenes": [
${SCENE_FORMAT}
  ]
}

要求：
- 场景跟着地点走：故事换了地方就是新的一场，同一个地方连续发生的事留在一场里。不要把不同地方的事挤进一个房间，也不要为了凑数把一个地方拆开。
- 故事很短，只有一句话或一个题材时，先替它补全成有开端、转折和结局的完整情节，再按地点拆，通常 2 到 3 场。
- 每个地方的大小要符合它本身，不同的地方不要一样大：宽度 ${CLOSE_LIMITS.width[0]} 到 ${CLOSE_LIMITS.width[1]} 米，进深是宽度的将近一半。小房间和客厅大约 10×4.9，仓库或大厅大约 12×5.8，广场、庭院或林中空地大约 14×6.8。再大的地方（整条街、整片树林）取其中最有戏的一片。人物在小地方显得大，在大地方显得小，都只有一屏，不能滚动。狭长的走廊取最有戏的一段，也要按这个比例。
- 故事发生在室外就用 outdoor，不要把室外写成房间。室外的四周是开放的，edges 写远处能看到什么。
- 出口要符合这个地方：有门的用 door；门洞、小路、楼梯、巷口这种没有东西要打开的用 opening。不要每个地方都是一扇门。
- 场景之间靠门连接：除最后一场外，exit.beyond、ending_line 和 film.ending 都要把主角引向下一场，不能写成全片的结局，下一场的 opening_line 要接得上。只有最后一场收束故事。
- 道具跟着主角走：前面场景得到、还没用掉的道具，后面的场景可以直接写进 takes 用掉，不要再写进这一场的 props，也不要再 gives 一次。props 只列这一场新出现的道具。
${STORY_RULES}`
}

// One place at a time from the whole story. A story of any length then fits, and a place that fails goes back by itself.
function placeUser(project, index, written) {
  const { places, case: found } = project.plot
  const place = places[index]
  const next = places[index + 1]
  const inHand = written.at(-1)?.held ?? []
  const cast = project.cast.map(person => `${person.name}（${person.playable ? '主角，玩家操作' : '配角'}）`).join('、')
  return `完整的故事：
${project.story}

${found ? `案件底稿，真相不能提前说破：
${JSON.stringify({ 真凶: found.culprit, 动机: found.motive, 嫌疑人: found.suspects, 这里要发现的线索: found.clues.filter(clue => clue.place === index + 1), 判断失误: found.falseTurn, 推理: found.deduction })}

` : ''}人物表：${cast}

全片 ${places.length} 个地方：${places.map((other, order) => `${order + 1}.${other.title}`).join(' → ')}
现在写第 ${index + 1} 个：${place.title}
这里发生的事：${place.happens}
这里露面的人物：${place.people.join('、') || '没有'}
这里结束时：${place.learned}
${written.length ? `上一个地方结尾的旁白：${written.at(-1).scene.endingLine}\n` : ''}${inHand.length ? `主角手里已有的道具（可以直接写进 takes，不要再写进 props）：${inHand.join('、')}\n` : ''}
输出：
{
  "scene":
${SCENE_FORMAT}
}

要求：
- 这一场至少 2 个 beat，把这里发生的事都拍到，线索都要落在具体的 beat 上。先想好这个地方有哪几件立在地上的家具或大件（桌、柜、箱、架、炉、长凳、货堆），每个 beat 绑一件不同的。这个地方写到的东西不够，就添一件这里合理会有的。地板、墙、门、窗都不行，桌面上的小东西也不行，发生在它们上面的事写进旁边那件大件的 action。
- 这里露面的每个人物都要进某个 face_cast，并且开口说话。主角也要开口，一问一答，不能只有一个人在说。
- 观众只能从旁白和台词知道发生了什么，底稿他们看不到：这里每条线索是什么、乍看说明什么，都要在旁白或台词里说出来，只写在视频内容里不算。真相要等到该揭晓的时候才说。
${found && found.falseTurn ? '- 如果判断失误发生在这里，主角要当面说出他错误的判断。\n' : ''}- 每个地方的大小要符合它本身：宽度 ${CLOSE_LIMITS.width[0]} 到 ${CLOSE_LIMITS.width[1]} 米，进深是宽度的将近一半。小房间大约 10×4.9，仓库或大厅大约 12×5.8，广场或庭院大约 14×6.8。再大的地方取最有戏的一片。
- 故事发生在室外就用 outdoor，室外的 edges 写远处能看到什么。出口要符合这个地方：有门的用 door；门洞、小路、楼梯、巷口用 opening。
${next ? `- 这不是最后一场：exit.beyond、ending_line 和 film.ending 都要把主角引向下一个地方“${next.title}”，不能写成全片的结局。` : `- 这是最后一场：真相在这里说破，film.ending 收束全片。${found ? '主角要亲口把推理一步步说出来，可以分到几个露脸镜头，真凶当面回应，不能只靠旁白或一句认罪。' : ''}`}
- 道具跟着主角走：前面得到、还没用掉的道具后面可以直接用。props 只列这一场新出现的道具。
${STORY_RULES}`
}

export const NOT_A_THING = /(门|门框|门槛|墙|墙壁|舱壁|窗|地面|地板|楼梯)$/

function checkPlace(answer, { project, place, index, held, drawnIn }) {
  const heldNow = new Set(held)
  const drawnNow = new Map(drawnIn)
  const scene = sceneFromAnswer(answer.scene ?? {}, { where: `“${place.title}”`, sceneId: `s${index + 1}`, held: heldNow, drawnIn: drawnNow })
  if (scene.beats.length < 2) throw new Error(`“${place.title}”只有 1 个 beat，至少要 2 个。`)
  const notAThing = scene.beats.find(beat => NOT_A_THING.test(beat.objectName))
  if (notAThing) throw new Error(`“${notAThing.objectName}”不能是互动的东西，墙、门、窗和地面摆不出来。换成立在地上的家具或大件，比如门边的木箱；看门口的脚印就写进那件东西的 action。`)
  const names = project.cast.map(person => person.name)
  const shots = [...scene.beats.map((beat, order) => ({ shot: beat, label: `第 ${order + 1} 个 beat` })), { shot: scene.film.ending, label: '结尾' }]
  for (const { shot, label } of shots) {
    const others = shot.faceCast ?? []
    const stranger = others.find(name => !names.includes(name))
    if (stranger) throw new Error(`${label}的 face_cast 里的“${stranger}”不是人物表里的名字。人物表：${names.join('、')}。`)
    const talkers = others.filter(name => !project.cast.find(person => person.name === name)?.playable)
    if (talkers.length > 2) throw new Error(`${label}的露脸镜头里有 ${talkers.length} 个配角，最多 2 个。`)
    if (talkers.length && !shot.lines?.length) throw new Error(`${label}的露脸镜头里有${talkers.join('、')}，却没有 lines。人物当面要说话。`)
    if (talkers.length && new Set(shot.lines.map(line => line.who)).size < 2) throw new Error(`${label}的台词只有${shot.lines[0].who}一个人在说，这不是对话。主角要接话，一问一答。`)
    const problem = linesProblem(shot, project.cast, label)
    if (problem) throw new Error(problem)
  }
  const isLast = index === project.plot.places.length - 1
  const player = project.cast.find(person => person.playable)?.name
  if (isLast && project.plot.case && shots.flatMap(({ shot }) => shot.lines ?? []).filter(line => line.who === player).length < 2) throw new Error(`这是揭晓的一场，${player}要亲口说出推理，至少两句台词。`)
  const onScreen = new Set(shots.flatMap(({ shot }) => shot.faceCast ?? []))
  const absent = place.people.filter(name => !names.some(full => (full === name || full.includes(name) || name.includes(full)) && (onScreen.has(full) || project.cast.find(person => person.name === full)?.playable)))
  if (absent.length) throw new Error(`${absent.join('、')}要在这里露面，但没有进任何 face_cast。`)
  return { answer, scene, held: heldNow, drawnIn: drawnNow }
}

// Each place can pass and the whole still not tell the story: a clue that only the outline knows, a mistake nobody makes.
// So the whole is read once it exists, by someone looking for what a viewer would miss.
const SCENE_REVIEW_SYSTEM = `你是剧本监督，读整部戏的分场，只查观众看不看得懂这个故事。观众只看得到每一场的旁白和台词，看不到底稿。你不提新想法。${JSON_ONLY}`

const whatAViewerGets = scene => ({
  地点: scene.title, 开场旁白: scene.openingLine,
  步骤: scene.beats.map(beat => ({ 目标: beat.objective, 旁白: [beat.during, beat.after], 台词: beat.lines ?? [] })),
  结尾旁白: scene.endingLine, 结尾台词: scene.film.ending.lines ?? [],
})

function sceneReviewUser(project, scenes) {
  const { places, case: found } = project.plot
  return `底稿：
${JSON.stringify({ 地点: places.map(place => place.title), ...(found ? { 真凶: found.culprit, 动机: found.motive, 嫌疑人: found.suspects, 线索: found.clues, 判断失误: found.falseTurn, 推理: found.deduction } : { 故事: project.story }) })}

观众实际看到的：
${scenes.map((scene, index) => `第 ${index + 1} 场：${JSON.stringify(whatAViewerGets(scene))}`).join('\n')}

查这几件事，只报观众会看不懂或看出矛盾的，措辞好坏不要报：
1. 每条线索观众有没有在旁白或台词里知道？后面推理用到的线索，前面有没有交代过？
2. 判断失误有没有演出来：观众知不知道主角一度认定了谁，又为什么发现错了？
3. 结局：推理有没有由主角当面说出来，真相有没有交代清楚？
4. 前后接得上吗：上一场说要去哪、为什么，下一场是不是那里？同一件事有没有前后说法不一致？

输出 { "ok": true 或 false, "problems": [{ "place": 问题应该改在第几场（数字，从 1 开始）, "what": "一句：哪里，什么问题，应该怎样" }] }`
}

async function reviewScenes({ project, scenes, provider, signal, log, progress }) {
  try {
    return await askChecked({
      provider, system: SCENE_REVIEW_SYSTEM, user: sceneReviewUser(project, scenes), signal, log: () => {}, progress,
      check: found => {
        const problems = (Array.isArray(found.problems) ? found.problems : []).filter(problem => clean(problem?.what))
        if (found.ok === false && !problems.length) throw new Error('ok 是 false，却没有写 problems。')
        if (found.ok === true) return new Map()
        const byPlace = new Map()
        for (const { place, what } of problems) {
          const index = Math.min(scenes.length, Math.max(1, Number(place) || scenes.length)) - 1
          byPlace.set(index, [...(byPlace.get(index) ?? []), clean(what)])
        }
        return byPlace
      },
    })
  } catch (error) {
    if (signal.aborted) throw error
    log(`这次没能通读全剧：${error.message}`)
    return new Map() // A check that could not run says nothing either way, and the scenes are there to be read.
  }
}

async function scenesFromPlot({ project, provider, signal, log, progress }) {
  const { places } = project.plot
  const answers = new Map()
  const writeAll = async complaints => {
    const written = []
    let held = new Set()
    let drawnIn = new Map()
    for (const [index, place] of places.entries()) {
      const said = `第 ${index + 1} / ${places.length} 场 · ${place.title}`
      progress(said)
      const context = { project, place, index, held, drawnIn }
      let result = null
      // A place nobody complained about stands, unless something it relied on from an earlier one has gone.
      if (answers.has(index) && !complaints.has(index)) {
        try { result = checkPlace(answers.get(index), context) } catch (error) { log(`${place.title}：前面的场改了，这一场要跟着改：${error.message}`) }
      }
      if (!result) {
        const again = complaints.has(index) && answers.has(index) ? `\n\n这一场的上一稿：\n${JSON.stringify(answers.get(index).scene)}\n\n通读全剧时发现这些问题，改好后输出完整的这一场：\n${complaints.get(index).map(what => `- ${what}`).join('\n')}` : ''
        result = await askChecked({
          provider, system: SCENES_SYSTEM, user: placeUser(project, index, written) + again, rounds: PLACE_ROUNDS,
          check: answer => checkPlace(answer, context),
          signal, log: message => log(`${place.title}：${message}`), progress: text => progress(`${said} · ${text}`),
        })
      }
      answers.set(index, result.answer)
      ;({ held, drawnIn } = result)
      written.push({ scene: result.scene, held: [...held] })
    }
    return written.map(({ scene }) => scene)
  }
  let scenes = await writeAll(new Map())
  for (let round = 0; round <= SCENE_REVIEW_ROUNDS; round++) {
    progress('通读全剧，查观众看不看得懂')
    const complaints = await reviewScenes({ project, scenes, provider, signal, log, progress })
    if (!complaints.size) break
    const list = [...complaints].map(([index, whats]) => `${places[index].title}：${whats.join('；')}`).join(' / ')
    if (round === SCENE_REVIEW_ROUNDS) {
      log(`通读后还有疑问，留给你判断：${list}`)
      break
    }
    log(`通读发现问题，重写这几场：${list}`)
    scenes = await writeAll(complaints)
  }
  return scenes
}

// Someone the story ended up not showing has no face to pay for. Who plays is always kept.
export const castOnScreen = (cast, scenes) => {
  const seen = new Set(scenes.flatMap(scene => [...scene.beats.flatMap(beat => beat.faceCast ?? []), ...(scene.film?.ending?.faceCast ?? [])]))
  return cast.filter(person => person.playable || seen.has(person.name))
}

// One beat can hand over or use up several things, however the model chose to write them.
const propIdList = value => (Array.isArray(value) ? value : String(value ?? '').split(/[,，、\s]+/)).map(id => clean(id).toLowerCase().replace(/[^a-z0-9_]/g, '')).filter(Boolean)

function checkScenes(answer) {
  const list = Array.isArray(answer.scenes) ? answer.scenes : []
  if (!list.length) throw new Error('scenes 是空的。')
  // What the protagonist is holding carries through the doors, and where each thing was first drawn.
  const held = new Set()
  const drawnIn = new Map()
  return list.map((scene, sceneIndex) => sceneFromAnswer(scene, { where: `第 ${sceneIndex + 1} 个场景`, sceneId: `s${sceneIndex + 1}`, held, drawnIn }))
}

// A beat as it is kept, apart from what it hands over and uses up.
export const beatFromAnswer = beat => ({
  objective: clean(beat.objective), objectName: clean(beat.object), prompt: clean(beat.prompt) || '按 E 查看', tooEarly: clean(beat.too_early), during: clean(beat.during), after: clean(beat.after),
  performed: true, action: clean(beat.action), face: clean(beat.face), faceCast: Array.isArray(beat.face_cast) ? beat.face_cast.map(clean).filter(Boolean) : [], settle: clean(beat.settle), sound: clean(beat.sound), ...(spokenLines(beat.lines).length ? { lines: spokenLines(beat.lines) } : {}),
})

// One scene, given what is already in hand, so a scene can also be written into an existing story.
// Moves what this scene hands over and uses up in and out of `held`.
export function sceneFromAnswer(scene, { where, sceneId, held, drawnIn }) {
  if (!clean(scene.title) || !clean(scene.place)) throw new Error(`${where} 缺 title 或 place。`)
  const beats = Array.isArray(scene.beats) ? scene.beats : []
  if (!beats.length) throw new Error(`${where} 没有 beats。`)
  const carried = [...held].map(id => drawnIn.get(id))
  // A model that lists a carried prop again still means the same thing, so it is not drawn twice.
  const props = (Array.isArray(scene.props) ? scene.props : [])
    .map(prop => ({ id: clean(prop.id).toLowerCase().replace(/[^a-z0-9_]/g, '') || `prop${Math.random().toString(36).slice(2, 6)}`, name: clean(prop.name), look: clean(prop.look) }))
    .filter(prop => !held.has(prop.id))
  for (const prop of props) drawnIn.set(prop.id, { ...prop, from: sceneId })
  const propIds = new Set([...props.map(prop => prop.id), ...held])
  const seenObjects = new Set()
  const normalized = beats.map((beat, index) => {
    const label = `${where}第 ${index + 1} 个 beat`
    if (!clean(beat.objective) || !clean(beat.object)) throw new Error(`${label} 缺 objective 或 object。`)
    if (seenObjects.has(clean(beat.object))) throw new Error(`${label} 的物件“${clean(beat.object)}”已经用过了，每个 beat 要用不同的物件。这里没有别的东西，就添一件这个地方合理会有的大件。`)
    seenObjects.add(clean(beat.object))
    const takes = propIdList(beat.takes)
    const gives = propIdList(beat.gives).filter(id => !held.has(id) || takes.includes(id))
    for (const id of [...gives, ...takes]) if (!propIds.has(id)) throw new Error(`${label} 用到的道具 ${id} 不在 props 里。`)
    for (const id of takes) {
      if (!held.has(id)) throw new Error(`${label} 要用掉 ${id}，但之前没有 beat 给过它。`)
      held.delete(id)
    }
    for (const id of gives) held.add(id)
    if (!clean(beat.action)) throw new Error(`${label} 没写 action。每次交互都要拍成视频。`)
    return { id: `b${index + 1}`, ...beatFromAnswer(beat), gives, takes }
  })
  // A prop no step hands over never reaches the inventory, so there is no reason to pay for a picture of it.
  const inUse = new Set(normalized.flatMap(beat => [...beat.gives, ...beat.takes]))
  const usedProps = props.filter(prop => inUse.has(prop.id))
  const exit = scene.exit ?? {}
  const film = scene.film ?? {}
  const stage = closeStage(scene.stage ?? {})
  if (!clean(film.opening?.action) || !clean(film.ending?.action)) throw new Error(`${where} 的 film 要写全 opening、ending 的 action。`)
  if (stage.exit === 'door' && !clean(film.door?.action)) throw new Error(`${where} 的出口是 door，film 要写 door 的 action。`)
  return {
    id: sceneId, title: clean(scene.title), paint: 'relaxed', stage, edges: clean(scene.edges), place: clean(scene.place), mood: clean(scene.mood), openingLine: clean(scene.opening_line), endingLine: clean(scene.ending_line), props: usedProps, carried, beats: normalized, objects: [],
    exit: { name: clean(exit.name) || '门', beyond: clean(exit.beyond) || '一条被暖光照亮的短走廊', objective: clean(exit.objective), prompt: clean(exit.prompt), tooEarly: clean(exit.too_early), during: clean(exit.during), lastObjective: clean(exit.last_objective) },
    film: {
      opening: { action: clean(film.opening.action), sound: clean(film.opening.sound) },
      door: { action: clean(film.door?.action), sound: clean(film.door?.sound) },
      ending: { action: clean(film.ending.action), face: clean(film.ending.face), sound: clean(film.ending.sound), ...(Array.isArray(film.ending.face_cast) && film.ending.face_cast.length ? { faceCast: film.ending.face_cast.map(clean).filter(Boolean) } : {}), ...(spokenLines(film.ending.lines).length ? { lines: spokenLines(film.ending.lines) } : {}) },
    },
  }
}

// ---------------------------------------------------------------- layout
const LAYOUT_SYSTEM = `你是布景师，决定一个地方里摆什么、每件东西是什么形状、摆在哪。东西要属于这个地方和这个故事，不要摆放哪里都说得通的通用家具。室外就摆室外的东西：长椅、路灯、马车、树、石头、摊位。${JSON_ONLY}`

// The room in the words the model places things by. The checks below say the same in numbers.
export function roomRules(scene) {
  const { room, DOOR, DOOR_APPROACH, EXITS, CAMERA_SWITCH, kind, exit, stage: { framing } } = shellFor(scene)
  const f = value => Number(value.toFixed(1))
  const edge = kind === 'outdoor' ? ['左边界', '右边界', '远端边界'] : ['左墙', '右墙', '后墙']
  const [ax, az] = [DOOR_APPROACH.center[0], DOOR_APPROACH.center[2]]
  const plan = `这个地方的平面图，单位是米：x 从 ${f(room.west)}（${edge[0]}）到 ${f(room.east)}（${edge[1]}），z 从 ${f(room.north)}（${edge[2]}）到 ${f(room.south)}（近处）。镜头在近处看向${edge[2]}。
${scene.exits ? EXITS.map(way => `“${scene.exits.find(other => other.id === way.id)?.name ?? '出口'}”在${edge[2]} x 从 ${f(way.x - way.width / 2)} 到 ${f(way.x + way.width / 2)} 的位置，它前面 x 从 ${f(way.x - 0.85)} 到 ${f(way.x + 0.85)}、z 从 ${f(az - 0.8)} 到 ${f(az + 0.8)} 的范围不能放东西。`).join('\n') : `${exit === 'door' ? '门' : '出口'}在${edge[2]} x 从 ${f(DOOR.x - DOOR.width / 2)} 到 ${f(DOOR.x + DOOR.width / 2)} 的位置，它前面 x 从 ${f(ax - 0.85)} 到 ${f(ax + 0.85)}、z 从 ${f(az - 0.8)} 到 ${f(az + 0.8)} 的范围不能放东西。`}`
  if (framing === 'close') {
    const rowZ = share => f(room.north + share)
    return `${plan}
相机固定不动，正对${edge[2]}，整个地方在一屏里，玩家一直看到全部。东西按前后两排摆最不容易出错：
- 后排贴着${edge[2]}：东西的背面贴墙，z 大约是 ${rowZ(0.5)}。高的东西都放这里。
- 前排在房间中部：放矮的、玩家要用的东西，中心 z 大约是 ${rowZ(2.3)}，前沿不超过 ${rowZ(2.9)}。前排和后排之间、前排前面，都是人走的路。
下面每一条不合格都会退回重摆：
- 人要走得开：东西之间、东西和${edge[0]}${edge[1]}之间，要么留够 ${MIN_PASSAGE} 米，要么贴在一起不留缝，不能留人只能挤过去的窄缝。越靠近镜头，能走的范围越窄。
- 玩家要互动的东西要一眼看全，被前面的东西挡住不能超过四分之一：x 方向尽量错开，不要放在别的东西正后方。它朝镜头的一侧要留出至少 1 米站人。
- 高的东西（柜子、书架、树）靠${edge[2]}或两边，不要放在中间挡住后面。房间中部放矮的、玩家要用的东西。
- 中间要留出能从一边走到另一边的主路。
- ${exit === 'door' ? '门' : '出口'}也要看得见，不要把东西放在它正前方的视线上，玩家要一眼知道往哪走。`
  }
  return `${plan}
玩家要互动的东西，朝镜头的一侧要留出至少 1 米站人，而且不要放在 x 从 ${f(CAMERA_SWITCH.toA - 0.4)} 到 ${f(CAMERA_SWITCH.toB + 0.4)} 之间，那里是两个机位的交界，拍不了表演。`
}

// What has to stand here for the steps to happen. A place the story comes back to can use one thing in more than one step.
const thingsToUse = scene => [...new Map((scene.beats ?? []).map(beat => [beat.objectName, beat])).values()]

const whereItStands = object => `${object.name}（x ${object.x}，z ${object.z}）`

function layoutUser(project, scene) {
  const others = project.scenes.filter(other => other.id !== scene.id && other.objects?.length)
  return `美术风格：${project.style}
场景：${scene.title}。${scene.place}${scene.edges ? `四周：${scene.edges}` : ''}
氛围：${scene.mood}

玩家要在这里依次互动的东西：
${thingsToUse(scene).map((beat, index) => `- 第 ${index + 1} 步：${beat.objectName}（${beat.objective}）`).join('\n') || '没有。这里只是路过的地方，只摆陈设，step 都填 0。'}

陈设的件数和种类看这个地方需要什么，可以很空，也可以很满。

${roomRules(scene)}

${PART_RULES}

${others.length ? `这部片子的其他场景已经这样摆了，这里要明显不一样，不要把东西放在相近的位置：
${others.map(other => `- ${other.title}：${other.objects.filter(object => !object.on).map(whereItStands).join('、')}`).join('\n')}

` : ''}输出：
{
  "arrangement": "这个地方的东西是怎么组织的，一句：比如沿墙一圈、中间一个大工作台、斜着隔出两半、东西全堆在一角",
  "objects": [
    { "step": "这件东西对应第几步，填数字；陈设填 0", "name": "物件名", "x": 0, "z": 0, "on": "放在别的东西上面时，写那件东西的 name；否则留空", "look": "它画出来是什么样：材质、颜色、新旧，一句", "parts": [] }
  ]
}

要求：
- 上面每一步都要有一件东西，step 写对。玩家互动的东西要立在地上，不能放在别的东西上面。
- 摆放要符合 arrangement，有疏有密，不要均匀撒开，也不要左右对称。
- 放在别的东西上面的物件不用写 x、z。
- 不要摆墙、门、窗、地面或人。`
}

// The model's rough model, or a stock one if that is all it named.
function shapeFromAnswer(object, name) {
  const onTop = Boolean(clean(object.on))
  if (Array.isArray(object.parts) && object.parts.length) return { shape: shapeFromParts(object.parts, { name, onTop }) }
  const archetype = clean(object.archetype)
  if (ARCHETYPES[archetype]) return { archetype }
  throw new Error(`“${name}”没有 parts。`)
}

function positionFromAnswer(object, name) {
  if (clean(object.on)) return {}
  const [x, z] = [Number(object.x), Number(object.z)]
  if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error(`“${name}”没有写 x 和 z。`)
  return { x, z }
}

function fromLayoutAnswer(scene, answer, otherScenes = [], log = () => {}) {
  const list = Array.isArray(answer.objects) ? answer.objects : []
  if (!list.length) throw new Error('objects 是空的。')
  // One bad lamp is not a bad room. A thing nothing depends on is left out; what the story needs goes back,
  // and every problem is told at once, so a round is not spent on each in turn.
  const problems = []
  const objects = list.flatMap((object, index) => {
    const name = clean(object.name) || `第 ${index + 1} 件`
    const step = Number(object.step) || 0
    try {
      return [{ id: `o${index + 1}`, name, step, ...shapeFromAnswer(object, name), ...positionFromAnswer(object, name), onName: clean(object.on), look: clean(object.look) }]
    } catch (error) {
      if (step > 0) problems.push(error.message)
      else log(`陈设“${name}”不合格，不摆了：${error.message}`)
      return []
    }
  })
  if (problems.length) throw new Error(problems.join(' '))
  const things = thingsToUse(scene)
  const onAnother = things.flatMap((beat, index) => {
    const object = objects.find(candidate => candidate.step === index + 1)
    return object && shapeOf(object).onTop ? [`“${object.name}”是第 ${index + 1} 步要互动的东西，必须立在地上。如果它本来是别的东西的一部分，就把两者做成一件立在地上的家具。`] : []
  })
  if (onAnother.length) throw new Error(onAnother.join(' '))
  things.forEach((beat, index) => {
    // Which thing a step needs is decided by the step. The model may spell its name a little differently.
    const object = objects.find(candidate => candidate.step === index + 1)
      ?? objects.find(candidate => candidate.name === beat.objectName)
      ?? objects.find(candidate => candidate.name.includes(beat.objectName) || beat.objectName.includes(candidate.name))
    if (!object) throw new Error(`第 ${index + 1} 步要的“${beat.objectName}”不在 objects 里，要有一件 step 为 ${index + 1} 的物件。`)
    if (shapeOf(object).onTop) throw new Error(`“${object.name}”要互动，必须立在地上，不能放在别的东西上面。`)
    for (const other of objects) if (other.onName === object.name) other.onName = beat.objectName
    object.name = beat.objectName
  })
  for (const object of objects) delete object.step
  const placed = finishLayout(scene, objects)
  const finished = { ...placed, objects: settleForFilming({ ...scene, beats: placed.beats }, placed.objects) }
  // The same check the stage page shows. What fails it goes back to the model with the reason.
  const issues = buildStage({ ...scene, ...finished }).issues.filter(issue => issue.level === 'error')
  if (issues.length) throw new Error(issues.map(issue => issue.message).join(' '))
  const repeated = repeatedLayout(finished.objects, otherScenes)
  if (repeated) throw new Error(`这个摆法和“${repeated.title}”太像了，大部分东西都在相近的位置。换一种组织方式，把东西放到别处。`)
  return finished
}

function finishLayout(scene, objects) {
  for (const object of objects) {
    if (object.onName) object.on = objects.find(other => other.name === object.onName)?.id
    delete object.onName
  }
  const performed = new Set(scene.beats.filter(beat => beat.performed).map(beat => objects.find(object => object.name === beat.objectName)?.id))
  const placed = placeObjects(objects, performed, shellFor(scene))
  const beats = scene.beats.map(beat => ({ ...beat, object: placed.find(object => object.name === beat.objectName)?.id }))
  const lost = beats.find(beat => !beat.object)
  if (lost) throw new Error(`房间摆不下“${lost.objectName}”，请减少陈设。`)
  return { objects: placed, beats }
}

const KIND_WORDS = [[/书架|架子|货架/, 'shelf'], [/落地钟|座钟/, 'cabinet'], [/箱|匣/, 'chest'], [/桌|案/, 'table'], [/柜台|吧台|收银/, 'counter'], [/柜/, 'cabinet'], [/床/, 'bed'], [/沙发/, 'couch'], [/椅|凳/, 'chair'], [/炉|灶/, 'stove'], [/祭|坛/, 'altar'], [/像/, 'statue'], [/桶|缸/, 'barrel'], [/石/, 'rock'], [/树/, 'tree'], [/柱/, 'pillar']]
const kindFromName = name => KIND_WORDS.find(([words]) => words.test(name))?.[1] ?? 'crate'

// What the stage does when the model cannot place things: plain, but always something that can be walked.
// Each scene starts from a different proven spot, so two plain rooms in one film are still not the same room.
export function fallbackLayout(scene) {
  const proven = SLOT_ORDER.filter(id => SLOTS[id].performs)
  const shift = (Number(String(scene.id ?? '').slice(1)) || 1) - 1
  const shell = shellFor(scene)
  const close = shell.stage.framing === 'close'
  // A place nothing happens in still has something standing in it, or there is nothing to paint around.
  const things = scene.beats?.length ? thingsToUse(scene) : [{ objectName: '木箱' }]
  const objectsOf = shaped => {
    const shapes = things.map(shaped)
    const spots = close ? closeSpots(shapes.map(shape => shapeOf(shape).size), shell) : null
    return things.map((beat, index) => ({ id: `o${index + 1}`, name: beat.objectName, ...shapes[index], ...(close ? spots[index] : { slot: proven[(index + shift * 2) % proven.length] }), look: beat.objectName }))
  }
  const attempt = shaped => {
    try {
      const placed = finishLayout(scene, objectsOf(shaped))
      const finished = { ...placed, objects: settleForFilming({ ...scene, beats: placed.beats }, placed.objects) }
      return buildStage({ ...scene, ...finished }).ok ? finished : null
    } catch {
      return null
    }
  }
  // Real furniture if it fits. In a space too small for it, plain blocks small enough to walk around.
  return attempt(beat => ({ archetype: kindFromName(beat.objectName) }))
    ?? attempt(() => ({ shape: shapeFromParts([{ shape: 'box', at: [0, 0.45, 0], size: [0.7, 0.9, 0.7] }]) }))
    ?? finishLayout(scene, objectsOf(beat => ({ archetype: kindFromName(beat.objectName) })))
}

// ---------------------------------------------------------------- dry run
const sentencesOf = story => story.split(/(?<=[。！？!?\n])/).map(text => text.trim()).filter(Boolean)
const OBJECT_WORDS = /书架|木箱|箱子|桌子|长桌|书桌|柜子|沙发|床|椅子|炉子|雕像|柜台|祭台|架子/g

function dryCast(story) {
  const title = (sentencesOf(story)[0] ?? '试运行故事').replace(/[。！？!?，,].*$/, '').slice(0, 10)
  return { title, style: '写实电影感，旧木头和灰褐色墙面（试运行占位）', cast: [{ id: 'c1', name: '主角', role: 'protagonist', age: '二十多岁', look: '东亚面孔，黑色短发', costume: '深青色长外套，深色长裤，棕色短靴', personality: '谨慎', playable: true }] }
}

function dryScenes(project) {
  const sentences = sentencesOf(project.story)
  const found = [...new Set(project.story.match(OBJECT_WORDS) ?? [])]
  const objects = [...found, '木箱', '书架', '长桌'].filter((name, index, all) => all.indexOf(name) === index).slice(0, 3)
  const beats = objects.map((name, index) => ({
    id: `b${index + 1}`, objective: `查看${name}`, objectName: name, prompt: `按 E 查看${name}`, tooEarly: '还不到时候。', during: sentences[index + 1] ?? '', after: sentences[index + 2] ?? '',
    gives: index === 0 ? 'clue' : '', takes: '', performed: true, action: `人物俯身查看${name}，手轻轻碰了碰它。`, face: index === 1 ? '人物低头思索，表情凝重。' : '', faceCast: [], settle: index === 1 ? '手从物件上收回。' : '', sound: '安静房间里轻微的动作声。',
  }))
  return [{
    id: 's1', title: project.title || '试运行场景', paint: 'relaxed', stage: closeStage({ kind: 'indoor', exit: 'door', width: 10, depth: 4.9, doorAt: 0.16 }), place: '一间安静的旧屋子，灰褐色墙面，深色木地板。', mood: '桌上一盏台灯是唯一的暖光，光池之外沉入暗部。', openingLine: sentences[0] ?? '', endingLine: sentences.at(-1) ?? '', props: [{ id: 'clue', name: '线索', look: '一张旧纸条' }], beats, objects: [],
    exit: { name: '木门', beyond: '一条被暖光照亮的短走廊', objective: '推开那扇门', prompt: '按 E 推门', tooEarly: '还不到时候。', during: '门比想象中轻。', lastObjective: '走进门后的走廊' },
    film: { opening: { action: '从第一件物件的特写开始，镜头后拉，人物走进来停下，背对镜头。', sound: '脚步声。' }, door: { action: '手推开门，暖光透出来，最后回到第一帧的构图，门已打开。', sound: '门的吱呀声。' }, ending: { action: '人物背对镜头沿走廊慢慢走。', face: '人物侧脸的特写，然后画面慢慢暗到全黑。', sound: '脚步声。' } },
  }]
}

// ---------------------------------------------------------------- steps
export async function breakdownCast({ project, provider, signal, log, progress }) {
  if (!clean(project.story)) throw new FatalError('还没有故事。')
  if (!provider.text) return dryCast(project.story)
  const told = isWorld(project) ? `${project.story}\n\n真相（观众看不到）：${project.truth}\n\n章节和锚点：\n${outlineText(project)}` : project.story
  return askChecked({
    provider, system: CAST_SYSTEM, user: castUser(told), signal, log, progress,
    check: answer => {
      const found = checkCast(answer)
      castCovers(found.cast, project.plot)
      // A name is what a script writes in front of a line. A note in brackets would have to be copied exactly, every time.
      if (isWorld(project)) for (const person of found.cast) person.name = plainName(person.name)
      return found
    },
  })
}

export async function breakdownScenes({ project, provider, signal, log, progress }) {
  if (!project.cast.length) throw new FatalError('还没有人物表。')
  if (!provider.text) return dryScenes(project)
  if (project.plot?.places?.length) return scenesFromPlot({ project, provider, signal, log, progress })
  return askChecked({ provider, system: SCENES_SYSTEM, user: scenesUser(project), check: checkScenes, signal, log, progress })
}

export async function buildLayout({ project, scene, provider, signal, log, progress }) {
  if (!provider.text) return fallbackLayout(scene)
  try {
    const others = project.scenes.filter(other => other.id !== scene.id && other.objects?.length)
    // A map can have many places, and the more there are the harder it is to be unlike all of them. On the last try a
    // room that looks like another one is kept: it is still far better than the plain blocks it would otherwise fall back to.
    let tries = 0
    return await askChecked({
      provider, system: LAYOUT_SYSTEM, user: layoutUser(project, scene), signal, log, progress,
      check: answer => fromLayoutAnswer(scene, answer, ++tries < MAX_ROUNDS || !isWorld(project) ? others : [], log),
    })
  } catch (error) {
    if (signal.aborted || !(error instanceof FatalError)) throw error
    log(`${error.message} 改用保底摆法，可以在白模页手动调整。`)
    return { ...fallbackLayout(scene), plain: true }
  }
}
