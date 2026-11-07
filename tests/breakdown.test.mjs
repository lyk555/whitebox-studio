import assert from 'node:assert/strict'
import test from 'node:test'
import { breakdownCast, breakdownScenes, buildLayout, fallbackLayout } from '../platform/breakdown.mjs'
import { FatalError } from '../platform/engine.mjs'
import { filmClips, platePrompts } from '../platform/prompts.mjs'
import { buildStage } from '../platform/stage.mjs'

const quiet = { log: () => {}, progress: () => {}, signal: new AbortController().signal }
// A model that gives these answers in turn, and remembers what it was asked.
const scripted = (...answers) => {
  const asked = []
  return { asked, text: async ({ user }) => { asked.push(user); return typeof answers[0] === 'string' && answers.length === 1 ? answers[0] : answers.shift() } }
}

const person = { name: '老周', role: 'protagonist', look: '花白短发', costume: '藏青夹克，黑胶鞋' }
const goodBeat = { objective: '翻箱子', object: '木箱', prompt: '按 E', too_early: '还早', during: '翻', after: '找到了', gives: 'key', takes: '', performed: true, action: '手翻开戏服', face: '', face_cast: [], settle: '', sound: '衣料声' }
const goodScene = {
  title: '后台', place: '灰墙水泥地。', mood: '柔和暖光', opening_line: '雨很大', ending_line: '门开了',
  props: [{ id: 'key', name: '钥匙', look: '铜的' }], beats: [goodBeat],
  exit: { name: '小门', beyond: '走廊', objective: '推门', prompt: '按 E', too_early: '还早', during: '吱呀', last_objective: '进去' },
  film: { opening: { action: '特写', sound: '雨' }, door: { action: '推门', sound: '吱呀' }, ending: { action: '走', face: '侧脸', sound: '脚步' } },
}

test('the cast always has exactly one person the player controls', async () => {
  const { cast } = await breakdownCast({ ...quiet, project: { story: '有个故事' }, provider: scripted(JSON.stringify({ title: 'T', style: 'S', cast: [{ ...person, role: 'supporting' }, { ...person, name: '小林', role: 'supporting' }] })) })
  assert.equal(cast.filter(member => member.playable).length, 1)
})

test('an answer that fails its check goes back with the reason, and the next one is used', async () => {
  const provider = scripted('不是 JSON', JSON.stringify({ title: 'T', style: 'S', cast: [person] }))
  const { cast } = await breakdownCast({ ...quiet, project: { story: '有个故事' }, provider })
  assert.equal(cast[0].name, '老周')
  assert.ok(provider.asked[1].includes('没有通过检查'))
})

test('an answer that never checks out is an error that says why', async () => {
  const provider = scripted(JSON.stringify({ cast: [] }))
  await assert.rejects(breakdownCast({ ...quiet, project: { story: '有个故事' }, provider }), error => error instanceof FatalError && error.message.includes('cast 是空的'))
})

test('a story with nothing in it is refused before any call', async () => {
  const provider = scripted('{}')
  await assert.rejects(breakdownCast({ ...quiet, project: { story: '  ' }, provider }), /还没有故事/)
  assert.equal(provider.asked.length, 0)
})

const project = { story: '故事', style: '旧剧院', scenes: [], cast: [{ id: 'c1', name: '老周', costume: '夹克', look: '短发', playable: true }, { id: 'c2', name: '小林', costume: '白裙', look: '长发' }] }

test('a prop used before it was given sends the answer back', async () => {
  const bad = { scenes: [{ ...goodScene, beats: [{ ...goodBeat, gives: '', takes: 'key' }] }] }
  const provider = scripted(JSON.stringify(bad), JSON.stringify({ scenes: [goodScene] }))
  const scenes = await breakdownScenes({ ...quiet, project, provider })
  assert.deepEqual(scenes[0].beats[0].gives, ['key'])
  assert.ok(provider.asked[1].includes('之前没有 beat 给过它'))
})

test('one beat can hand over several things, however the model wrote them', async () => {
  const two = { ...goodScene, props: [...goodScene.props, { id: 'ticket', name: '戏票', look: '旧的' }], beats: [{ ...goodBeat, gives: 'key,ticket' }, { ...goodBeat, object: '门边柜', takes: ['key'], gives: [] }] }
  const scenes = await breakdownScenes({ ...quiet, project, provider: scripted(JSON.stringify({ scenes: [two] })) })
  assert.deepEqual(scenes[0].beats[0].gives, ['key', 'ticket'])
  assert.deepEqual(scenes[0].beats[1].takes, ['key'])
  const { objects, beats } = fallbackLayout(scenes[0])
  const { issues, data } = buildStage({ ...scenes[0], objects, beats })
  assert.deepEqual(issues, [])
  assert.deepEqual(data.story.beats[0].gives, ['key', 'ticket'])
})

test('two beats on one object send the answer back', async () => {
  const bad = { scenes: [{ ...goodScene, beats: [goodBeat, { ...goodBeat, gives: '' }] }] }
  const provider = scripted(JSON.stringify(bad), JSON.stringify({ scenes: [goodScene] }))
  await breakdownScenes({ ...quiet, project, provider })
  assert.ok(provider.asked[1].includes('已经用过了'))
})

const parsedScene = async () => (await breakdownScenes({ ...quiet, project, provider: scripted(JSON.stringify({ scenes: [goodScene] })) }))[0]

test('a layout leaves out nothing a beat needs, and what it places can be played', async () => {
  const scene = await parsedScene()
  const answer = { objects: [{ name: '木箱', archetype: 'chest', x: 4.2, z: -1.5, look: '旧松木' }, { name: '台子', archetype: 'table', x: -1, z: 0.5, look: '旧桌' }, { name: '灯', archetype: 'lamp', on: '台子', look: '暖光' }, { name: '盒', archetype: 'box_small', on: '台子', look: '小盒' }] }
  const { objects, beats } = await buildLayout({ ...quiet, project, scene, provider: scripted(JSON.stringify(answer)) })
  const stage = buildStage({ ...scene, objects, beats })
  assert.deepEqual(stage.issues, [])
  const [lamp, little] = objects.filter(object => object.on)
  assert.notEqual(lamp.dx, little.dx, 'two things on one table do not land on one spot')
})

test('a layout finds the thing a step needs by the step, whatever the model called it', async () => {
  const scene = await parsedScene()
  const answer = { objects: [{ step: 1, name: '包铜角的旧道具箱', archetype: 'chest', x: 4.2, z: -1.5, look: '旧松木' }, { step: 0, name: '矮柜', archetype: 'cabinet', x: -3.9, z: 1, look: '旧柜' }] }
  const provider = scripted(JSON.stringify(answer))
  const { objects, beats } = await buildLayout({ ...quiet, project, scene, provider })
  assert.equal(provider.asked.length, 1)
  assert.equal(objects.find(object => object.id === beats[0].object).name, '木箱')
  assert.equal(objects.find(object => object.id === beats[0].object).archetype, 'chest')
})

test('a layout the model cannot get right falls back to one that can still be walked', async () => {
  const scene = await parsedScene()
  const { objects, beats } = await buildLayout({ ...quiet, project, scene, provider: scripted(JSON.stringify({ objects: [] })) })
  assert.deepEqual(buildStage({ ...scene, objects, beats }).issues, [])
})

test('the fallback guesses what kind of thing a name means', async () => {
  const scene = await parsedScene()
  assert.equal(fallbackLayout(scene).objects[0].archetype, 'chest')
})

test('a shot with a face is never pinned to frames, and comes with every face in it', async () => {
  const scene = await parsedScene()
  const withFace = { ...scene, beats: [{ ...scene.beats[0], face: '她抬头', faceCast: ['小林'] }] }
  const { objects, beats } = fallbackLayout(withFace)
  const placed = { ...withFace, objects, beats }
  const clips = filmClips(project, placed, buildStage(placed))
  const clip = clips.find(candidate => candidate.id === 'b1')
  const face = clip.parts.find(part => part.showsFace)
  assert.equal(face.landsOnEnd, undefined)
  assert.deepEqual(face.people.map(member => member.name), ['老周', '小林'])
  assert.ok(clip.parts.at(-1).landsOnEnd && !clip.parts.at(-1).showsFace, 'the last shot lands back on the game')
  assert.ok(clips.at(-1).parts.every(part => !part.landsOnEnd), 'the ending runs on to black')
})

test('prompts for a room with nothing to paint from the second camera ask for nothing', async () => {
  const scene = await parsedScene()
  const { objects, beats } = fallbackLayout(scene)
  const placed = { ...scene, objects, beats }
  const prompts = platePrompts(project, placed, buildStage(placed))
  assert.equal(prompts.b, null)
  assert.ok(prompts.a_closed.includes('木箱'))
  assert.ok(prompts.a_closed.includes('墙不能画成黑色'))
})
