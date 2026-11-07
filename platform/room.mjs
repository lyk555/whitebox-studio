// The writers' room: an agent that designs the script and the people, and judges whether the drama works. What to write,
// in what order, what to read back and when it is good enough are all its own decisions. This file only gives it tools, and
// keeps what filming physically requires by putting everything it writes through the same checks as any other change.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { applyEdits, EDIT_FORMATS, STORY_FIELDS, withLayouts } from './agent.mjs'
import { askChecked, SCENE_FORMAT } from './breakdown.mjs'
import { config, ROOT } from './config.mjs'
import { readState, updateRecords } from './engine.mjs'
import { buildGraph } from './graph.mjs'
import { readProject, writeProject } from './store.mjs'
import { viewerScene, viewerText } from './viewerText.mjs'

const clean = value => String(value ?? '').trim()
const SHORT = 240
const JSON_ONLY = '只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。'
// Not a limit on how much it may write. A pause to say where things stand, so nothing runs on unseen.
const STEPS_BEFORE_REPORTING = 40
const PRICE_PER_SECOND = 0.95
const PRICE_PER_IMAGE = 0.6
const TEXT_PRICES = { input: 3.2, output: 16 } // Yuan per million tokens, the writing model's lowest band.

const brief = text => { const said = clean(text); return said.length > SHORT ? `${said.slice(0, SHORT)}……` : said }

// ---------------------------------------------------------------- readers who have not seen the outline
const VIEWER = `你第一次看这部片子，只知道到目前为止看到的内容。照实说你的想法，看不懂就说看不懂，不要替作者圆。${JSON_ONLY}`
const viewerUser = (scenes, upTo) => {
  const finished = upTo >= scenes.length
  return `到目前为止你看到的：
${viewerText(scenes, upTo)}

${finished ? `片子看完了。输出：
{ "what_happened": "你认为到底发生了什么，是谁、怎么回事、为什么", "convinced_by": "片子里哪些东西让你这样认为", "unexplained": ["看完还没解释清楚或者对不上的地方"], "best_moment": "最好看的地方，没有就写 没有", "boring": "哪里想快进，没有就写 没有", "satisfying": 1到5 }`
    : `输出：
{ "think": "你现在认为是怎么回事；如果是悬疑，最怀疑谁", "confidence": 0到100, "confused": ["看不懂或者对不上的地方，引用原句"], "want_to_know": "你现在最想知道什么，没有就写 没有", "keep_watching": "还想看下去吗，为什么" }`}`
}

const DOCTOR = `你是苛刻的剧本医生。你只能看到观众实际看到的旁白、目标和台词。你的工作是找出这出戏哪里不好，不是鼓励作者。多数投稿都是平庸的：3 分代表及格，5 分代表能入围电影节，不要给人情分。每个判断都要引用原句作证据，引用不出来就不能下结论。${JSON_ONLY}`
const doctorUser = (scenes, focus) => `观众看到的全部内容：
${viewerText(scenes)}
${focus ? `\n作者特别想知道：${focus}\n` : ''}
输出：
{
  "scenes": [{ "scene": 场次数字, "wants": "这场主角想要什么", "obstacle": "谁或什么在挡他", "turn": "这场结束时局面怎么变了，没变就写 无", "quote": "证据原句" }],
  "scores": {
    "hook": { "score": 1到5, "why": "开头是否让人想看下去", "quote": "" },
    "plot": { "score": 1到5, "why": "这个题材最该让人满足的地方做到了没有，比如悬疑的推理和揭晓", "quote": "" },
    "characters": { "score": 1到5, "why": "人物是否各有所图、能被区分", "quote": "" },
    "dialogue": { "score": 1到5, "why": "台词有没有潜台词和冲突，还是在念信息", "quote": "" },
    "structure": { "score": 1到5, "why": "每场是否推动，前后是否接得上，节奏", "quote": "" },
    "ending": { "score": 1到5, "why": "结局是否有力", "quote": "" }
  },
  "worst": [{ "problem": "最严重的问题，一句", "quote": "证据原句", "fix": "具体怎么改" }],
  "would_stop": "看到哪一场会想关掉，都不会就写 不会"
}
worst 最多 5 条，按严重程度排。`

// ---------------------------------------------------------------- what it can do
const TOOLS = {
  async notes(action, { project }) {
    const room = project.room
    room.notes = action.append ? `${room.notes ? `${room.notes}\n` : ''}${clean(action.text)}` : clean(action.text)
    return `笔记现在 ${room.notes.length} 字。`
  },

  // In one step or not at all, and through everything a change from any other direction goes through.
  async edit(action, { project }) {
    const edits = Array.isArray(action.edits) ? action.edits : []
    if (!edits.length) return '没有写 edits。'
    if (edits.some(edit => edit?.op === 'remake')) return 'remake 在写剧本时用不到。'
    const result = applyEdits(project, edits, { drafting: true })
    for (const field of STORY_FIELDS) project[field] = result.next[field]
    const notes = result.notes.length ? ` ${result.notes.join(' ')}` : ''
    return `改好了：${result.changed.map(line => `${line.where} · ${line.what}`).join('；') || '没有变化'}。${notes}`
  },

  async read_scene(action, { project }) {
    const scene = project.scenes.find(candidate => candidate.id === action.scene)
    if (!scene) return `没有 ${action.scene}。现有：${project.scenes.map(other => other.id).join('、')}。`
    const { objects, stage, carried, undo, chat, ...rest } = scene
    return JSON.stringify(rest)
  },

  // Several points in one go, since how suspicion moves is the point of asking.
  async blind_read(action, { project, ask }) {
    const scenes = project.scenes
    if (!scenes.length) return '还没有场景可读。'
    const points = (Array.isArray(action.up_to) ? action.up_to : [action.up_to ?? scenes.length]).map(Number).map(point => Math.min(scenes.length, Math.max(1, point || scenes.length)))
    const answers = await Promise.all([...new Set(points)].map(async upTo => [upTo, await ask(VIEWER, viewerUser(scenes, upTo))]))
    return answers.map(([upTo, answer]) => `看到第 ${upTo} 场：${JSON.stringify(answer)}`).join('\n')
  },

  async doctor(action, { project, ask }) {
    if (!project.scenes.length) return '还没有场景可读。'
    const { scenes, ...verdict } = await ask(DOCTOR, doctorUser(project.scenes, clean(action.focus)))
    return JSON.stringify({ ...verdict, scenes })
  },
}

const ENDS = { ask_director: 'asking', finish: 'done' }

// ---------------------------------------------------------------- what it reads
const SYSTEM = async () => `你是这部戏的编剧和统筹，一个人负责从设计人物、写剧本到判断戏好不好。

你要的是观众愿意看完、看完会记得的戏。能拍、逻辑说得通、线索对得上，这些都只是底线，全做到了也可能是一出没人想看的戏。编剧最容易犯的错，是看到自己把错修完了，就以为戏好了。

判断好不好，问自己这几件事，答不上来就是还没好：哪一场最好看，为什么？哪句台词遮住名字也知道是谁说的？观众在哪一刻会真的吃一惊？看完会跟别人说起什么？

稿子不行就推倒重写，不要在坏稿子上打补丁。可以整场重写、删人、换凶手、换结构。写字几乎不花钱，开拍才花钱，所以这时候多写几稿、多找人读几遍都值得。给导演的话也要照实说，没有把握就说没有把握，不要说“全部完成、可以定稿”这种话，除非你真的这么认为。

这部戏的形式：
- 玩家操作主角，在一屏固定的画面里走动，走到一件件东西前，触发一段电影镜头。一个地方一屏，走出去进入下一个地方。玩完也能从头看成一部片子。
- 观众只能从旁白、屏幕上的目标和台词知道发生了什么。

拍摄的限制，这些不满足就拍不出来，改动时会被退回并告诉你原因：
- 每一步（beat）绑一件立在地上的家具或大件，同一场每步用不同的。墙、门、窗、地面、人都不行，桌面的小东西和互动后才出现的东西也不行，发生在它们身上的事写进旁边那件大件的 action。
- 每一步都拍一段视频（action）：全程不露脸，只有主角的手和背影，不能有其他人。
- 其他人物不走动，只能出现在露脸镜头（face）里，写进 face_cast。一个露脸镜头除主角外最多两个人。人物说的话写进 lines，只有露脸镜头能说话，说话的人必须在镜头里。一个镜头最多 12 秒，说话约每秒 5 个字。
- 画面和视频里不能有可辨认的文字，要看清字的镜头拍不了。
- 道具先得到（gives）才能用掉（takes）。
- 全片最后一场的结尾 face 要慢慢暗到全黑，片子靠它收住。

${await readFile(join(ROOT, 'platform', 'craft.md'), 'utf8')}

该写什么设定、先写什么、哪里重写、读几遍、什么时候算够好，都由你决定。有真正拿不准、又影响很大的方向时，问导演；其他的你自己定，不要什么都问。finish 时的 doubts 写这部戏本身最弱的地方，不写可有可无的附加想法。${JSON_ONLY}`

function scriptView(project) {
  if (!project.scenes.length) return '（还没有场景）'
  return project.scenes.map((scene, index) => {
    const beats = scene.beats.map(beat => `  ${beat.id}（物件：${beat.objectName}${beat.face ? `；露脸：${beat.face}；镜头里：${(beat.faceCast ?? []).join('、') || '只有主角'}` : ''}${beat.gives?.length ? `；得到：${beat.gives}` : ''}${beat.takes?.length ? `；用掉：${beat.takes}` : ''}）`).join('\n')
    return `${scene.id}\n${viewerScene(scene, index)}\n各步的编号和物件：\n${beats}`
  }).join('\n\n')
}

// What the whole story would cost to make, so that it can weigh that. A scene with no layout yet is counted by a plain one.
export function makingCost(project) {
  if (!project.scenes.length || !project.cast.length) return null
  try {
    const nodes = buildGraph(withLayouts(project))
    const seconds = nodes.reduce((sum, node) => sum + (node.resource === 'video' ? node.seconds ?? 0 : 0), 0)
    const images = nodes.filter(node => node.resource === 'image').length
    return { seconds, images, yuan: Math.round(seconds * PRICE_PER_SECOND + images * PRICE_PER_IMAGE) }
  } catch {
    return null
  }
}

function roomUser(project) {
  const { room } = project
  const said = room.said.map(line => `${line.role === 'director' ? '导演' : '你问导演'}：${line.text}`).join('\n')
  const earlier = room.steps.slice(0, -1).map(step => `- ${step.say}${step.results.map(({ tool, short }) => `\n    ${tool} → ${short}`).join('')}`).join('\n')
  const last = room.steps.at(-1)
  const cost = makingCost(project)
  return `导演的话：
${said || '（导演还没有说话）'}

你的笔记（只有你看得到，观众和读者都看不到）：
${room.notes || '（还是空的）'}

人物：
${project.cast.length ? JSON.stringify(project.cast.map(({ id, name, age, look, costume, personality, voice, playable }) => ({ id, name, age, look, costume, personality, voice, playable }))) : '（还没有）'}

现在的剧本，观众看到的文字：
${scriptView(project)}

${cost ? `照现在的剧本全部拍出来：约 ${cost.images} 张图、${cost.seconds} 秒视频，约 ${cost.yuan} 元。` : ''}

你已经做过的：
${earlier || '（这是开始）'}

${last ? `上一步“${last.say}”的结果：\n${last.results.map(({ tool, full }) => `${tool}：${full}`).join('\n')}` : ''}

现在决定下一步。输出：
{ "say": "一句大白话告诉导演你现在在做什么、为什么", "actions": [动作，按顺序执行，一次可以多个] }

能做的动作：
{ "tool": "notes", "text": "内容", "append": true 表示追加，不写就是整份替换 }：写你的设定和想法，格式你自己定。换了窗口也还在。
{ "tool": "edit", "edits": [下面的修改] }：改人物和剧本。一批修改要么全部生效，要么全部退回。
{ "tool": "read_scene", "scene": "s1" }：看一场的完整内容，包括视频内容。
{ "tool": "blind_read", "up_to": [2, 4, 6] }：找没看过底稿的观众读到第几场，他告诉你他怎么想、哪里看不懂。
{ "tool": "doctor", "focus": "可选，想特别问的" }：找剧本医生挑毛病。
{ "tool": "ask_director", "question": "问题" }：问导演，然后等他回答。
{ "tool": "finish", "summary": "写成了什么样", "doubts": ["你自己还不满意的地方，照实写"] }：你认为够好了就结束。

修改的格式：
${EDIT_FORMATS}

scene_add 的场景格式：
${SCENE_FORMAT}`
}

function checkStep(answer) {
  const say = clean(answer.say)
  if (!say) throw new Error('没有写 say。')
  const actions = Array.isArray(answer.actions) ? answer.actions : []
  if (!actions.length) throw new Error('actions 是空的。每一步都要做点什么，够好了就 finish。')
  const known = [...Object.keys(TOOLS), ...Object.keys(ENDS)]
  const unknown = actions.find(action => !known.includes(action?.tool))
  if (unknown) throw new Error(`没有 ${unknown?.tool} 这个动作。能用的是：${known.join('、')}。`)
  return { say, actions }
}

// ---------------------------------------------------------------- the loop
export const emptyRoom = () => ({ notes: '', said: [], steps: [], status: 'idle', usage: { input: 0, output: 0, calls: 0 } })
const roomOf = project => (project.room ??= emptyRoom())
export const roomYuan = ({ input, output }) => (input * TEXT_PRICES.input + output * TEXT_PRICES.output) / 1e6

const tell = id => updateRecords(id, () => {}) // Tells the page.

// Writing is for what has not been made yet. What has been made is changed through a note, where the cost is shown first.
export async function hasMade(project) {
  const state = await readState(project.id)
  return buildGraph(project).some(node => ['image', 'video'].includes(node.resource) && state.nodes[node.id]?.finished)
}

export async function runRoom({ id, said, provider, signal, log = () => {} }) {
  const first = await readProject(id)
  if (await hasMade(first)) throw Object.assign(new Error('这个故事已经生成过画面了，改动请走修改意见，那里会先算好费用。'), { status: 409 })
  const startRoom = roomOf(first)
  if (clean(said)) startRoom.said.push({ role: 'director', text: clean(said), at: Date.now() })
  startRoom.status = 'working'
  startRoom.question = null
  await writeProject(first)
  await tell(id)
  const model = config().writerModel
  const counted = (usage = {}, room) => {
    room.usage.input += usage.prompt_tokens ?? 0
    room.usage.output += usage.completion_tokens ?? 0
    room.usage.calls++
  }
  try {
    for (let count = 0; ; count++) {
      const project = await readProject(id)
      const room = roomOf(project)
      if (count >= STEPS_BEFORE_REPORTING) {
        room.status = 'paused'
        room.question = `已经连着做了 ${count} 步，文字花了约 ${roomYuan(room.usage).toFixed(2)} 元。还要继续吗？`
        await writeProject(project)
        await tell(id)
        return project
      }
      const step = await askChecked({ provider, system: await SYSTEM(), user: roomUser(project), check: checkStep, signal, log, progress: () => {}, model, thinking: true, onUsage: usage => counted(usage, room) })
      // Readers are fresh each time: no notes, no conversation, nothing but what is on screen.
      const ask = async (system, user) => askChecked({ provider, system, user, check: answer => answer, signal, log, progress: () => {}, model, onUsage: usage => counted(usage, room) })
      const results = []
      let ended = null
      for (const action of step.actions) {
        if (ENDS[action.tool]) {
          ended = action
          break
        }
        let full
        try {
          full = await TOOLS[action.tool](action, { project, ask })
        } catch (error) {
          if (signal.aborted) throw error
          full = `没有成功：${error.message}`
        }
        results.push({ tool: action.tool, short: brief(full), full })
      }
      room.steps.push({ at: Date.now(), say: step.say, results })
      if (ended) {
        room.status = ENDS[ended.tool]
        if (ended.tool === 'ask_director') {
          room.question = clean(ended.question)
          room.said.push({ role: 'agent', text: room.question, at: Date.now() })
        } else {
          Object.assign(room, { summary: clean(ended.summary), doubts: Array.isArray(ended.doubts) ? ended.doubts.map(clean).filter(Boolean) : [] })
        }
      }
      await writeProject(project)
      await tell(id)
      log(step.say)
      if (ended) return project
    }
  } catch (error) {
    const project = await readProject(id)
    const room = roomOf(project)
    room.status = signal.aborted ? 'stopped' : 'failed'
    room.error = signal.aborted ? null : error.message
    await writeProject(project)
    await tell(id)
    if (signal.aborted) return project
    throw error
  }
}
