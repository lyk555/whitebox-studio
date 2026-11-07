// Talking to the set designer: one sentence from the person, a list of changes from the model. The changes are
// tried on a copy and the same checks as the floor plan decide whether they stand. What fails goes back to the
// model with the reason, so a change either arrives whole or the room stays exactly as it was.
import { CLOSE_LIMITS, shellFrom, LIMITS, normalizeStage } from '../runtime/shell.js'
import { askChecked, roomRules } from './breakdown.mjs'
import { PART_RULES, shapeFromParts } from './shapes.mjs'
import { buildStage, nearestFreeSpot, settleForFilming, shapeOf, shellFor } from './stage.mjs'

const HISTORY_SENT = 10
export const HISTORY_KEPT = 40
const clean = value => String(value ?? '').trim()

const SYSTEM = `你是这个场景的布景师，正在和导演商量白模里摆什么。导演说一句，你照做，并用一两句大白话告诉他现在这里是什么样。只说东西，不要提零件、坐标、禁放区、站位这些词。导演只是在问问题，就只回答，不改东西。只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。`

function describeObject(object, scene) {
  const beatIndex = scene.beats.findIndex(beat => beat.object === object.id)
  const { size } = shapeOf(object) ?? { size: [] }
  const where = object.on ? `放在 ${scene.objects.find(other => other.id === object.on)?.name ?? object.on} 上面` : `x ${object.x}，z ${object.z}`
  return `- ${object.name}：${where}，${size.join('×')} 米${beatIndex >= 0 ? `，第 ${beatIndex + 1} 步要互动，不能移除` : ''}。样子：${object.look || '没写'}`
}

function describeStage(scene) {
  const { stage } = shellFor(scene)
  if (scene.exits) return `${stage.kind === 'outdoor' ? '室外' : '室内'}，${stage.width}×${stage.depth} 米，出口：${scene.exits.map(exit => `${exit.name}（在远端 ${stage.ways.find(way => way.id === exit.id)?.at} 的位置）`).join('、') || '没有'}。`
  return `${stage.kind === 'outdoor' ? '室外' : '室内'}，${stage.width}×${stage.depth} 米，出口是${stage.exit === 'door' ? '要打开的门' : '直接走过去的路'}。`
}

function userPrompt({ project, scene, message, selected, history }) {
  const picked = scene.objects.find(object => object.id === selected)
  return `美术风格：${project.style}
场景：${scene.title}。${scene.place}
这个地方：${describeStage(scene)}

玩家要依次互动的东西：
${scene.beats.map((beat, index) => `- 第 ${index + 1} 步：${beat.objectName}（${beat.objective}）`).join('\n')}

现在房间里有：
${scene.objects.map(object => describeObject(object, scene)).join('\n')}

${roomRules(scene)}

${PART_RULES}

${history.length ? `刚才的对话：\n${history.map(line => `${line.role === 'user' ? '导演' : '你'}：${line.text}`).join('\n')}\n\n` : ''}${picked ? `导演现在选中的是“${picked.name}”，他说“这个”指的就是它。\n` : ''}导演说：${message}

输出：
{
  "reply": "告诉导演你做了什么，或者回答他的问题",
  "changes": [
    { "op": "add", "name": "物件名", "x": 0, "z": 0, "on": "放在别的东西上面时写那件东西的名字，否则留空", "look": "材质、颜色、新旧，一句", "parts": [] },
    { "op": "reshape", "target": "物件名", "parts": [], "look": "形状变了，样子通常也要跟着改" },
    { "op": "move", "target": "物件名", "x": 0, "z": 0 },
    { "op": "update", "target": "物件名", "name": "新名字，不改就不写", "look": "新样子，不改就不写" },
    { "op": "remove", "target": "物件名" },
    { "op": "stage", "kind": "indoor 或 outdoor", "width": 12, "depth": 8, "exit": "door 或 opening", "door_at": 0.2, "exit_name": "出口叫什么，如：铁门、石拱门洞", "exit_beyond": "走过去之后看到什么，一句", "exit_objective": "屏幕上的目标文字，如：推开那扇铁门" }
  ]
}

${scene.exits ? `还可以挪出口的位置：{ "op": "way", "target": "出口名", "at": 0.5 }，at 从 0.12 到 0.88，两个出口至少隔 0.24。出口通向哪里、有几个，是地点图的事，这里改不了。\n\n` : ''}changes 只写真正要改的；没有要改的就是空数组。stage 用来改这个地方本身：大小（${shellFor(scene).stage.framing === 'close' ? `宽 ${CLOSE_LIMITS.width[0]} 到 ${CLOSE_LIMITS.width[1]} 米，深是宽的将近一半` : `宽 ${LIMITS.width[0]} 到 ${LIMITS.width[1]} 米，深 ${LIMITS.depth[0]} 到 ${LIMITS.depth[1]} 米`}）、室内或室外、出口是要打开的门（door）还是直接走过去的路（opening）、出口在远端的位置（door_at，0.08 靠左，0.5 在中间），只写要改的项。门和出口只能用 stage 改，不要用 add 摆一扇门。改了大小，东西会按比例挪到新的位置。不要摆墙、门、窗、地面或人。`
}

function findObject(objects, target) {
  const wanted = clean(target)
  return objects.find(object => object.id === wanted)
    ?? objects.find(object => object.name === wanted)
    ?? objects.find(object => object.name.includes(wanted) || wanted.includes(object.name))
}

const mustFind = (objects, change) => {
  const found = findObject(objects, change.target)
  if (!found) throw new Error(`房间里没有“${change.target}”。现有的是：${objects.map(object => object.name).join('、')}。`)
  return found
}

const nextId = objects => `o${Math.max(0, ...objects.map(object => Number(object.id.slice(1)) || 0)) + 1}`

const position = (change, name) => {
  const [x, z] = [Number(change.x), Number(change.z)]
  if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error(`“${name}”没有写 x 和 z。`)
  return { x, z }
}

// Keeps a thing as near as it can be to where it was asked for. Says so if that is not exactly there.
function standIt(object, objects, notes, shell) {
  const others = objects.filter(other => other.id !== object.id)
  const spot = nearestFreeSpot(object, others, shell)
  if (!spot) throw new Error(`房间里放不下“${object.name}”，它太大了，或者东西太多了。`)
  if (spot.x !== object.x || spot.z !== object.z) notes.push(`“${object.name}”原来的位置放不下，挪到了最近的空处。`)
  Object.assign(object, spot)
}

// A new size for the space. What stands in it keeps its share of the floor, then finds the nearest place it fits.
function resizedStage(scene, change, objects, notes) {
  const before = shellFor(scene)
  const { kind, exit, width, depth, door_at: doorAt } = change
  const stage = normalizeStage({ ...before.stage, ...Object.fromEntries(Object.entries({ kind, exit, width, depth, doorAt }).filter(([, value]) => value !== undefined && value !== null && value !== '')) })
  const after = shellFrom(stage)
  const share = (value, from, to, low, high) => low + ((value - from) / (to - from)) * (high - low)
  const standing = objects.filter(object => !object.on)
  for (const object of standing) {
    object.x = Number(share(object.x, before.room.west, before.room.east, after.room.west, after.room.east).toFixed(2))
    object.z = Number(share(object.z, before.room.north, before.room.south, after.room.north, after.room.south).toFixed(2))
    delete object.slot
  }
  standing.forEach((object, index) => standIt(object, standing.slice(0, index), notes, after))
  return stage
}

// Pure, so what the model may do can be checked without a model. Returns a new room, or throws why not.
export function applyChanges(scene, changes) {
  const objects = structuredClone(scene.objects)
  const beats = structuredClone(scene.beats)
  const changed = new Set()
  const notes = []
  // The space comes first, whatever order it was said in, so that everything else lands in the new one.
  const stageChange = changes.find(change => change.op === 'stage')
  const stage = stageChange ? resizedStage(scene, stageChange, objects, notes) : scene.stage
  const exits = scene.exits ? structuredClone(scene.exits) : undefined
  for (const change of changes) {
    if (change.op !== 'way') continue
    const exit = exits?.find(candidate => candidate.name === clean(change.target) || candidate.id === clean(change.target))
    if (!exit) throw new Error(`没有出口“${change.target}”。现有的是：${(exits ?? []).map(other => other.name).join('、')}。`)
    exit.at = Number(change.at)
  }
  const shell = shellFrom(exits ? { ...stage, ways: exits } : stage)
  const exit = stageChange ? {
    ...scene.exit,
    ...(clean(stageChange.exit_name) ? { name: clean(stageChange.exit_name) } : {}),
    ...(clean(stageChange.exit_beyond) ? { beyond: clean(stageChange.exit_beyond) } : {}),
    ...(clean(stageChange.exit_objective) ? { objective: clean(stageChange.exit_objective) } : {}),
  } : scene.exit
  for (const change of changes) {
    if (change.op === 'stage' || change.op === 'way') continue
    if (change.op === 'add') {
      const name = clean(change.name)
      if (!name) throw new Error('add 没有写 name。')
      const onTop = Boolean(clean(change.on))
      const object = { id: nextId(objects), name, shape: shapeFromParts(change.parts, { name, onTop }), look: clean(change.look) }
      if (onTop) {
        const host = mustFind(objects, { target: change.on })
        if (shapeOf(host).onTop) throw new Error(`“${name}”不能放在“${host.name}”上面，它自己也是放在别的东西上面的。`)
        object.on = host.id
        const sharing = objects.filter(other => other.on === host.id).length
        Object.assign(object, { dx: Number(([-0.3, 0.3, 0][sharing % 3] * shapeOf(host).size[0]).toFixed(2)), dz: -0.05 })
      } else {
        Object.assign(object, position(change, name))
        standIt(object, objects, notes, shell)
      }
      objects.push(object)
      changed.add(object.id)
    } else if (change.op === 'reshape') {
      const object = mustFind(objects, change)
      const onTop = Boolean(object.on)
      object.shape = shapeFromParts(change.parts, { name: object.name, onTop })
      delete object.archetype
      delete object.slot
      if (clean(change.look)) object.look = clean(change.look)
      if (!onTop) standIt(object, objects, notes, shell)
      changed.add(object.id)
    } else if (change.op === 'move') {
      const object = mustFind(objects, change)
      if (object.on) throw new Error(`“${object.name}”放在别的东西上面，要移动就移动下面那件。`)
      Object.assign(object, position(change, object.name))
      delete object.slot
      standIt(object, objects, notes, shell)
      changed.add(object.id)
    } else if (change.op === 'update') {
      const object = mustFind(objects, change)
      if (clean(change.name)) {
        object.name = clean(change.name)
        for (const beat of beats) if (beat.object === object.id) beat.objectName = object.name
      }
      if (clean(change.look)) object.look = clean(change.look)
      changed.add(object.id)
    } else if (change.op === 'remove') {
      const object = mustFind(objects, change)
      const needed = beats.findIndex(beat => beat.object === object.id)
      if (needed >= 0) throw new Error(`“${object.name}”是第 ${needed + 1} 步要互动的东西，不能移除。可以用 reshape 改它的形状。`)
      const gone = new Set([object.id, ...objects.filter(other => other.on === object.id).map(other => other.id)])
      for (let index = objects.length - 1; index >= 0; index--) if (gone.has(objects[index].id)) objects.splice(index, 1)
      for (const id of gone) changed.delete(id)
    } else {
      throw new Error(`没有 ${change.op} 这种修改。`)
    }
  }
  return { objects, beats, stage, exit, ...(exits ? { exits } : {}), changed: [...changed], notes }
}

function checkAnswer(scene, answer) {
  const reply = clean(answer.reply)
  if (!reply) throw new Error('没有写 reply。')
  const changes = Array.isArray(answer.changes) ? answer.changes : []
  if (!changes.length) return { reply, changes: 0, changed: [], notes: [] }
  const room = applyChanges(scene, changes)
  const asChanged = { ...scene, stage: room.stage, exit: room.exit, beats: room.beats, ...(room.exits ? { exits: room.exits } : {}) }
  const objects = settleForFilming(asChanged, room.objects)
  const problems = buildStage({ ...asChanged, objects }).issues.filter(issue => issue.level === 'error')
  if (problems.length) throw new Error(`这样改之后：${problems.map(issue => issue.message).join(' ')}`)
  return { reply, changes: changes.length, ...room, objects }
}

export async function chatWithSet({ project, scene, message, selected, provider, signal, log = () => {} }) {
  const history = (scene.chat ?? []).slice(-HISTORY_SENT)
  return askChecked({
    provider,
    system: SYSTEM,
    user: userPrompt({ project, scene, message, selected, history }),
    check: answer => checkAnswer(scene, answer),
    signal,
    log,
    progress: () => {},
  })
}
