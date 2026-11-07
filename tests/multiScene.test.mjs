import assert from 'node:assert/strict'
import test from 'node:test'
import { breakdownScenes, fallbackLayout } from '../platform/breakdown.mjs'
import { buildGraph, cardsFor, generationTargets } from '../platform/graph.mjs'
import { buildStage } from '../platform/stage.mjs'
import { everyInteractionFilmed } from '../platform/store.mjs'

const quiet = { log: () => {}, progress: () => {}, signal: new AbortController().signal }
const scripted = (...answers) => {
  const asked = []
  return { asked, text: async ({ user }) => { asked.push(user); return answers.shift() } }
}

const beat = (object, extra = {}) => ({ objective: `查看${object}`, object, prompt: '按 E', too_early: '还早', during: '看', after: '好了', gives: [], takes: [], action: `手碰了碰${object}`, face: '', face_cast: [], settle: '', sound: '', ...extra })
const sceneOf = (title, beats, props = []) => ({
  title, place: '灰墙水泥地。', mood: '柔和暖光', opening_line: '来了', ending_line: '走了', props, beats,
  exit: { name: '小门', beyond: '走廊', objective: '推门', prompt: '按 E', too_early: '还早', during: '吱呀', last_objective: '进去' },
  film: { opening: { action: '特写', sound: '雨' }, door: { action: '推门', sound: '吱呀' }, ending: { action: '走', face: '侧脸', sound: '脚步' } },
})
const key = { id: 'key', name: '钥匙', look: '铜的' }
const backstage = sceneOf('后台', [beat('木箱', { gives: ['key'], performed: true, action: '手翻开戏服' }), beat('书架')], [key])
const cellar = sceneOf('地窖', [beat('长桌'), beat('柜子', { takes: ['key'], performed: true, action: '手插进锁孔' })])

const project = { story: '故事', style: '旧剧院', cast: [{ id: 'c1', name: '老周', costume: '夹克', look: '短发', playable: true }] }

async function twoScenes() {
  const scenes = await breakdownScenes({ ...quiet, project, provider: scripted(JSON.stringify({ scenes: [backstage, cellar] })) })
  for (const scene of scenes) Object.assign(scene, fallbackLayout(scene))
  return { ...project, scenes }
}

const scenesFrom = (...list) => breakdownScenes({ ...quiet, project, provider: scripted(JSON.stringify({ scenes: list })) })

test('a prop found in one scene can be used in the next', async () => {
  const { scenes } = await twoScenes()
  assert.deepEqual(scenes.map(scene => scene.id), ['s1', 's2'])
  assert.deepEqual(scenes[1].carried, [{ ...key, from: 's1' }])
  assert.deepEqual(scenes[1].props, [])
  const { data, ok, issues } = buildStage(scenes[1])
  assert.ok(ok, JSON.stringify(issues))
  assert.deepEqual(data.story.carried, ['key'])
  assert.equal(data.story.items.key, '钥匙')
})

test('a prop used up stays used up, and one nobody gave still goes back to the model', async () => {
  const third = sceneOf('阁楼', [beat('木箱', { takes: ['key'] })])
  const provider = scripted(JSON.stringify({ scenes: [backstage, cellar, third] }), JSON.stringify({ scenes: [backstage, cellar] }))
  await breakdownScenes({ ...quiet, project, provider })
  assert.ok(provider.asked[1].includes('第 3 个场景第 1 个 beat 用到的道具 key 不在 props 里'))
})

test('a prop not used up stays in hand through every door', async () => {
  const scenes = await scenesFrom(backstage, sceneOf('走廊', [beat('长桌')]), sceneOf('阁楼', [beat('柜子', { takes: ['key'] })]))
  assert.deepEqual(scenes.map(scene => scene.carried.map(prop => prop.id)), [[], ['key'], ['key']])
  assert.ok(scenes.every(scene => scene.carried.every(prop => prop.from === 's1')))
})

test('a carried prop listed and handed over again is still one prop', async () => {
  const again = sceneOf('地窖', [beat('长桌', { gives: ['key'] }), beat('柜子', { takes: ['key'] })], [key])
  const [, scene] = await scenesFrom(backstage, again)
  assert.deepEqual(scene.props, [])
  assert.deepEqual(scene.beats[0].gives, [])
  assert.ok(buildStage({ ...scene, ...fallbackLayout(scene) }).ok)
})

test('a carried prop is copied, never painted again, and holds up no shot', async () => {
  const nodes = buildGraph(await twoScenes())
  const copy = nodes.find(node => node.id === 'scene:s2:prop_key')
  assert.equal(copy.kind, 'copy')
  assert.deepEqual(copy.deps, ['scene:s1:prop_key'])
  assert.deepEqual(copy.outputs, ['scenes/s2/plate_prop_key.png'])
  assert.equal(nodes.find(node => node.id === 'scene:s2:frames').deps.includes(copy.id), false)
  assert.equal(nodes.filter(node => node.kind === 'image' && node.id.includes('prop_')).length, 1)
})

test('the graph has one set of steps per scene, and they never collide', async () => {
  const nodes = buildGraph(await twoScenes())
  const ids = nodes.map(node => node.id)
  assert.equal(new Set(ids).size, ids.length)
  const known = new Set(ids)
  for (const node of nodes) for (const dep of node.deps ?? []) assert.ok(known.has(dep), `${node.id} 依赖不存在的 ${dep}`)
  for (const sid of ['s1', 's2']) assert.ok(known.has(`scene:${sid}:a_closed`) && known.has(`scene:${sid}:clip:opening`) && known.has(`scene:${sid}:clip:ending`))
  const outputs = nodes.flatMap(node => node.outputs ?? [])
  assert.equal(new Set(outputs).size, outputs.length)
  assert.ok(generationTargets(nodes).includes('scene:s2:a_closed'))
})

test('a failure in one scene does not hold up the other, except for the film', async () => {
  const nodes = buildGraph(await twoScenes())
  const byId = new Map(nodes.map(node => [node.id, node]))
  const reach = new Set()
  const visit = id => { for (const dep of byId.get(id)?.deps ?? []) if (!reach.has(dep)) { reach.add(dep); visit(dep) } }
  visit('scene:s2:report')
  assert.deepEqual([...reach].filter(id => id.startsWith('scene:s1:')), [])
})

test('the film runs through every scene in story order and names the scene', async () => {
  const film = buildGraph(await twoScenes()).find(node => node.id === 'film')
  const titles = film.params.clips.map(clip => clip.title)
  const firstOfCellar = titles.indexOf('地窖 · 开场')
  assert.ok(firstOfCellar > 0)
  assert.ok(titles.slice(0, firstOfCellar).every(title => title.startsWith('后台 · ')))
  assert.ok(titles.slice(firstOfCellar).every(title => title.startsWith('地窖 · ')))
  assert.equal(titles.at(-1), '地窖 · 结尾')
  assert.ok(film.params.clips.every(clip => film.inputs.includes(clip.file)))
})

test('every interaction is filmed, whatever the model thought of it', async () => {
  const built = await twoScenes()
  const nodes = buildGraph(built)
  for (const scene of built.scenes) {
    for (const { id } of scene.beats) assert.ok(nodes.some(node => node.id === `scene:${scene.id}:clip:${id}`), `${scene.id} ${id} 没有镜头`)
    assert.ok(buildStage(scene).data.story.beats.every(entry => entry.clip), `${scene.id} 有一步进不了视频`)
  }
})

test('an interaction with nothing to film goes back to the model', async () => {
  const silent = sceneOf('后台', [beat('木箱', { action: '' })])
  const provider = scripted(JSON.stringify({ scenes: [silent] }), JSON.stringify({ scenes: [backstage] }))
  await breakdownScenes({ ...quiet, project, provider })
  assert.ok(provider.asked[1].includes('没写 action'))
})

test('four interactions in one room can all be filmed', async () => {
  const busy = sceneOf('书房', ['木箱', '书架', '长桌', '柜子'].map(name => beat(name)))
  const [scene] = await scenesFrom(busy)
  Object.assign(scene, fallbackLayout(scene))
  const { ok, issues, data } = buildStage(scene)
  assert.ok(ok, JSON.stringify(issues))
  assert.equal(data.story.beats.filter(entry => entry.clip).length, 5)
})

test('a project from before keeps its steps and gets them filmed, but the finished demo is left alone', () => {
  const old = { scenes: [{ beats: [{ objective: '看怀表', objectName: '书桌', performed: false, action: '' }] }] }
  const [upgraded] = everyInteractionFilmed(old).scenes[0].beats
  assert.equal(upgraded.performed, true)
  assert.ok(upgraded.action.includes('看怀表') && upgraded.action.includes('书桌'))
  const demo = { readonly: true, scenes: [{ beats: [{ objective: '看', objectName: '桌', performed: false }] }] }
  assert.equal(everyInteractionFilmed(demo).scenes[0].beats[0].performed, false)
})

test('the first thing picked up lies out on its object until its shot takes it', async () => {
  const pickup = sceneOf('书房', [beat('长桌', { gives: ['key'] }), beat('书架')], [key])
  const [scene] = await scenesFrom(pickup)
  Object.assign(scene, fallbackLayout(scene))
  const { data } = buildStage(scene)
  if (data.story.stageProp) assert.equal(data.story.stageProp.item, 'key')
  assert.equal(data.story.beats[0].clip, 'b1')
})

test('the production board shows sets and shots for every scene', async () => {
  const built = await twoScenes()
  const sections = new Set(cardsFor(built, buildGraph(built)).map(card => card.section))
  for (const name of ['布景 · 后台', '镜头 · 后台', '布景 · 地窖', '镜头 · 地窖']) assert.ok(sections.has(name), name)
})
