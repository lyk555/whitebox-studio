// From what a person typed to a story that can be played: chapters and anchors, then the map of places, then each anchor
// written as a script and broken into what gets filmed. Each stage can be looked at and changed before the next.
//
// Drama is left to the writers and to who reads them. What is checked in code is only what filming needs, or what would
// otherwise be lost: words on screen are taken from the script by code, so no later step can change what was written.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { walkThrough } from '../runtime/journey.js'
import { CLOSE_LIMITS, closeStage, MOST_WAYS } from '../runtime/shell.js'
import { askChecked, NOT_A_THING } from './breakdown.mjs'
import { config, ROOT } from './config.mjs'
import { FatalError } from './engine.mjs'
import { linesProblem } from './speech.mjs'
import { readProject, writeProject } from './store.mjs'
import { anchorsOf, anchorWords, chaptersOf, heldBefore, mapText, outlineText, seenBefore, settleWorld, worldProblems } from './world.mjs'

const NL = '\n'
const clean = value => String(value ?? '').trim()
const OUTLINE_TRIES = 3
const SECTION_TRIES = 3
const LOST_MESSAGES = 8 // Steps of one writer's conversation before it is told to stop thinking and hand in.
const craft = () => readFileSync(join(ROOT, 'platform', 'craft.md'), 'utf8').replace(/## 钱[\s\S]*$/, '').trim()

const FORM = `这部戏是这样看的：玩家操作主角，在一个个地方之间走动，走到一件件立在地上的大东西前（书桌、炉子、木箱，不是墙和门，也不是桌上的小东西），每走到一件就触发一小段电影镜头，看完再走向下一件。一个地方一屏，从出口走到相连的地方，也可以走回去。玩完也能连成一部片子。别的人物不走动，只在这些镜头里露面，一个镜头里除主角外最多两个人，一个镜头说的话一共不超过 46 个字。观众只能靠旁白和台词知道事情，字要写在画面里给人看的镜头拍不了。`
const WRITE_WELL = `## 这种短片最容易写坏的地方
- 整段都是主角一个人翻东西，旁白在解释。观众是来看人和人的。能让人当面说出来、吵出来、瞒出来的，就不要写成主角自己发现。人物当面的台词要占这一段的大头，你来我往好几个回合，一个镜头说不完就分到下一步。主角也不要对着空气说话。
- 旁白替观众想完了。“他是来探口风的”是替观众下结论；“他走的时候，眼睛一直落在我手边那张纸上”才让观众自己去想。
- 人物有问必答。问“那晚你在哪”，答“我在家”是念信息；答“您也查我？我老婆还在医院躺着”才是人。
- 对手一露面就招，或者主角靠别人赢。赢要靠主角自己做的一件事，让对手自己露馅。
- 线索一出现就解释。观众以后要用到的东西，放到他眼前就走，不解释，等后面回来打他一下。`

// Everything a writer does for one stage: its words, how much it used, what it is doing right now.
function roomFor({ provider, signal, log, progress, metric = () => {} }) {
  const model = config().writerModel
  const usage = { input: 0, output: 0 }
  const onUsage = used => {
    usage.input += used.prompt_tokens ?? 0
    usage.output += used.completion_tokens ?? 0
    metric('输入 token', usage.input)
    metric('输出 token', usage.output)
  }
  const say = async (system, user, { thinking = true, maxTokens = 16384, note = '' } = {}) => (await provider.chat({
    model, onUsage, signal, thinking, maxTokens,
    onProgress: text => progress(note ? `${note} · ${text}` : text),
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  })).content
  // A judge's answer that comes back malformed says nothing about the work. After a few tries it is left out of the decision.
  const judge = async (system, user, options) => {
    for (let tries = 1; tries <= 3; tries++) {
      try {
        const text = await say(system, user, options)
        return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
      } catch (error) {
        if (signal.aborted) throw error
        if (tries === 3) log(`这一轮没有读到评审的结论：${error.message}`)
      }
    }
    return null
  }
  return { model, onUsage, say, judge, signal, log, progress, provider }
}

// ---------------------------------------------------------------- chapters and anchors
const ASK_WRITERS = [{ type: 'function', function: { name: 'ask_writers', description: '把一个问题同时交给几个编剧，各想各的，全部答案一起给你。', parameters: { type: 'object', properties: { question: { type: 'string' }, how_many: { type: 'number' } }, required: ['question'] } } }]

const outlineWriter = () => `你是编剧，现在还不写剧本，先定这个故事的章节和锚点。

导演可能写了一段完整的故事，也可能只给了一个梗概或题材。写全了的，人物、情节和结局都照他的，你负责分章和定锚点，缺的补上；只是梗概的，把它想成一个真正的故事，想清楚真正发生了什么。

章节是一段有自己开头和收尾的戏，看完一章，观众想接着看下一章。章节不是地点：一章通常发生在几个相连的地方，玩家在它们之间来回走，前面去过的地方后面也可以回去。

锚点是观众亲身经历的转折时刻，不是地点，不是情节清单，也不是“走到书桌前看到一封信”这样的步骤，主角具体走到哪件东西前是后面写戏时的事。每个锚点写清楚：观众到这一刻之前以为什么，这一刻发生了什么，之后他以为什么、想知道什么。一条线索被发现不算转折，它推翻了观众相信的东西才算。转折多半发生在人和人之间：谁骗了谁，谁翻了脸，谁其实一直知道。一个锚点是一段戏，要走过好几个地方或好几件东西才到得了，不是一个动作。开头抓住人的那一刻和最后留下的那个画面也是锚点。几章、每章几个锚点都由你定，一个完整的故事要有它该有的分量。

玩家可以在地方之间来回走，所以同一章里的锚点往往不必分先后，比如先去问谁、先去哪里都行，这时玩家才真正有得选。不分先后的锚点最好发生在不同的地方，玩家选的就是先去哪。它们不能依赖彼此的内容。一章的最后一个锚点总是最后发生。

你最先想到的点子别人也想得到，往后再想一步，可以先让几个编剧各想各的（工具 ask_writers），他们看不到你的东西，问题里要写清楚他们需要知道的。

${FORM}

${craft()}

想好后，不调用工具，直接输出，格式：
【真相】真正发生了什么，谁做了什么，为什么，观众看不到这段
【第 1 章：章名】这一章讲什么，一句
【锚点 1：名字】之前以为…；发生…；之后以为…
【锚点 2：名字】之前以为…；发生…；之后以为…
【锚点 3：名字｜等锚点 1】之前以为…；发生…；之后以为…
【第 2 章：章名】……

锚点默认一个接一个。写“｜等锚点 1”的意思是这个锚点只要等锚点 1 之后就能发生，和锚点 2 不分先后。不是这种情况就不要写。锚点编号全片连续。`

const OUTLINE_JUDGE = `你是制片人。这是一个故事还没写成剧本时的真相、章节和转折。开拍很贵，多数点子都平庸。你和作者不熟，不用客气。

问自己：这些转折观众猜得到吗？揭开时是否意外又服气？有没有一个时刻观众看完会跟别人说起？主角是靠自己赢的吗？分量够不够一个完整的故事？看完一章还想看下一章吗？

导演写定的人物、情节和结局作者不能改，不要因为这些退回。

只说哪里不行，不说怎么改。只输出 JSON：{ "verdict": "值得写 或 不值得写", "why": "最要命的问题，或者最打动你的地方", "keep": "值得留下的东西，没有就写 没有" }`

// The words as the writer wrote them, cut at its headings. Anything short of chapters with anchors in them goes back.
export function parseOutline(text) {
  let truth = ''
  const chapters = []
  let into = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^[\s#*>-]+/, '').trimEnd()
    const truthAt = line.match(/^【真相】(.*)$/)
    const chapterAt = line.match(/^【第\s*(\d+)\s*章\s*[：:]?\s*(.*?)】(.*)$/)
    const anchorAt = line.match(/^【锚点\s*(\d+)\s*[：:]?\s*(.*?)】(.*)$/)
    if (truthAt) {
      truth = truthAt[1]
      into = { add: more => { truth += more } }
    } else if (chapterAt) {
      const chapter = { title: chapterAt[2].trim(), summary: chapterAt[3].trim(), found: [] }
      chapters.push(chapter)
      into = { add: more => { chapter.summary += more } }
    } else if (anchorAt) {
      if (!chapters.length) throw new Error(`锚点 ${anchorAt[1]} 前面没有“【第 1 章：章名】”。`)
      const [title, waits] = anchorAt[2].split(/[｜|]\s*等/)
      const anchor = { label: anchorAt[1], title: title.trim(), waits: [...String(waits ?? '').matchAll(/\d+/g)].map(found => found[0]), words: anchorAt[3] }
      chapters.at(-1).found.push(anchor)
      into = { add: more => { anchor.words += more } }
    } else if (into && line.trim()) {
      into.add(line.trim())
    }
  }
  const empty = chapters.find(chapter => !chapter.found.length)
  if (!chapters.length || empty) throw new Error(empty ? `“${empty.title}”这一章没有锚点。` : '没有看到“【第 1 章：章名】”和“【锚点 1：名字】”这样的章节和锚点，请按格式输出。')
  if (!clean(truth)) throw new Error('没有看到“【真相】”。')
  let next = 1
  return {
    truth: clean(truth),
    chapters: chapters.map((chapter, chapterIndex) => {
      const labels = new Map()
      return {
        id: `ch${chapterIndex + 1}`, title: chapter.title, summary: clean(chapter.summary),
        anchors: chapter.found.map((anchor, index) => {
          const id = `a${next++}`
          const parts = anchor.words.match(/之前(?:以为)?[：:]?\s*(.*?)[；;。]\s*发生[：:]?\s*(.*?)[；;。]\s*之后(?:以为)?[：:]?\s*(.*)$/s)
          if (!anchor.title || !parts) throw new Error(`锚点 ${anchor.label} 要有名字，并且写清“之前以为…；发生…；之后以为…”。`)
          const previous = chapter.found[index - 1]
          const needs = anchor.waits.length ? anchor.waits.flatMap(label => (labels.has(label) ? [labels.get(label)] : [])) : previous ? [labels.get(previous.label)] : []
          labels.set(anchor.label, id)
          return { id, title: anchor.title, before: clean(parts[1]), happens: clean(parts[2]), after: clean(parts[3]), needs }
        }),
      }
    }),
  }
}

async function outlineDraft(room, brief) {
  const { provider, model, onUsage, signal, log, say, progress } = room
  const messages = [{ role: 'system', content: outlineWriter() }, { role: 'user', content: brief }]
  for (let step = 0; step < LOST_MESSAGES; step++) {
    const reply = await provider.chat({ model, onUsage, signal, thinking: true, maxTokens: 16384, messages, tools: ASK_WRITERS, onProgress: progress })
    messages.push({ role: 'assistant', content: reply.content, ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}) })
    if (!reply.toolCalls.length) {
      try {
        return { text: reply.content, outline: parseOutline(reply.content) }
      } catch (error) {
        messages.push({ role: 'user', content: `${error.message} 请按格式完整输出。` })
        continue
      }
    }
    for (const call of reply.toolCalls) {
      let result
      try {
        const args = JSON.parse(call.function.arguments || '{}')
        log(`问几位编剧：${String(args.question).slice(0, 60)}`)
        const answers = await Promise.all(Array.from({ length: Math.min(6, Math.max(2, Number(args.how_many) || 4)) }, () => say('你是想象力很好的类型片编剧，朋友问你一个问题。你最先想到的多半别人也想得到，往后再想一步。说清楚具体的东西，不说空话。', args.question, { maxTokens: 8192 })))
        result = answers.map((answer, index) => `编剧 ${index + 1}：${answer}`).join(NL + NL)
      } catch (error) {
        if (signal.aborted) throw error
        result = `没有成功：${error.message}`
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result })
    }
  }
  throw new FatalError('写满了步数也没有定下章节和锚点。')
}

export async function writeOutline({ project, provider, signal, log, progress, metric }) {
  const story = clean(project.story)
  if (!story) throw new FatalError('还没有故事。')
  if (!provider.chat) return dryOutline(story)
  const room = roomFor({ provider, signal, log, progress, metric })
  let brief = `导演写的：${NL}${story}`
  let draft = null
  for (let round = 1; round <= OUTLINE_TRIES; round++) {
    progress(`第 ${round} 次构思`)
    draft = await outlineDraft(room, brief)
    progress('制片人在看')
    const verdict = await room.judge(OUTLINE_JUDGE, `导演写的：${NL}${story}${NL}${NL}作者的章节和锚点：${NL}${draft.text}`, { maxTokens: 4096, note: '制片人在看' })
    if (!verdict || /^值得写/.test(clean(verdict.verdict))) break
    log(`制片人退回第 ${round} 稿：${clean(verdict.why).slice(0, 200)}`)
    if (round === OUTLINE_TRIES) {
      log('写了几稿都没过制片人这一关，留下最后一稿。可以在这一页告诉 Agent 怎么改。')
      break
    }
    brief = `导演写的：${NL}${story}${NL}${NL}前面有人想过一版，你看不到它，从头想一个真正不同的。它被制片人退回的原因：${clean(verdict.why)}${clean(verdict.keep) && clean(verdict.keep) !== '没有' ? `${NL}他觉得值得留下的：${clean(verdict.keep)}` : ''}`
  }
  return draft.outline
}

// ---------------------------------------------------------------- the map of places
const WORLD_SYSTEM = `你是这部互动电影的关卡设计兼美术指导，现在设计它的地点图：有哪些地方，它们怎么连起来，哪条路什么时候打开。只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。`

const worldUser = project => `导演写的：
${project.story}

真相（观众看不到）：
${project.truth}

章节和锚点：
${outlineText(project)}

人物：${project.cast.map(person => `${person.name}（${person.playable ? '主角，玩家操作' : '配角'}）`).join('、')}

${FORM}

地点图本身也在讲故事，它不是一条路线。这些是经验，不适用就别用：
- 玩家要有地方可走、有路可选。常见的做法是有一个枢纽，从枢纽能去几个地方，做完一处回到枢纽再去下一处。不分先后的锚点放在不同的地方，玩家选的就是先去哪。
- 不要一章一个地方，也不要一条直线走到底，那样玩家只是在往前走，地点图就没有意义。只有故事真的只能这样走时才这样画，并且在 design 里说清为什么。
- 想好哪条路一开始走不通、等哪个锚点之后才打开，打开时观众为什么会有感觉。只有这种路才写 opens_after，不要给每条路都上锁。
- 回到去过的地方，同一个地方讲新的事，观众会发现变了。能回来的地方往往比多一个新地方更值。章节结束也不等于离开，前面的地方后面还能回去。
- 每个地方都要一整套布景和一段开场视频，贵，路过的地方也一样，不要为了像迷宫而绕路。

拍摄的限制，这些不能违反：
- 每个地方是一屏固定的画面，相机正对这个地方的远端。宽 ${CLOSE_LIMITS.width[0]} 到 ${CLOSE_LIMITS.width[1]} 米，进深是宽度的将近一半。小房间大约 10×4.9，仓库或大厅大约 12×5.8，广场、庭院或林中空地大约 14×6.8。再大的地方取其中最有戏的一片。
- 一个地方最多 ${MOST_WAYS} 个出口，都在远端边界上。at 是出口从左到右的位置，0.12 到 0.88，同一个地方的两个出口至少隔 0.24。两个地方之间只有一条路。
- 出口要符合这个地方：有门的 kind 写 door；门洞、小路、楼梯、巷口这种 kind 写 opening。
- 画面和视频里不能有文字，place 不要写海报、招牌、书法这类带字的东西。place 要写清墙面和地面的颜色与材质。
- 第一次走进一个地方时会放一段开场视频，以后回来就不放了。玩家先去哪里可能不一样，所以开场旁白和开场视频只写这个地方本身，不提前面发生过的事。

输出：
{
  "design": "这张地点图的想法，两三句，导演要读：玩家怎么走，枢纽在哪，哪条路为什么后来才通。写地点和锚点的名字，不写编号",
  "start": 从第几个地方开始（数字，从 1 开始）,
  "places": [
    {
      "title": "地点名",
      "kind": "indoor 或 outdoor",
      "width": 宽度（米）,
      "depth": 进深（米）,
      "edges": "这个地方四周是什么，一句：室内写墙，室外写围栏、树丛、建筑立面或远处的景色",
      "place": "这个地方是什么样，写四周、地面和整体环境，一两句",
      "mood": "光线和色调，一两句，像电影布光：主光从哪来，照亮哪里，哪里沉入暗部，冷暖怎么对比。只写看得见的光，不写声音",
      "opening_line": "第一次走进这里时屏幕上的一句旁白，第一人称，短，具体",
      "opening_action": "开场视频：从这里一件有代表性的东西特写开始，镜头后拉，主角走进来停下背对镜头。全程不露脸",
      "opening_sound": "这段视频的环境声和动作声"
    }
  ],
  "links": [
    {
      "a": 地点序号, "b": 地点序号,
      "a_exit": { "name": "从 a 这边看这条路是什么，如：铁门、石拱门洞、向下的楼梯", "kind": "door 或 opening", "at": 0.3, "beyond": "走过去之后看到什么样，一句" },
      "b_exit": { "name": "从 b 这边看这条路是什么", "kind": "door 或 opening", "at": 0.7, "beyond": "一句" },
      "opens_after": "这条路等哪个锚点之后才通，写锚点编号如 a3；一开始就通就留空",
      "locked": "路还没通时玩家走过去看到的一句话，第一人称；一开始就通就留空",
      "one_way": false
    }
  ],
  "anchors": [{ "id": "a1", "places": [这个锚点发生在哪些地方的序号] }]
}
one_way 只有真的回不去时才写 true（比如跳下去的深井），这时只有从 a 到 b。`

export const exitFrom = (raw, index, to, title, link) => ({
  id: `x${index + 1}`, to, name: clean(raw?.name) || '路口', kind: raw?.kind === 'door' ? 'door' : 'opening', ...(Number.isFinite(Number(raw?.at)) && raw?.at !== null && raw?.at !== '' ? { at: Number(raw.at) } : {}),
  beyond: clean(raw?.beyond), prompt: `按 E 去${title}`, ...(link.opensAfter ? { opensAfter: link.opensAfter, locked: link.locked } : {}),
})

export function checkWorldAnswer(answer, project) {
  const list = Array.isArray(answer.places) ? answer.places : []
  if (!list.length) throw new Error('places 是空的。')
  const faults = []
  const anchorIds = anchorsOf(project).map(anchor => anchor.id)
  const scenes = list.map((place, index) => {
    if (!clean(place.title) || !clean(place.place)) faults.push(`第 ${index + 1} 个地方缺 title 或 place。`)
    if (!clean(place.opening_action)) faults.push(`“${clean(place.title)}”缺 opening_action，第一次走进来的开场视频要写。`)
    return {
      id: `s${index + 1}`, title: clean(place.title), paint: 'relaxed', stage: closeStage({ kind: place.kind, width: place.width, depth: place.depth, exit: 'opening' }),
      edges: clean(place.edges), place: clean(place.place), mood: clean(place.mood), openingLine: clean(place.opening_line), exits: [], props: [], carried: [], beats: [], objects: [],
      film: { opening: { action: clean(place.opening_action), sound: clean(place.opening_sound) } },
    }
  })
  const titles = new Set()
  for (const scene of scenes) {
    if (titles.has(scene.title)) faults.push(`有两个地方都叫“${scene.title}”，地点名不能重复。`)
    titles.add(scene.title)
  }
  const placeAt = (value, what) => {
    const scene = scenes[Number(value) - 1]
    if (!scene) faults.push(`${what}写的是 ${value}，只有 1 到 ${scenes.length}。`)
    return scene
  }
  const seenPairs = new Set()
  for (const raw of Array.isArray(answer.links) ? answer.links : []) {
    const a = placeAt(raw.a, 'links 的 a')
    const b = placeAt(raw.b, 'links 的 b')
    if (!a || !b) continue
    if (a === b) {
      faults.push(`“${a.title}”不能连到它自己。`)
      continue
    }
    const pair = [a.id, b.id].sort().join()
    if (seenPairs.has(pair)) faults.push(`“${a.title}”和“${b.title}”之间写了两条路，只能有一条。`)
    seenPairs.add(pair)
    const opensAfter = clean(raw.opens_after)
    if (opensAfter && !anchorIds.includes(opensAfter)) faults.push(`opens_after 写的是“${opensAfter}”，锚点只有：${anchorIds.join('、')}。`)
    const link = { opensAfter: anchorIds.includes(opensAfter) ? opensAfter : '', locked: clean(raw.locked) }
    a.exits.push(exitFrom(raw.a_exit, a.exits.length, b.id, b.title, link))
    if (raw.one_way !== true) b.exits.push(exitFrom(raw.b_exit, b.exits.length, a.id, a.title, link))
  }
  for (const scene of scenes) {
    if (scene.exits.length > MOST_WAYS) faults.push(`“${scene.title}”有 ${scene.exits.length} 个出口，最多 ${MOST_WAYS} 个：通向 ${scene.exits.map(exit => scenes.find(other => other.id === exit.to).title).join('、')}。去掉一些，或者加一个中转的地方。`)
  }
  const where = {}
  for (const id of anchorIds) {
    const found = (Array.isArray(answer.anchors) ? answer.anchors : []).find(item => clean(item.id) === id)
    const places = (Array.isArray(found?.places) ? found.places : []).map(value => placeAt(value, `锚点 ${id} 的 places`)).filter(Boolean)
    if (!places.length) faults.push(`锚点 ${id} 没有写发生在哪些地方。`)
    where[id] = places.map(scene => scene.id)
  }
  const start = placeAt(answer.start, 'start')
  if (faults.length) throw new Error(faults.join(' '))
  // Whether the story can be walked, before anything has been written in it: one step for each place an anchor happens in.
  const walked = walkThrough({
    start: start.id,
    chapters: chaptersOf(project).map(chapter => ({ id: chapter.id, title: chapter.title, anchors: chapter.anchors.map(anchor => ({ id: anchor.id, title: anchor.title, needs: anchor.needs ?? [], steps: where[anchor.id].map((scene, index) => ({ scene, beat: `${anchor.id}-${index}`, objective: anchor.title })) })) })),
    places: Object.fromEntries(scenes.map(scene => [scene.id, { title: scene.title, exits: scene.exits }])),
  })
  if (walked.problems.length) throw new Error(`这样走不通：${walked.problems.join(' ')} 把路接上，或者让那条路早点打开。`)
  return { design: clean(answer.design), start: start.id, scenes, where }
}

export async function designWorld({ project, provider, signal, log, progress }) {
  if (!anchorsOf(project).length) throw new FatalError('还没有章节和锚点。')
  if (!provider.text) return dryWorld(project)
  return askChecked({ provider, system: WORLD_SYSTEM, user: worldUser(project), check: answer => checkWorldAnswer(answer, project), signal, log, progress, model: config().writerModel, thinking: true })
}

// ---------------------------------------------------------------- the script of one anchor
const sectionWriter = () => `你是编剧。整部戏的真相、章节和转折已经定了，地点图也定了，你只负责其中一个锚点，让观众真的经历这个转折。

${FORM}

${craft()}

${WRITE_WELL}

先规划，再写。一个转折很少靠走到一件东西前就能发生：观众得先被带着相信一件事、在意一个人，那个转折才推得翻他。所以规划这一段里的每一小步：在地点图的哪些地方，一个地方有哪些大东西，主角依次走到哪几件前，每一件上观众看到什么、多相信了什么或多怀疑了什么，谁在，他想要什么、瞒着什么，主角在这里主动做了什么。这一段该多长就多长，给够铺垫，不要匆匆带过：只走到一件东西前、说一句话，转折是发生不了的。

输出两部分，中间单独一行写 ===：
上面是你的规划，观众看不到。
下面是这一段的剧本，观众看到的就是它，格式（方括号里直接写地点图上的地点名，一字不差）：
【地点名】
旁白：一句主角心里的话或看到的东西
主角去做：主角走到某件东西前做的事
旁白：做的时候看到什么
人物全名：说的话

人物说话只能写在“主角去做”后面，那是他们露面的镜头。主角说话也写他的全名。只写这一段，不要写到下一个转折去。`

const SECTION_CHECK = `作者给这一段定的意图是观众经历一个转折。下面有这个意图、这一段的剧本，以及一位第一次看的观众看到这里时的真实反应。判断这位观众是不是被这一段带到了意图里“之后”的状态：他现在的想法和好奇，是不是作者想让他有的。不要求他复述之前的想法，也不要求他用同样的字眼。他早就猜到了、没看懂、或者只是被旁白告知而毫无感觉，才算没有。只说哪里没发生，不说怎么改。只输出 JSON：{ "landed": true 或 false, "why": "一两句，引用观众的话" }`
const VIEWER_NOW = '你第一次看这部片子，只知道下面这些。照实说你现在怎么想：你以为是怎么回事，刚才有没有哪一刻吃惊，猜接下来会怎样，还想不想看，哪里走神或看不懂。不要替作者圆，不提修改建议，就像跟朋友聊。'
const WHOLE_JUDGE = `你是制片人，决定一部互动短片的剧本能不能开拍。这部戏是一段一段写的。开拍很贵，多数稿子都不够好。下面有转折表、按段标好号的剧本，以及两位读者的反应。指出最拖后腿的段落，只说哪里不行，不说怎么改。只输出 JSON：
{ "verdict": "能开拍 或 不能开拍", "weak": [{ "section": 段号数字, "why": "这一段最要命的问题，引用原句" }], "why": "整体一段话" }
weak 最多 3 条。`

// A heading however it was written: 【书房】, 【地点】书房, 【地点：书房】, 【第 2 场：书房】. Null for anything else.
function titleOf(line) {
  const match = line.trim().match(/^【([^】]*)】(.*)$/)
  if (!match) return null
  return `${match[1]}${match[2]}`.replace(/^第\s*\d+\s*场[：:]?\s*/, '').replace(/^地点[：:]?\s*/, '').trim() || null
}

// Who a line is said by, however it was labelled: 汤姆, 汤姆（守夜人）, 格雷汉姆探长（画外）, 主角. Anyone not on the cast stays as written.
const whoSays = (label, names, player) => {
  if (label === '主角') return player
  const plain = label.replace(/[（(].*?[）)]/g, '').trim()
  return names.find(name => name === plain) ?? names.find(name => name.includes(plain) || plain.includes(name)) ?? plain
}

// The script as steps. What is on screen is read from here by code, so nothing after this can change a word of it.
export function parseScript(text, player, names = [player]) {
  const steps = []
  let place = ''
  let waiting = []
  let current = null
  const said = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const title = titleOf(line)
    if (title) {
      place = title
      current = null
      continue
    }
    const match = line.match(/^([^：:]{1,20})[：:]\s*(.*)$/)
    const label = match?.[1].trim()
    if (label === '主角去做') {
      current = { place, doing: match[2], early: waiting, during: [], lines: [], after: [] }
      waiting = []
      steps.push(current)
    } else if (match && label !== '旁白') {
      if (current) current.lines.push({ who: whoSays(label, names, player), says: match[2] })
      else said.push(label)
    } else {
      // Words with no label above them still reach the audience. Nothing may be dropped.
      const words = match ? match[2] : line
      if (!current) waiting.push(words)
      else (current.lines.length ? current.after : current.during).push(words)
    }
  }
  if (waiting.length && steps.length) steps.at(-1).after.push(...waiting)
  return {
    orphans: said,
    steps: steps.map(step => {
      const told = [...step.early, ...step.during]
      const quiet = !step.lines.length
      return { place: step.place, doing: step.doing, lines: step.lines, during: (quiet ? told.slice(0, 1) : told).join(''), after: [...(quiet ? told.slice(1) : []), ...step.after].join('') }
    }),
  }
}

const findPlace = (title, scenes) => scenes.find(scene => scene.title === title) ?? scenes.find(scene => title && (scene.title.includes(title) || title.includes(scene.title)))

// Places that can be walked to by the time this anchor starts, whichever order the rest was taken in.
export function reachableAt(project, anchor) {
  const { surely } = seenBefore(project, anchor)
  const done = new Set(surely.map(other => other.id))
  const reached = new Set([project.start, ...surely.flatMap(other => [...(other.where ?? []), ...(other.steps ?? []).map(step => step.scene)])])
  const queue = [...reached]
  while (queue.length) {
    const id = queue.shift()
    const here = project.scenes.find(scene => scene.id === id)
    for (const exit of here?.exits ?? []) {
      if ((exit.opensAfter && !done.has(exit.opensAfter)) || reached.has(exit.to)) continue
      reached.add(exit.to)
      queue.push(exit.to)
    }
  }
  return project.scenes.filter(scene => reached.has(scene.id))
}

// What cannot be filmed is the one thing code decides about a script.
export function filmingProblems(text, project, places) {
  const player = project.cast.find(person => person.playable)?.name
  const names = project.cast.map(person => person.name)
  const { steps, orphans } = parseScript(text, player, names)
  const problems = []
  if (!steps.length) problems.push('这一段没有“主角去做”。')
  if (orphans.length) problems.push(`${[...new Set(orphans)].join('、')}的话写在了第一个“主角去做”之前，人物只能在走到东西前的镜头里说话。`)
  steps.forEach((step, index) => {
    const label = `第 ${index + 1} 步（${step.doing.slice(0, 16)}）`
    if (!findPlace(step.place, places)) problems.push(`${label}在“${step.place || '没写地点'}”，这不是现在走得到的地方。现在走得到的是：${places.map(scene => scene.title).join('、')}。`)
    const others = [...new Set(step.lines.map(line => line.who))].filter(who => who !== player)
    const stranger = others.find(who => !names.includes(who))
    if (stranger) problems.push(`${label}是“${stranger}”在说话，但人物表里没有这个名字。只有人物表里的人能开口，并且说话的人就在这个镜头里露面，没有画外音。“旁白”和“主角去做”之外，每行开头必须是人物全名。人物表：${names.join('、')}。`)
    if (others.length > 2) problems.push(`${label}有 ${others.join('、')} 在说话，一个镜头里除主角外最多两个人，分到不同的步骤。`)
    const tooLong = linesProblem({ face: '有', faceCast: others, lines: step.lines }, project.cast, label)
    if (tooLong && !stranger) problems.push(tooLong)
  })
  return problems
}

// What follows the plan. A writer who left out the line between them still starts the script at its first heading,
// or the plan would reach the audience as narration.
const scriptOnly = answer => {
  const split = answer.lastIndexOf(`${NL}===`)
  if (split >= 0) return answer.slice(split).replace(/^\s*===\s*/, '').trim()
  const heading = answer.indexOf('【')
  return (heading >= 0 ? answer.slice(heading) : answer).trim()
}
const planOnly = answer => {
  const split = answer.lastIndexOf(`${NL}===`)
  return split >= 0 ? answer.slice(0, split).trim() : ''
}

const joined = anchors => anchors.filter(anchor => anchor.script).map(anchor => anchor.script).join(NL + NL)

async function writeSection(room, project, anchor, notes = '') {
  const { say, judge, log } = room
  const places = reachableAt(project, anchor)
  const { surely, maybe } = seenBefore(project, anchor)
  const before = joined(surely)
  const brief = () => `导演写的：
${project.story}

真相（观众看不到）：
${project.truth}

章节和转折：
${outlineText(project)}

地点图：
${mapText(project)}

人物：${project.cast.map(person => `${person.name}${person.playable ? '（主角，玩家操作）' : ''}：${person.personality}`).join('；')}

你负责 ${anchor.id}：
${anchorWords(anchor)}
这个转折主要发生在：${(anchor.where ?? []).map(id => project.scenes.find(scene => scene.id === id)?.title).filter(Boolean).join('、') || '由你定'}
这时走得到的地方：${places.map(scene => scene.title).join('、')}

观众到这里之前一定已经看到的：
${before || '（这是开头，他什么都还没看到）'}
${maybe.length ? `${NL}玩家可以先做这一段，也可以先做这些，你不能依赖它们的内容，也不能和它们矛盾：${maybe.map(other => other.title).join('、')}${NL}` : ''}`
  let attempt = null
  let trouble = notes
  for (let round = 1; round <= SECTION_TRIES; round++) {
    const note = `${anchor.title} · 第 ${round} 稿`
    const answer = await say(sectionWriter(), `${brief()}${trouble ? `${NL}上一位写这一段的人被退回了，他的稿子你看不到，你从头写。退回的原因：${NL}${trouble}${NL}` : ''}`, { note })
    let text = scriptOnly(answer)
    // Too many words in a shot is a matter of a line or two. It costs neither the drama nor a try.
    let problems = filmingProblems(text, project, places)
    for (let fix = 0; problems.length && fix < 2; fix++) {
      log(`${anchor.title}：第 ${round} 稿有 ${problems.length} 处拍不了，只改这几处`)
      text = scriptOnly(await say('下面这段剧本有几处拍不了。只改这几处，其他每个字都不动，输出改好后的整段剧本，不要解释。', `拍不了的地方：${NL}${problems.join(NL)}${NL}${NL}剧本：${NL}${text}`, { thinking: false, note: `${anchor.title} · 改拍不了的地方` }))
      problems = filmingProblems(text, project, places)
    }
    // Nothing a viewer could say would make it something that can be filmed.
    if (problems.length) {
      trouble = `拍不了：${problems.join(' ')}`
      attempt ??= { script: text, plan: planOnly(answer), viewer: '', landed: false, why: '', problems }
      continue
    }
    const reaction = await say(VIEWER_NOW, [before, text].filter(Boolean).join(NL + NL), { thinking: false, maxTokens: 2048, note: `${anchor.title} · 观众在看` })
    const check = await judge(SECTION_CHECK, `意图：${NL}${anchorWords(anchor)}${NL}${NL}这一段：${NL}${text}${NL}${NL}观众的反应：${NL}${reaction}`, { maxTokens: 4096, note: `${anchor.title} · 看转折有没有发生` })
    const landed = check?.landed === true
    attempt = { script: text, plan: planOnly(answer), viewer: reaction, landed, why: clean(check?.why), problems }
    log(`${anchor.title}：第 ${round} 稿 ${text.length} 字，${landed ? '转折发生了' : `没发生：${clean(check?.why).slice(0, 80)}`}`)
    if (landed) break
    trouble = `${clean(check?.why)}${NL}观众当时的反应：${reaction}`
  }
  if (attempt.problems.length) throw new FatalError(`“${anchor.title}”写了 ${SECTION_TRIES} 稿都有拍不了的地方：${attempt.problems.join(' ')}`)
  return attempt
}

const saveAnchor = async (id, anchorId, change) => {
  const project = await readProject(id)
  const anchor = anchorsOf(project).find(other => other.id === anchorId)
  change(anchor, project)
  await writeProject(project)
  return project
}

async function reviewWhole(room, project) {
  const { say, judge, log, progress } = room
  const anchors = anchorsOf(project)
  const whole = joined(anchors)
  progress('两位读者在读全片')
  const [peer, viewer] = await Promise.all([
    say('你写了二十年类型片，朋友把稿子给你看，他要真话。说你真正相信什么、不信什么，哪里是套路，哪里你早就猜到，人物哪里活、哪里是假的。不打分，不客气，不替他想怎么改。', whole, { thinking: false, maxTokens: 4096, note: '同行在读全片' }),
    say(VIEWER_NOW, whole, { thinking: false, maxTokens: 4096, note: '观众在看全片' }),
  ])
  const review = await judge(WHOLE_JUDGE, `转折表：${NL}${outlineText(project)}${NL}${NL}${anchors.map((anchor, index) => `--- 第 ${index + 1} 段 ---${NL}${anchor.script}`).join(NL + NL)}${NL}${NL}写戏的同行说：${NL}${peer}${NL}${NL}第一次看的观众说：${NL}${viewer}`, { maxTokens: 8192, note: '制片人在看全片' })
  if (!review) return []
  log(`制片人看全片：${clean(review.verdict)}。${clean(review.why).slice(0, 300)}`)
  if (/^能开拍/.test(clean(review.verdict))) return []
  return (Array.isArray(review.weak) ? review.weak : []).slice(0, 3).flatMap(weak => {
    const anchor = anchors[Number(weak.section) - 1]
    return anchor ? [{ anchor: anchor.id, why: clean(weak.why) }] : []
  })
}

// ---------------------------------------------------------------- from script to what gets filmed
const CLERK_SYSTEM = `你是场记，把写好的剧本拆成拍摄步骤。旁白和台词已经定了，不归你管，你只补拍摄需要的东西。只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。`

function clerkUser(project, anchor, steps, held) {
  const player = project.cast.find(person => person.playable)
  const objectsIn = scene => [...new Set(scene.beats.map(beat => beat.objectName))]
  return `美术风格：${project.style || '还没定'}
人物表：${project.cast.map(person => `${person.name}${person.playable ? '（主角）' : ''}`).join('、')}
地方：
${[...new Set(steps.map(step => step.place))].map(title => {
    const scene = findPlace(title, project.scenes)
    return `“${scene.title}”：${scene.place} 这里已经用过的东西（可以再用，也可以添新的）：${objectsIn(scene).join('、') || '没有'}`
  }).join('\n')}
主角这时手里一定有的道具：${[...held].join('、') || '没有'}

这一段的剧本：
${anchor.script}

要拍的步骤，共 ${steps.length} 步：
${steps.map((step, index) => `第 ${index + 1} 步，在“${step.place}”：主角去做：${step.doing}${step.during ? `。旁白：${step.during}` : ''}${step.lines.length ? `。台词：${step.lines.map(line => `${line.who}：${line.says}`).join(' / ')}` : ''}`).join('\n')}

输出：
{
  "steps": [
    {
      "objective": "屏幕上显示的目标，让玩家知道接下来去做什么，一句，如：在书架上找那本书",
      "object": "这一步要互动的具体物件，如：书架",
      "prompt": "靠近时的按键提示，如：按 E 找书",
      "too_early": "还没轮到这一步时靠近会看到的一句话",
      "action": "这次交互的视频内容：分镜头写人物的手怎么碰到这件东西、做了什么、看到了什么，全程不露脸，只有背影、肩膀和手",
      "face": "一个露脸的中近景镜头，写谁在哪、表情和动作。这一步有台词就必须写；没有就留空",
      "face_cast": ["这个露脸镜头里除${player?.name ?? '主角'}外的人物名，和人物表一字不差，最多两个"],
      "settle": "可选：露脸镜头之后，回到原来构图之前的一个不露脸的特写",
      "sound": "这段视频的环境声和动作声，人说的话不写这里",
      "gives": ["完成后得到的道具 id，没有就是空数组"],
      "takes": ["这一步用掉的道具 id，没有就是空数组"]
    }
  ],
  "props": [{ "id": "英文小写短词", "name": "道具名", "look": "道具的样子" }]
}

要求：
- steps 正好 ${steps.length} 项，和上面的步骤一一对应，顺序不变。
- 物件必须是一开始就立在地上的完整家具或大件东西，不能是墙、门、窗、地面或人，也不能是另一件东西的一部分（暗格、抽屉、把手），也不能是互动之后才出现的东西。这些都写进它所属那件东西的 action 里。要和人说话，就绑在他身边的一件东西上（酒馆的吧台、办公室的账台）。
- action 里只有主角的手和背影，不能写别的人物。其他人物只能出现在 face 里。
- 视频和图片里不能有文字，不要写需要看清字的镜头。
- props 只列这一段新出现、并且 gives 里用到的道具。`
}

const propIdList = value => (Array.isArray(value) ? value : String(value ?? '').split(/[,，、\s]+/)).map(id => clean(id).toLowerCase().replace(/[^a-z0-9_]/g, '')).filter(Boolean)

export function checkClerkAnswer(answer, { project, steps, held, knownProps }) {
  const list = Array.isArray(answer.steps) ? answer.steps : []
  if (list.length !== steps.length) throw new Error(`steps 有 ${list.length} 项，要正好 ${steps.length} 项。`)
  const player = project.cast.find(person => person.playable)?.name
  const names = project.cast.map(person => person.name)
  const props = (Array.isArray(answer.props) ? answer.props : []).map(prop => ({ id: propIdList(prop.id)[0] ?? '', name: clean(prop.name), look: clean(prop.look) })).filter(prop => prop.id)
  const defined = new Set([...knownProps, ...props.map(prop => prop.id)])
  const inHand = new Set(held)
  const faults = []
  const beats = list.map((raw, index) => {
    const step = steps[index]
    const label = `第 ${index + 1} 步`
    const object = clean(raw.object)
    if (!clean(raw.objective) || !object) faults.push(`${label}缺 objective 或 object。`)
    if (NOT_A_THING.test(object)) faults.push(`${label}的“${object}”不能是互动的东西，墙、门、窗和地面摆不出来。换成立在地上的家具或大件。`)
    const action = clean(raw.action)
    if (!action) faults.push(`${label}没写 action。每次交互都要拍成视频。`)
    const stranger = names.find(name => name !== player && action.includes(name))
    if (stranger) faults.push(`${label}的 action 写到了${stranger}，不露脸的镜头里不能有别的人物，把他写进 face。`)
    const face = clean(raw.face)
    if (step.lines.length && !face) faults.push(`${label}有台词，要写 face，台词是在露脸镜头里说出来的。`)
    // Whoever speaks or is written into the shot is in the shot, or their portrait is never shown to the video model.
    const named = [...(Array.isArray(raw.face_cast) ? raw.face_cast.map(clean) : []), ...step.lines.map(line => line.who), ...names.filter(name => face.includes(name))]
    const faceCast = face ? [...new Set(named)].filter(name => name !== player && names.includes(name)) : []
    if (faceCast.length > 2) faults.push(`${label}的露脸镜头里有 ${faceCast.join('、')}，除主角外最多两个人。`)
    const takes = propIdList(raw.takes)
    const gives = propIdList(raw.gives).filter(id => !inHand.has(id) || takes.includes(id))
    for (const id of takes) {
      if (!inHand.has(id)) faults.push(`${label}要用掉 ${id}，但这时主角手里不一定有它。手里的是：${[...inHand].join('、') || '没有东西'}。`)
      inHand.delete(id)
    }
    for (const id of gives) {
      if (!defined.has(id)) faults.push(`${label}给的道具 ${id} 不在 props 里。`)
      inHand.add(id)
    }
    return {
      objective: clean(raw.objective), objectName: object, prompt: clean(raw.prompt) || '按 E 查看', tooEarly: clean(raw.too_early), during: step.during, after: step.after,
      performed: true, action, face, faceCast, settle: face ? clean(raw.settle) : '', sound: clean(raw.sound), ...(step.lines.length ? { lines: step.lines } : {}), gives, takes,
    }
  })
  if (faults.length) throw new Error(faults.join(' '))
  return { beats, props }
}

const nextBeatId = scene => `b${Math.max(0, ...scene.beats.map(beat => Number(beat.id.slice(1)) || 0)) + 1}`

// The steps of one anchor, put into the places they happen in.
export function placeSteps(project, anchor, steps, beats, props) {
  anchor.steps = steps.map((step, index) => {
    const scene = findPlace(step.place, project.scenes)
    const beat = { id: nextBeatId(scene), ...beats[index] }
    scene.beats.push(beat)
    return { scene: scene.id, beat: beat.id }
  })
  // Kept with the first place that needs it until settleWorld works out where it is first handed over.
  for (const prop of props) {
    if (project.scenes.some(scene => (scene.props ?? []).some(other => other.id === prop.id))) continue
    const giver = anchor.steps.find((_, index) => beats[index].gives.includes(prop.id))
    if (giver) project.scenes.find(scene => scene.id === giver.scene).props.push(prop)
  }
  settleWorld(project)
}

async function fileAnchor(room, id, anchorId) {
  const { provider, signal, log, progress } = room
  const project = await readProject(id)
  const anchor = anchorsOf(project).find(other => other.id === anchorId)
  const player = project.cast.find(person => person.playable)?.name
  const { steps } = parseScript(anchor.script, player, project.cast.map(person => person.name))
  // A step under no heading of its own carries on where the last one was.
  steps.forEach((step, index) => { step.place = findPlace(step.place, project.scenes)?.title ?? steps[index - 1]?.place ?? project.scenes.find(scene => scene.id === anchor.where?.[0])?.title ?? project.scenes[0].title })
  const held = heldBefore(project, anchor)
  const knownProps = project.scenes.flatMap(scene => (scene.props ?? []).map(prop => prop.id))
  const { beats, props } = await askChecked({
    provider, system: CLERK_SYSTEM, user: clerkUser(project, anchor, steps, held), rounds: 4,
    check: answer => checkClerkAnswer(answer, { project, steps, held, knownProps }),
    signal, log: message => log(`${anchor.title}：${message}`), progress: text => progress(`${anchor.title} · 拆拍摄步骤 · ${text}`),
  })
  await saveAnchor(id, anchorId, (saved, latest) => placeSteps(latest, saved, steps, beats, props))
}

export async function writeScripts({ id, provider, signal, log, progress, metric }) {
  const start = await readProject(id)
  if (!anchorsOf(start).length || !start.scenes.length) throw new FatalError('还没有章节、锚点和地点图。')
  if (!provider.chat) return dryScripts(id)
  const room = roomFor({ provider, signal, log, progress, metric })
  const total = anchorsOf(start).length
  // Saved one by one, so a stop halfway picks up where it was.
  for (const [index, { id: anchorId }] of anchorsOf(start).entries()) {
    const project = await readProject(id)
    const anchor = anchorsOf(project).find(other => other.id === anchorId)
    if (anchor.script) continue
    progress(`第 ${index + 1} / ${total} 个锚点 · ${anchor.title}`)
    const { script, plan, viewer, landed, why } = await writeSection(room, project, anchor)
    await saveAnchor(id, anchorId, saved => Object.assign(saved, { script, plan, viewer, landed, whyNot: landed ? '' : why }))
  }
  let project = await readProject(id)
  if (!project.scriptsReviewed) {
    for (const { anchor: anchorId, why } of await reviewWhole(room, project)) {
      project = await readProject(id)
      const anchor = anchorsOf(project).find(other => other.id === anchorId)
      progress(`重写 · ${anchor.title}`)
      log(`重写“${anchor.title}”：${why.slice(0, 120)}`)
      const { script, plan, viewer, landed, why: whyNot } = await writeSection(room, { ...project }, anchor, why)
      await saveAnchor(id, anchorId, saved => Object.assign(saved, { script, plan, viewer, landed, whyNot: landed ? '' : whyNot }))
    }
    project = await readProject(id)
    project.scriptsReviewed = true
    await writeProject(project)
  }
  for (const [index, { id: anchorId }] of anchorsOf(project).entries()) {
    const latest = await readProject(id)
    if (anchorsOf(latest).find(other => other.id === anchorId).steps?.length) continue
    progress(`第 ${index + 1} / ${total} 个锚点 · 拆拍摄步骤`)
    await fileAnchor(room, id, anchorId)
  }
  const finished = await readProject(id)
  const problems = worldProblems(settleWorld(finished))
  await writeProject(finished)
  if (problems.length) log(`写完后还有这些走不通的地方，要在开拍前解决：${problems.join(' ')}`)
  return finished
}

// ---------------------------------------------------------------- dry run
const sentencesOf = story => story.split(/(?<=[。！？!?\n])/).map(text => text.trim()).filter(Boolean)

export function dryOutline(story) {
  const said = sentencesOf(story)
  const line = (index, otherwise) => said[index] ?? otherwise
  const anchor = (id, title, index, needs) => ({ id, title, before: '还不知道发生了什么（试运行占位）', happens: line(index, title), after: '想知道接下来会怎样（试运行占位）', needs })
  return {
    truth: '试运行占位：没有填模型密钥时，章节和锚点都是占位内容。',
    chapters: [
      { id: 'ch1', title: '第一章（试运行）', summary: line(0, '故事的开始'), anchors: [anchor('a1', '开端', 0, []), anchor('a2', '走廊里的发现', 1, ['a1']), anchor('a3', '回到书房', 2, ['a1']), anchor('a4', '门开了', 3, ['a2', 'a3'])] },
      { id: 'ch2', title: '第二章（试运行）', summary: line(4, '故事的结局'), anchors: [anchor('a5', '仓库', 4, []), anchor('a6', '结局', 5, ['a5'])] },
    ],
  }
}

export function dryWorld(project) {
  const stage = (kind, width, depth) => closeStage({ kind, width, depth, exit: 'opening' })
  const place = (id, title, stageOf, exits) => ({
    id, title, paint: 'relaxed', stage: stageOf, edges: '灰褐色的墙', place: `${title}，灰褐色墙面，深色木地板。`, mood: '一盏暖灯是唯一的光，光池之外沉入暗部。', openingLine: `这里是${title}。`, exits, props: [], carried: [], beats: [], objects: [],
    film: { opening: { action: '从一件东西的特写开始，镜头后拉，人物走进来停下，背对镜头。', sound: '脚步声。' } },
  })
  const anchors = anchorsOf(project)
  const unlock = anchors[Math.min(3, anchors.length - 1)]?.id
  const scenes = [
    place('s1', '书房', stage('indoor', 10, 4.9), [{ id: 'x1', to: 's2', name: '木门', kind: 'door', at: 0.25, beyond: '一条走廊', prompt: '按 E 去走廊' }]),
    place('s2', '走廊', stage('indoor', 12, 5.8), [{ id: 'x1', to: 's1', name: '书房的门', kind: 'door', at: 0.2, beyond: '书房', prompt: '按 E 去书房' }, { id: 'x2', to: 's3', name: '铁门', kind: 'door', at: 0.75, beyond: '仓库', prompt: '按 E 去仓库', ...(unlock ? { opensAfter: unlock, locked: '铁门锁着。' } : {}) }]),
    place('s3', '仓库', stage('indoor', 12, 5.8), [{ id: 'x1', to: 's2', name: '铁门', kind: 'door', at: 0.5, beyond: '走廊', prompt: '按 E 去走廊', ...(unlock ? { opensAfter: unlock, locked: '铁门锁着。' } : {}) }]),
  ]
  const spots = ['s1', 's2', 's1', 's2', 's3', 's1']
  return { design: '试运行占位：书房和走廊相连，走廊尽头的铁门等第一章结束才打开。', start: 's1', scenes, where: Object.fromEntries(anchors.map((anchor, index) => [anchor.id, [spots[index % spots.length]]])) }
}

async function dryScripts(id) {
  const project = await readProject(id)
  const THINGS = { s1: ['长桌', '书架'], s2: ['木箱', '长凳'], s3: ['货堆', '铁柜'] }
  const player = project.cast.find(person => person.playable)
  const other = project.cast.find(person => !person.playable)
  const list = anchorsOf(project)
  list.forEach((anchor, index) => {
    const where = anchor.where?.[0] ?? project.scenes[0].id
    const scene = project.scenes.find(candidate => candidate.id === where)
    const object = (THINGS[where] ?? ['木箱', '长桌'])[scene.beats.length % 2]
    const talks = Boolean(other) && index === 1
    const beat = {
      id: `b${scene.beats.length + 1}`, objective: `查看${object}`, objectName: object, prompt: `按 E 查看${object}`, tooEarly: '还不到时候。', during: anchor.happens, after: anchor.after, performed: true,
      action: `人物俯身查看${object}，手轻轻碰了碰它。`, face: talks ? `${other.name}和人物当面说话。` : '', faceCast: talks ? [other.name] : [], settle: talks ? '手从物件上收回。' : '', sound: '安静房间里轻微的动作声。',
      ...(talks ? { lines: [{ who: other.name, says: '你来得太晚了。' }, { who: player?.name ?? '主角', says: '门一直开着吗？' }] } : {}),
      gives: index === 0 ? ['clue'] : [], takes: index === list.length - 1 ? ['clue'] : [],
    }
    scene.beats.push(beat)
    if (index === 0) scene.props.push({ id: 'clue', name: '线索', look: '一张旧纸条' })
    anchor.steps = [{ scene: where, beat: beat.id }]
    anchor.script = `【${scene.title}】\n旁白：${anchor.happens}\n主角去做：查看${object}`
  })
  project.scriptsReviewed = true
  settleWorld(project)
  await writeProject(project)
  return project
}
