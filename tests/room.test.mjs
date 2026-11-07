import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import test from 'node:test'
import { adoptNode } from '../platform/engine.mjs'
import { buildGraph } from '../platform/graph.mjs'
import { emptyRoom, makingCost, runRoom } from '../platform/room.mjs'
import { createProject, projectDir, readProject, writeProject } from '../platform/store.mjs'
import { viewerText } from '../platform/viewerText.mjs'

const ID = 'room-test'
const signal = new AbortController().signal

// A model that does what it is told to in turn, and a reader who says the same thing every time.
const agentThat = (...steps) => ({
  asked: [], read: [], options: [],
  async text({ system, user, model, thinking, onUsage }) {
    onUsage?.({ prompt_tokens: 100, completion_tokens: 10 })
    if (system.startsWith('你第一次看') || system.startsWith('你是苛刻')) {
      this.read.push({ system, user, thinking })
      return JSON.stringify({ think: '不知道', worst: [], scenes: [] })
    }
    this.asked.push(user)
    this.options.push({ model, thinking })
    return JSON.stringify(steps.shift())
  },
})

const fresh = (extra = {}) => createProject({ id: ID, title: '未命名', story: '一个题材。', premise: null, ...extra })
const scene = (over = {}) => ({
  title: '酒馆', place: '酒馆，灰墙。', stage: { kind: 'indoor', exit: 'door', width: 10, depth: 4.9 },
  opening_line: '进门。',
  beats: [{ objective: '问话', object: '吧台', action: '手按在吧台上。', during: '我走过去。', face: '老板抬头。', face_cast: ['老板'], lines: [{ who: '侦探', says: '那晚你在哪？' }, { who: '老板', says: '早关门了。' }] }],
  film: { opening: { action: '走进来。' }, door: { action: '推门。' }, ending: { action: '走出去。' } },
  ...over,
})
const people = [{ op: 'cast_add', name: '侦探', look: '瘦', costume: '风衣' }, { op: 'cast_add', name: '老板', look: '胖', costume: '围裙' }]
const finish = { say: '够好了。', actions: [{ tool: 'finish', summary: '写完了。', doubts: ['结局还弱。'] }] }

test('it writes a story from nothing, its own way, and finishes when it says so', async () => {
  await rm(projectDir(ID), { recursive: true, force: true })
  await fresh()
  const model = agentThat(
    { say: '先想人物。', actions: [{ tool: 'notes', text: '老板在隐瞒什么。' }] },
    { say: '写第一场。', actions: [{ tool: 'edit', edits: [...people, { op: 'scene_add', after: '', scene: scene() }] }] },
    finish,
  )
  const project = await runRoom({ id: ID, said: '写个案子', provider: model, signal })
  assert.equal(project.room.status, 'done')
  assert.equal(project.room.notes, '老板在隐瞒什么。')
  assert.deepEqual(project.room.doubts, ['结局还弱。'])
  assert.equal(project.scenes.length, 1)
  assert.equal(project.cast.find(person => person.playable).name, '侦探')
  assert.deepEqual(project.room.steps.map(step => step.say), ['先想人物。', '写第一场。', '够好了。'])
  assert.match(model.asked[0], /导演：写个案子/)
  assert.match(model.asked[1], /老板在隐瞒什么/, 'what it wrote down is there next time')
  assert.match(model.asked[2], /上一步“写第一场。”的结果/)
  assert.equal(model.options[0].thinking, true)
})

test('what cannot be filmed comes back with the reason, and nothing of that change stands', async () => {
  await rm(projectDir(ID), { recursive: true, force: true })
  await fresh()
  const model = agentThat(
    { say: '写。', actions: [{ tool: 'edit', edits: [...people, { op: 'scene_add', after: '', scene: scene({ beats: [{ objective: '问话', object: '吧台', action: '手。', face: '老板抬头。', face_cast: ['老板'], lines: [{ who: '路人', says: '喂。' }] }] }) }] }] },
    { say: '门不行吧。', actions: [{ tool: 'edit', edits: [...people, { op: 'scene_add', after: '', scene: scene({ beats: [{ objective: '看', object: '仓库后门', action: '手。' }] }) }] }] },
    finish,
  )
  const project = await runRoom({ id: ID, provider: model, signal })
  assert.match(model.asked[1], /是“路人”说的/)
  assert.equal((await readProject(ID)).scenes.length, 0)
  assert.match(model.asked[2], /“仓库后门”不能是互动的东西/)
  assert.equal(project.scenes.length, 0)
  assert.equal(project.cast.length, 0, 'in one step or not at all')
})

test('no dramatic rule stands in its way: a one-scene story with one person and no suspect is its to write', async () => {
  await rm(projectDir(ID), { recursive: true, force: true })
  await fresh()
  const alone = scene({ beats: [{ objective: '看信', object: '书桌', action: '手拆信。', during: '她走了。' }] })
  const model = agentThat({ say: '就一场。', actions: [{ tool: 'edit', edits: [people[0], { op: 'scene_add', after: '', scene: alone }] }] }, finish)
  const project = await runRoom({ id: ID, said: '写个案子', provider: model, signal })
  assert.equal(project.scenes.length, 1)
  assert.equal(project.scenes[0].beats.length, 1)
  assert.equal(project.room.status, 'done')
})

test('readers know only what is on screen', async () => {
  await rm(projectDir(ID), { recursive: true, force: true })
  await fresh()
  const secret = '真凶其实是老板'
  const model = agentThat(
    { say: '写。', actions: [{ tool: 'notes', text: secret }, { tool: 'edit', edits: [...people, { op: 'scene_add', after: '', scene: scene() }, { op: 'scene_add', after: 's1', scene: scene({ title: '码头', beats: [{ objective: '看箱子', object: '木箱', action: '手开箱。', during: '箱子是空的。' }] }) }] }] },
    { say: '找人读。', actions: [{ tool: 'blind_read', up_to: [1, 2] }, { tool: 'doctor', focus: '结局' }] },
    finish,
  )
  await runRoom({ id: ID, provider: model, signal })
  assert.equal(model.read.length, 3)
  for (const { user, thinking } of model.read) {
    assert.ok(!user.includes(secret), 'not the notes')
    assert.ok(!user.includes('手按在吧台上'), 'not the shot descriptions')
    assert.equal(thinking, undefined)
  }
  const upToOne = model.read.find(({ user }) => user.includes('到目前为止') && !user.includes('箱子是空的'))
  assert.ok(upToOne, 'reading up to a scene stops there')
  assert.ok(model.read.some(({ user }) => user.includes('作者特别想知道：结局')))
  assert.match(model.asked[2], /看到第 1 场/)
})

test('a question waits for the director, and the answer carries on where it left off', async () => {
  await rm(projectDir(ID), { recursive: true, force: true })
  await fresh()
  const asking = agentThat({ say: '要问。', actions: [{ tool: 'notes', text: '两种结局。' }, { tool: 'ask_director', question: '凶手要不要让人同情？' }] })
  const waiting = await runRoom({ id: ID, said: '写个案子', provider: asking, signal })
  assert.equal(waiting.room.status, 'asking')
  assert.equal(waiting.room.question, '凶手要不要让人同情？')
  const going = agentThat(finish)
  const done = await runRoom({ id: ID, said: '要', provider: going, signal })
  assert.equal(done.room.status, 'done')
  assert.equal(done.room.question, null)
  assert.match(going.asked[0], /导演：写个案子\n你问导演：凶手要不要让人同情？\n导演：要/)
  assert.match(going.asked[0], /两种结局/)
})

test('it stops to report after a long stretch, and can be told to go on', async () => {
  await rm(projectDir(ID), { recursive: true, force: true })
  await fresh()
  const busy = { async text({ onUsage }) { onUsage?.({ prompt_tokens: 100, completion_tokens: 10 }); return JSON.stringify({ say: '还在写。', actions: [{ tool: 'notes', text: '想。' }] }) } }
  const paused = await runRoom({ id: ID, provider: busy, signal })
  assert.equal(paused.room.status, 'paused')
  assert.match(paused.room.question, /已经连着做了 40 步/)
  assert.equal(paused.room.steps.length, 40)
  assert.equal(paused.room.usage.calls, 40)
  const done = await runRoom({ id: ID, said: '继续', provider: agentThat(finish), signal })
  assert.equal(done.room.status, 'done')
})

test('a model that writes nonsense is told so, and one that keeps failing leaves the work where it was', async () => {
  await rm(projectDir(ID), { recursive: true, force: true })
  await fresh()
  const bad = agentThat({ say: '好。', actions: [{ tool: 'explode' }] }, { say: '', actions: [] }, { say: '好。', actions: [] })
  await assert.rejects(runRoom({ id: ID, provider: bad, signal }), /连续 3 轮/)
  assert.match(bad.asked[1], /没有 explode 这个动作/)
  const project = await readProject(ID)
  assert.equal(project.room.status, 'failed')
  assert.match(project.room.error, /连续 3 轮/)
})

test('stopping it keeps what it has done', async () => {
  await rm(projectDir(ID), { recursive: true, force: true })
  await fresh()
  const controller = new AbortController()
  let calls = 0
  const model = { async text() {
    if (++calls === 2) { controller.abort(); throw new Error('cancelled') }
    return JSON.stringify({ say: '写笔记。', actions: [{ tool: 'notes', text: '留着。' }] })
  } }
  const project = await runRoom({ id: ID, provider: model, signal: controller.signal })
  assert.equal(project.room.status, 'stopped')
  assert.equal(project.room.notes, '留着。')
})

test('what has been made is not rewritten from here: that goes through a note, where the cost is shown first', async () => {
  await rm(projectDir(ID), { recursive: true, force: true })
  await fresh()
  await runRoom({ id: ID, provider: agentThat({ say: '写。', actions: [{ tool: 'edit', edits: [...people, { op: 'scene_add', after: '', scene: scene() }] }] }, finish), signal })
  const project = await readProject(ID)
  const { fallbackLayout } = await import('../platform/breakdown.mjs')
  project.scenes = project.scenes.map(one => ({ ...one, ...fallbackLayout(one) }))
  await writeProject(project)
  const face = buildGraph(project).find(node => node.id === 'cast:c2:face')
  await adoptNode(project, { ...face, outputs: [] })
  await assert.rejects(runRoom({ id: ID, said: '再改改', provider: agentThat(finish), signal }), /已经生成过画面/)
})

test('it is told what its script would cost to make, and the advice is a file anyone can change', async () => {
  await rm(projectDir(ID), { recursive: true, force: true })
  await fresh()
  const model = agentThat({ say: '写。', actions: [{ tool: 'edit', edits: [...people, { op: 'scene_add', after: '', scene: scene() }] }] }, finish)
  let told = ''
  const reading = { ...model, text(request) { told = request.system; return model.text(request) } }
  await runRoom({ id: ID, provider: reading, signal })
  assert.match(model.asked[1], /照现在的剧本全部拍出来：约 \d+ 张图、\d+ 秒视频，约 \d+ 元/)
  const craft = await readFile(new URL('../platform/craft.md', import.meta.url), 'utf8')
  assert.ok(told.includes(craft.trim().split('\n')[2]))
  const cost = makingCost(await readProject(ID))
  assert.ok(cost.seconds > 0 && cost.images > 0 && cost.yuan > 0)
  assert.equal(makingCost({ scenes: [], cast: [] }), null)
})

test('the writing stays out of what the page saves as the story, and a fresh room is empty', async () => {
  const room = emptyRoom()
  assert.deepEqual([room.notes, room.steps, room.said, room.status], ['', [], [], 'idle'])
  const text = viewerText([{ title: '酒馆', openingLine: '进门。', beats: [{ objective: '问话', during: '走过去。', lines: [{ who: '老板', says: '嗯。' }], after: '他在说谎。', action: '秘密的镜头' }], endingLine: '走了。', film: { ending: { lines: [{ who: '侦探', says: '再见。' }] } } }])
  assert.equal(text, '【第 1 场：酒馆】\n旁白：进门。\n主角去做：问话\n旁白：走过去。\n老板：嗯。\n旁白：他在说谎。\n旁白：走了。\n侦探：再见。')
})

test('leaves nothing behind', async () => {
  await rm(projectDir(ID), { recursive: true, force: true })
  assert.ok(!existsSync(projectDir(ID)))
})
